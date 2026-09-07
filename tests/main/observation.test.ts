import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFromBuffer = vi.hoisted(() =>
  vi.fn((bytes?: Uint8Array) => ({
    isEmpty: () => !bytes || bytes.length < 8,
    getSize: () => ({
      width: bytes ? bytes[3] * 256 + bytes[4] : 0,
      height: bytes ? bytes[5] * 256 + bytes[6] : 0,
    }),
  })),
);

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  nativeImage: { createFromBuffer },
}));

import {
  CaptureService,
  type CaptureNativeSource,
  type CapturePlatform,
  type CaptureWorkerController,
} from "../../src/main/capture.js";
import { MediaService } from "../../src/main/media.js";
import { ObservationService } from "../../src/main/observation.js";
import type {
  CaptureEventV1,
  CaptureFrameV1,
  ClientResult,
  MediaAttachmentV1,
  TurnEventV1,
  TurnSubmitInput,
  TurnSubmitValue,
} from "../../src/shared/contracts.js";

type MutableClock = { value: number; now(): number };

beforeEach(() => createFromBuffer.mockClear());

describe("ObservationService", () => {
  it("publishes exact bounded status, configuration, frame facts, rates, and usage", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("8", input.sizeBytes),
      })),
    );
    const published: unknown[] = [];
    fixture.observation.setListener((status) => {
      published.push(status);
      return true;
    });
    expect(
      fixture.observation.configure({
        sessionId: " session-1 ",
        instruction: "Watch for e\u0301rrors",
        trigger: "changes",
      }),
    ).toMatchObject({
      ok: true,
      value: { sessionId: "session-1", state: "waiting", watchEnabled: true, trigger: "changes" },
    });
    expect(JSON.stringify(published)).not.toMatch(/Watch for|mediaId|credential|endpoint|secret/i);
    expect(
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "Watch for érrors",
        trigger: "changes",
      }),
    ).toMatchObject({ ok: true, value: { state: "waiting" } });
    expect(
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "bad\u0000instruction",
        trigger: "changes",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    fixture.emitFrame(1);

    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Inspect this view",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: {
        state: "selecting",
        selectedFrame: { reason: "user_send", sentAt: null, traceId: null },
        counters: { captureFrames: 2, selectedFrames: 1, uploadedBytes: fixture.bytes.length },
        rates: { capturedFrames: 2, inferencesStarted: 0 },
      },
    });
    fixture.observation.acceptTurnEvent(prepared.value, {
      schemaVersion: 1,
      kind: "started",
      requestId: "request-8",
      traceId: "trace-8",
      sessionId: "session-1",
    });
    expect(
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "Replace while active",
        trigger: "interval",
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_backpressure" } });
    fixture.observation.acceptTurnEvent(prepared.value, {
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-8",
      finalText: "done",
      errors: [],
      usage: availableUsage(11),
    });
    fixture.observation.acceptTurnEvent(prepared.value, {
      schemaVersion: 1,
      kind: "done",
      sessionId: "session-1",
      traceId: "trace-8",
      outcome: "complete",
    });
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: {
        state: "waiting",
        sentFrame: { traceId: "trace-8", reason: "user_send" },
        counters: {
          sentFrames: 1,
          inferencesStarted: 1,
          inferencesCompleted: 1,
        },
        rates: { capturedFrames: 2, inferencesStarted: 1 },
        usage: availableUsage(11),
      },
    });
    expect(await fixture.observation.stop()).toMatchObject({
      ok: true,
      value: { state: "ready", watchEnabled: false, trigger: null },
    });
  });

  it("uploads the exact selected frame and overwrites the leased copy", async () => {
    const uploaded: Buffer[] = [];
    const uploadMedia = vi.fn(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      uploaded.push(Buffer.concat(chunks));
      return { ok: true as const, value: attachment("a", input.sizeBytes) };
    });
    const fixture = await observationHarness(uploadMedia);
    let leasedCopy: Buffer | null = null;
    const originalUpload = fixture.media.uploadCapturedFrame.bind(fixture.media);
    vi.spyOn(fixture.media, "uploadCapturedFrame").mockImplementation((input) => {
      leasedCopy = input.bytes;
      return originalUpload(input);
    });

    const result = await fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { reason: "initial", frame: { frameId: fixture.frames[0].frameId } },
    });
    expect(uploaded).toEqual([fixture.bytes]);
    expect(leasedCopy).not.toBeNull();
    expect(leasedCopy!.every((value) => value === 0)).toBe(true);
    expect(fixture.capture.preview("frames", fixture.frames[0].frameId)?.bytes).toEqual(
      fixture.bytes,
    );
  });

  it("keeps only the newest descriptor while one upload is active", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const hashes: string[] = [];
    const uploadMedia = vi.fn(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      hashes.push(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
      if (hashes.length === 1) await firstHeld;
      return { ok: true as const, value: attachment(String(hashes.length), input.sizeBytes) };
    });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "1".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const first = fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    const second = fixture.emitFrame(1);
    const third = fixture.emitFrame(2);
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "change",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_backpressure" } });
    releaseFirst();
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_frame_mismatch" },
    });
    expect(releaseMedia).toHaveBeenCalledOnce();
    const latest = await fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "change",
      signal: new AbortController().signal,
    });
    expect(latest).toMatchObject({ ok: true, value: { frame: { frameId: third.frameId } } });
    expect(hashes).toEqual([fixture.frames[0].contentHash, third.contentHash]);
    expect(hashes).not.toContain(second.contentHash);
  });

  it("aborts and releases an upload that loses its selected-session generation", async () => {
    let releaseUpload!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadMedia = vi.fn(async (input) => {
      await held;
      return { ok: true as const, value: attachment("b", input.sizeBytes) };
    });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "b".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const upload = fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    const switched = fixture.observation.activateSession("session-2");
    expect(releaseMedia).not.toHaveBeenCalled();
    releaseUpload();
    await expect(upload).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_wrong_session" },
    });
    await switched;
    expect(releaseMedia).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "b".repeat(48),
    });
  });

  it("rejects wrong identity and expiry while allowing an explicit repeated frame", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("c", input.sizeBytes),
    }));
    const fixture = await observationHarness(uploadMedia);
    const real = fixture.frames[0];
    fixture.observation.acceptCaptureEvent({ ...real, contentHash: "d".repeat(64) });
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "initial",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_frame_mismatch" } });
    expect(uploadMedia).not.toHaveBeenCalled();

    fixture.observation.acceptCaptureEvent(real);
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "initial",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true });
    fixture.emitFrame(0);
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "user_send",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true });
    expect(uploadMedia).toHaveBeenCalledTimes(2);

    const expiring = fixture.emitFrame(3);
    fixture.clock.value += 30_001;
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "change",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_frame_unavailable" } });
    expect(fixture.capture.preview("frames", expiring.frameId)).toBeNull();
  });

  it("settles stop and close without leaking uploads and normalizes daemon loss", async () => {
    let releaseUpload!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadMedia = vi.fn(async (input) => {
      await held;
      return { ok: true as const, value: attachment("e", input.sizeBytes) };
    });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "e".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const upload = fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    const stopped = fixture.observation.stop();
    releaseUpload();
    await expect(upload).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_frame_unavailable" },
    });
    await stopped;
    expect(releaseMedia).toHaveBeenCalledOnce();
    await fixture.observation.close();
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "user_send",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_session_required" } });

    const unavailable = await observationHarness(
      vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "daemon_unavailable",
          message: "internal endpoint detail",
          retryable: true,
          retryAfterMs: 250,
        },
      }),
    );
    expect(
      await unavailable.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "initial",
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "The local OpenMinion daemon is not ready.",
        retryable: true,
        retryAfterMs: null,
      },
    });
  });

  it("releases uploads invalidated by capture pause or frame expiry", async () => {
    let releasePaused!: () => void;
    const pausedGate = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    const pausedUpload = vi.fn(async (input) => {
      await pausedGate;
      return { ok: true as const, value: attachment("d", input.sizeBytes) };
    });
    const pausedRelease = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "d".repeat(48), released: true },
    });
    const paused = await observationHarness(pausedUpload, pausedRelease);
    const upload = paused.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(pausedUpload).toHaveBeenCalledOnce());
    await paused.capture.pause();
    releasePaused();
    await expect(upload).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_frame_unavailable" },
    });
    expect(pausedRelease).toHaveBeenCalledOnce();

    let releaseExpired!: () => void;
    const expiredGate = new Promise<void>((resolve) => {
      releaseExpired = resolve;
    });
    const expiredUpload = vi.fn(async (input) => {
      await expiredGate;
      return { ok: true as const, value: attachment("e", input.sizeBytes) };
    });
    const expiredRelease = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "e".repeat(48), released: true },
    });
    const expired = await observationHarness(expiredUpload, expiredRelease);
    const expiring = expired.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(expiredUpload).toHaveBeenCalledOnce());
    expired.clock.value += 30_001;
    releaseExpired();
    await expect(expiring).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_frame_unavailable" },
    });
    expect(expiredRelease).toHaveBeenCalledOnce();
  });

  it("retains a failed stale-upload release until stop clears it", async () => {
    let releaseUpload!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadMedia = vi.fn(async (input) => {
      await held;
      return { ok: true as const, value: attachment("f", input.sizeBytes) };
    });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "internal endpoint detail",
        retryable: true,
        retryAfterMs: null,
      },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const controller = new AbortController();
    const upload = fixture.observation.uploadLatestFrame({
      sessionId: "session-1",
      reason: "initial",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    controller.abort();
    releaseUpload();
    await expect(upload).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_cleanup_failed" },
    });
    fixture.emitFrame(4);
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "user_send",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_cleanup_failed" } });
    expect(uploadMedia).toHaveBeenCalledOnce();

    releaseMedia.mockResolvedValue({
      ok: true,
      value: { mediaId: "f".repeat(48), released: true },
    });
    await fixture.observation.stop();
    fixture.emitFrame(5);
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "user_send",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
  });

  it("appends one observed media ID after at most three existing attachments", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("1", input.sizeBytes),
    }));
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "1".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const existing = ["a".repeat(48), "b".repeat(48), "c".repeat(48)];
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Inspect this view",
      attachmentIds: existing,
      observation: { includeCurrentView: true },
    });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        input: {
          sessionId: "session-1",
          message: "Inspect this view",
          attachmentIds: [...existing, "1".repeat(48)],
        },
      },
    });

    if (!prepared.ok) throw new Error(prepared.error.code);
    await fixture.observation.settleSubmission(prepared.value, {
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "The local OpenMinion daemon is not ready.",
        retryable: true,
        retryAfterMs: null,
      },
    });
    fixture.emitFrame(1);
    expect(
      await fixture.observation.prepareManualTurn({
        sessionId: "session-1",
        message: "Too many",
        attachmentIds: [...existing, "d".repeat(48)],
        observation: { includeCurrentView: true },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "observation_attachment_limit" },
    });
    expect(uploadMedia).toHaveBeenCalledOnce();
  });

  it("releases explicit pre-start failures but never reuses ambiguous media", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment(String(uploadMedia.mock.calls.length), input.sizeBytes),
    }));
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "1".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const first = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "first",
      observation: { includeCurrentView: true },
    });
    if (!first.ok) throw new Error(first.error.code);
    expect(
      await fixture.observation.settleSubmission(first.value, {
        ok: false,
        error: {
          code: "daemon_unavailable",
          message: "The local OpenMinion daemon is not ready.",
          retryable: true,
          retryAfterMs: null,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "daemon_unavailable" } });
    expect(releaseMedia).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "1".repeat(48),
    });

    fixture.emitFrame(1);
    const second = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "second",
      observation: { includeCurrentView: true },
    });
    if (!second.ok) throw new Error(second.error.code);
    expect(
      await fixture.observation.settleSubmission(second.value, {
        ok: false,
        error: {
          code: "submission_ambiguous",
          message: "Check session history before retrying",
          retryable: false,
          retryAfterMs: null,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "submission_ambiguous" } });
    expect(releaseMedia).toHaveBeenCalledOnce();
    expect(second.value.input.attachmentIds).toEqual(["2".repeat(48)]);
    fixture.emitFrame(2);
    expect(
      await fixture.observation.prepareManualTurn({
        sessionId: "session-1",
        message: "must not reuse",
        observation: { includeCurrentView: true },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "observation_backpressure" },
    });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
  });

  it("rechecks the exact frame after upload and releases before dispatch", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("4", input.sizeBytes),
    }));
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "4".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "race",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    await fixture.capture.pause();
    const ready = fixture.observation.validatePreparedTurn(prepared.value);
    expect(ready).toMatchObject({
      ok: false,
      error: { code: "observation_capture_inactive" },
    });
    if (ready.ok) throw new Error("frame remained dispatchable");
    expect(await fixture.observation.settleSubmission(prepared.value, ready)).toMatchObject({
      ok: false,
      error: { code: "observation_capture_inactive" },
    });
    expect(releaseMedia).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "4".repeat(48),
    });
  });

  it("settles but suppresses a retained observed turn after session selection changes", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("7", input.sizeBytes),
      })),
    );
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "old session",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "started",
        requestId: "request-7",
        traceId: "trace-7",
        sessionId: "session-1",
      }),
    ).toBe(true);
    await fixture.observation.settleSubmission(prepared.value, {
      ok: true,
      value: { requestId: "request-7", traceId: "trace-7", sessionId: "session-1" },
    });
    await fixture.observation.activateSession("session-2");
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "response",
        sessionId: "session-1",
        traceId: "trace-7",
        finalText: "late",
        errors: [],
        usage: availableUsage(12),
      }),
    ).toBe(false);
    expect(fixture.observation.usage()).toEqual(availableUsage(12));
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-7",
        outcome: "complete",
      }),
    ).toBe(false);
    expect(fixture.observation.usage()).toMatchObject({ usageAvailable: false });
  });

  it("keeps manual chat delivery after capture stop", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("d", input.sizeBytes),
      })),
    );
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Keep this user turn",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "started",
        requestId: "request-d",
        traceId: "trace-d",
        sessionId: "session-1",
      }),
    ).toBe(true);
    const stopping = fixture.observation.stop();
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "response",
        sessionId: "session-1",
        traceId: "trace-d",
        finalText: "Still delivered",
        errors: [],
        usage: availableUsage(4),
      }),
    ).toBe(true);
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-d",
        outcome: "complete",
      }),
    ).toBe(true);
    await expect(stopping).resolves.toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("keeps a late manual start stopping across a session fence", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("e", input.sizeBytes),
      })),
    );
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Late acceptance",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const switching = fixture.observation.activateSession("session-2");
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "started",
        requestId: "request-e",
        traceId: "trace-e",
        sessionId: "session-1",
      }),
    ).toBe(false);
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: { sessionId: "session-1", state: "stopping" },
    });
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-e",
        outcome: "complete",
      }),
    ).toBe(false);
    await switching;
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: { sessionId: "session-2", state: "ready" },
    });
  });

  it("suppresses manual delivery after the same session closes", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("f", input.sizeBytes),
      })),
    );
    const prepared = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Closing session",
      observation: { includeCurrentView: true },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "started",
        requestId: "request-f",
        traceId: "trace-f",
        sessionId: "session-1",
      }),
    ).toBe(true);
    const closing = fixture.observation.fenceSession("session-1");
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "response",
        sessionId: "session-1",
        traceId: "trace-f",
        finalText: "Do not deliver",
        errors: [],
        usage: availableUsage(5),
      }),
    ).toBe(false);
    expect(
      fixture.observation.acceptTurnEvent(prepared.value, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-f",
        outcome: "complete",
      }),
    ).toBe(false);
    await closing;
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: { sessionId: null, state: "idle" },
    });
  });

  it("keeps the old stopping snapshot until a pending session activates", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("9", input.sizeBytes),
      })),
    );
    let emit!: (event: TurnEventV1) => void;
    const cancel = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const delivered: TurnEventV1[] = [];
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        emit = sink;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: "request-9",
          traceId: "trace-9",
          sessionId: "session-1",
        });
        return {
          ok: true,
          value: { requestId: "request-9", traceId: "trace-9", sessionId: "session-1" },
        };
      },
      cancel,
    );
    enableWatch(fixture, "Observe");
    await fixture.observation.dispatchAutomaticTurn(
      {
        sessionId: "session-1",
        message: "Observe",
        reason: "initial",
      },
      (event) => {
        delivered.push(event);
        return true;
      },
    );

    const switching = fixture.observation.activateSession("session-2");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: {
        sessionId: "session-1",
        state: "stopping",
        sentFrame: { traceId: "trace-9" },
      },
    });
    emit({
      schemaVersion: 1,
      kind: "done",
      sessionId: "session-1",
      traceId: "trace-9",
      outcome: "cancelled",
    });
    await switching;
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: {
        sessionId: "session-2",
        state: "ready",
        lastError: null,
        selectedFrame: null,
        sentFrame: null,
      },
    });
    expect(delivered.map((event) => event.kind)).toEqual(["started"]);
  });

  it("cancels an accepted automatic turn once and retains it until done", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("3", input.sizeBytes),
    }));
    const fixture = await observationHarness(uploadMedia);
    let emit!: (event: TurnEventV1) => void;
    const cancel = vi.fn().mockResolvedValue({ ok: true, value: {} });
    connectTurnOwner(
      fixture.observation,
      async (input, sink) => {
        emit = sink;
        expect(input.attachmentIds).toEqual(["3".repeat(48)]);
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: "request-1",
          traceId: "trace-1",
          sessionId: "session-1",
        });
        return {
          ok: true,
          value: { requestId: "request-1", traceId: "trace-1", sessionId: "session-1" },
        };
      },
      cancel,
    );
    enableWatch(fixture, "Describe changes");
    const submitted = await fixture.observation.dispatchAutomaticTurn(
      {
        sessionId: "session-1",
        message: "Describe changes",
        reason: "initial",
      },
      () => true,
    );
    expect(submitted).toMatchObject({ ok: true });
    expect(fixture.observation.usage()).toMatchObject({ usageAvailable: false });
    emit({
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "wrong-trace",
      finalText: "stale",
      errors: [],
      usage: availableUsage(99),
    });
    expect(fixture.observation.usage()).toMatchObject({ usageAvailable: false });
    emit({
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-1",
      finalText: "done",
      errors: [],
      usage: availableUsage(7),
    });
    expect(fixture.observation.usage()).toEqual(availableUsage(7));
    const stopping = fixture.observation.fenceSession("session-1");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1", traceId: "trace-1" });
    emit({
      schemaVersion: 1,
      kind: "done",
      sessionId: "session-1",
      traceId: "trace-1",
      outcome: "cancelled",
    });
    await stopping;
    await fixture.observation.stop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      await fixture.observation.uploadLatestFrame({
        sessionId: "session-1",
        reason: "user_send",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "observation_session_required" },
    });
  });

  it("aborts automatic upload admission before a same-session manual turn", async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadMedia = vi.fn(async (input) => {
      await uploadGate;
      return { ok: true as const, value: attachment("6", input.sizeBytes) };
    });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "6".repeat(48), released: true },
    });
    const fixture = await observationHarness(uploadMedia, releaseMedia);
    const submit = vi.fn();
    connectTurnOwner(fixture.observation, submit, vi.fn());
    enableWatch(fixture, "Observe");
    const automatic = fixture.observation.dispatchAutomaticTurn(
      {
        sessionId: "session-1",
        message: "Observe",
        reason: "initial",
      },
      () => true,
    );
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    const preempted = fixture.observation.preemptAutomaticForManual("session-1", true);
    releaseUpload();
    await expect(preempted).resolves.toBe(true);
    await expect(automatic).resolves.toMatchObject({
      ok: false,
      error: { code: "observation_frame_unavailable" },
    });
    expect(releaseMedia).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "6".repeat(48),
    });
    expect(submit).not.toHaveBeenCalled();
    const manual = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Manual wins",
      observation: { includeCurrentView: true },
    });
    expect(manual).toMatchObject({ ok: true });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    if (!manual.ok) throw new Error(manual.error.code);
    await fixture.observation.settleSubmission(manual.value, {
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "The local OpenMinion daemon is not ready.",
        retryable: true,
        retryAfterMs: null,
      },
    });
  });

  it("plants manual preemption before a late automatic start", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("5", input.sizeBytes),
    }));
    const fixture = await observationHarness(uploadMedia);
    let emit!: (event: TurnEventV1) => void;
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const cancel = vi.fn().mockResolvedValue({ ok: true, value: {} });
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        emit = sink;
        await submitGate;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: "request-2",
          traceId: "trace-2",
          sessionId: "session-1",
        });
        return {
          ok: true,
          value: { requestId: "request-2", traceId: "trace-2", sessionId: "session-1" },
        };
      },
      cancel,
    );
    enableWatch(fixture, "Observe");
    const running = fixture.observation.dispatchAutomaticTurn(
      {
        sessionId: "session-1",
        message: "Observe",
        reason: "change",
      },
      () => true,
    );
    await vi.waitFor(() => expect(typeof emit).toBe("function"));
    const preempted = fixture.observation.preemptAutomaticForManual("session-1", true);
    releaseSubmit();
    await vi.waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        sessionId: "session-1",
        traceId: "trace-2",
      }),
    );
    emit({
      schemaVersion: 1,
      kind: "done",
      sessionId: "session-1",
      traceId: "trace-2",
      outcome: "cancelled",
    });
    await expect(preempted).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
    const manual = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Manual reuses the current view",
      observation: { includeCurrentView: true },
    });
    expect(manual).toMatchObject({ ok: true });
    if (!manual.ok) throw new Error(manual.error.code);
    await fixture.observation.settleSubmission(manual.value, {
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "The local OpenMinion daemon is not ready.",
        retryable: true,
        retryAfterMs: null,
      },
    });
  });

  it("retries a same-hash automatic frame after pre-start turn backpressure", async () => {
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "b".repeat(48), released: true },
    });
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("b", input.sizeBytes),
      })),
      releaseMedia,
    );
    let attempts = 0;
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            error: {
              code: "session_turn_active",
              message: "A turn is already active for this session.",
              retryable: true,
              retryAfterMs: 1000,
            },
          };
        }
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: "request-backpressure-2",
          traceId: "trace-backpressure-2",
          sessionId: "session-1",
        });
        sink({
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId: "trace-backpressure-2",
          outcome: "complete",
        });
        return {
          ok: true,
          value: {
            requestId: "request-backpressure-2",
            traceId: "trace-backpressure-2",
            sessionId: "session-1",
          },
        };
      },
      vi.fn(),
    );
    fixture.observation.configure({
      sessionId: "session-1",
      instruction: "Retry after the manual turn",
      trigger: "changes",
    });
    fixture.emitFrame(1);
    await vi.waitFor(() => expect(attempts).toBe(1));
    fixture.emitFrame(1);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(releaseMedia).toHaveBeenCalledOnce();
  });

  it("runs initial and cadence-bounded latest change, then prioritizes post action", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment(String(uploadMedia.mock.calls.length), input.sizeBytes),
    }));
    const fixture = await observationHarness(uploadMedia);
    const selected: Array<{ reason: string; contentHash: string }> = [];
    let serial = 0;
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        serial += 1;
        const status = fixture.observation.status();
        if (!status.ok || !status.value.selectedFrame) throw new Error("frame was not selected");
        selected.push({
          reason: status.value.selectedFrame.reason,
          contentHash: status.value.selectedFrame.contentHash,
        });
        const traceId = `trace-policy-${serial}`;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: `request-policy-${serial}`,
          traceId,
          sessionId: "session-1",
        });
        sink({
          schemaVersion: 1,
          kind: "response",
          sessionId: "session-1",
          traceId,
          finalText: "observed",
          errors: [],
          usage: availableUsage(serial),
        });
        sink({
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId,
          outcome: "complete",
        });
        return {
          ok: true,
          value: { requestId: `request-policy-${serial}`, traceId, sessionId: "session-1" },
        };
      },
      vi.fn(),
    );
    fixture.observation.configure({
      sessionId: "session-1",
      instruction: "Describe visible changes",
      trigger: "changes",
    });

    const initial = fixture.emitFrame(1);
    await vi.waitFor(() => expect(selected).toHaveLength(1));
    expect(selected[0]).toEqual({ reason: "initial", contentHash: initial.contentHash });
    fixture.emitFrame(1);
    await vi.waitFor(() =>
      expect(fixture.observation.status()).toMatchObject({
        ok: true,
        value: { counters: { skippedUnchanged: 1 } },
      }),
    );
    expect(selected).toHaveLength(1);

    fixture.emitFrame(2);
    fixture.emitFrame(3);
    const latest = fixture.emitFrame(4);
    await vi.waitFor(() => expect(selected).toHaveLength(2));
    expect(selected[1]).toEqual({ reason: "change", contentHash: latest.contentHash });
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: { counters: { replacedPending: 3 } },
    });

    const afterAction = fixture.emitFrame(5);
    fixture.observation.acceptPolicySignal("post_action");
    await vi.waitFor(() => expect(selected).toHaveLength(3));
    expect(selected[2]).toEqual({ reason: "post_action", contentHash: afterAction.contentHash });

    fixture.emitFrame(5);
    fixture.observation.acceptPolicySignal("post_action");
    await vi.waitFor(() =>
      expect(fixture.observation.status()).toMatchObject({
        ok: true,
        value: { counters: { skippedUnchanged: 2 } },
      }),
    );
    await expect(fixture.observation.preemptAutomaticForManual("session-1", true)).resolves.toBe(
      true,
    );
    const explicit = await fixture.observation.prepareManualTurn({
      sessionId: "session-1",
      message: "Use the current unchanged view",
      observation: { includeCurrentView: true },
    });
    expect(explicit).toMatchObject({ ok: true });
    if (!explicit.ok) throw new Error(explicit.error.code);
    await fixture.observation.settleSubmission(explicit.value, {
      ok: false,
      error: {
        code: "daemon_unavailable",
        message: "The local OpenMinion daemon is not ready.",
        retryable: true,
        retryAfterMs: null,
      },
    });
  });

  it("checks interval watch only on the 30-second tick with a newer hash", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("i", input.sizeBytes),
      })),
    );
    const reasons: string[] = [];
    let serial = 0;
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        serial += 1;
        const status = fixture.observation.status();
        if (!status.ok || !status.value.selectedFrame) throw new Error("frame was not selected");
        reasons.push(status.value.selectedFrame.reason);
        const traceId = `trace-interval-${serial}`;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: `request-interval-${serial}`,
          traceId,
          sessionId: "session-1",
        });
        sink({
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId,
          outcome: "complete",
        });
        return {
          ok: true,
          value: { requestId: `request-interval-${serial}`, traceId, sessionId: "session-1" },
        };
      },
      vi.fn(),
    );
    vi.useFakeTimers();
    try {
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "Check on schedule",
        trigger: "interval",
      });
      fixture.emitFrame(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(reasons).toEqual(["initial"]);

      fixture.clock.value += 29_999;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(reasons).toEqual(["initial"]);
      fixture.emitFrame(2);
      fixture.clock.value += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(reasons).toEqual(["initial", "watch"]);

      fixture.clock.value += 29_999;
      await vi.advanceTimersByTimeAsync(29_999);
      fixture.emitFrame(2);
      fixture.clock.value += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(reasons).toEqual(["initial", "watch"]);
      expect(fixture.observation.status()).toMatchObject({
        ok: true,
        value: { counters: { skippedUnchanged: 1 } },
      });
    } finally {
      await fixture.observation.stop();
      vi.useRealTimers();
    }
  });

  it("does not dispatch stale change or interval timers after reconfigure and stop", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("q", input.sizeBytes),
      })),
    );
    const reasons: string[] = [];
    let serial = 0;
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        serial += 1;
        const status = fixture.observation.status();
        if (!status.ok || !status.value.selectedFrame) throw new Error("frame was not selected");
        reasons.push(status.value.selectedFrame.reason);
        const traceId = `trace-stale-timer-${serial}`;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: `request-stale-timer-${serial}`,
          traceId,
          sessionId: "session-1",
        });
        sink({
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId,
          outcome: "complete",
        });
        return {
          ok: true,
          value: {
            requestId: `request-stale-timer-${serial}`,
            traceId,
            sessionId: "session-1",
          },
        };
      },
      vi.fn(),
    );
    vi.useFakeTimers();
    try {
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "Observe changes",
        trigger: "changes",
      });
      fixture.emitFrame(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(reasons).toEqual(["initial"]);
      fixture.emitFrame(2);
      fixture.observation.configure({
        sessionId: "session-1",
        instruction: "Observe on schedule",
        trigger: "interval",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reasons).toEqual(["initial"]);

      fixture.emitFrame(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(reasons).toEqual(["initial", "initial"]);
      await fixture.observation.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reasons).toEqual(["initial", "initial"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops automatic work during a same-session manual turn", async () => {
    const uploadMedia = vi.fn(async (input) => ({
      ok: true as const,
      value: attachment("m", input.sizeBytes),
    }));
    const fixture = await observationHarness(uploadMedia);
    let serial = 0;
    const published: unknown[] = [];
    fixture.observation.setListener(
      (status) => {
        published.push(status);
        return true;
      },
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        serial += 1;
        const traceId = `trace-manual-${serial}`;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: `request-manual-${serial}`,
          traceId,
          sessionId: "session-1",
        });
        sink({
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId,
          outcome: "complete",
        });
        return {
          ok: true,
          value: { requestId: `request-manual-${serial}`, traceId, sessionId: "session-1" },
        };
      },
      vi.fn(),
    );
    fixture.observation.configure({
      sessionId: "session-1",
      instruction: "Observe while chatting",
      trigger: "changes",
    });
    const admission = fixture.observation.beginManualTurn("session-1");
    expect(admission.admitted).toBe(true);
    expect(fixture.observation.beginManualTurn("session-1")).toEqual({
      admitted: false,
      token: null,
    });
    fixture.emitFrame(1);
    await vi.waitFor(() =>
      expect(fixture.observation.status()).toMatchObject({
        ok: true,
        value: { counters: { skippedBusy: 1 }, state: "waiting" },
      }),
    );
    expect(uploadMedia).not.toHaveBeenCalled();
    fixture.observation.endManualTurn(admission.token);
    fixture.emitFrame(2);
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    expect(published).not.toContainEqual(
      expect.objectContaining({
        state: "uploading",
        lastError: expect.anything(),
      }),
    );
  });

  it("tracks ordinary manual turns independently across selected sessions", async () => {
    const fixture = await observationHarness(vi.fn());
    const sessionOne = fixture.observation.beginManualTurn("session-1");
    expect(sessionOne.admitted).toBe(true);
    await fixture.observation.activateSession("session-2");
    const sessionTwo = fixture.observation.beginManualTurn("session-2");
    expect(sessionTwo.admitted).toBe(true);

    await fixture.observation.activateSession("session-1");
    expect(fixture.observation.beginManualTurn("session-1")).toEqual({
      admitted: false,
      token: null,
    });
    fixture.observation.endManualTurn(sessionOne.token);
    const reopened = fixture.observation.beginManualTurn("session-1");
    expect(reopened.admitted).toBe(true);
    fixture.observation.endManualTurn(reopened.token);
    fixture.observation.endManualTurn(sessionTwo.token);
  });

  it("releases automatic media when the shared turn owner throws", async () => {
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "t".repeat(48), released: true },
    });
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment("t", input.sizeBytes),
      })),
      releaseMedia,
    );
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      vi.fn(async () => {
        throw new Error("transport owner failed");
      }),
      vi.fn(),
    );
    fixture.observation.configure({
      sessionId: "session-1",
      instruction: "Fail safely",
      trigger: "changes",
    });
    fixture.emitFrame(1);
    await vi.waitFor(() =>
      expect(fixture.observation.status()).toMatchObject({
        ok: true,
        value: {
          state: "failed",
          watchEnabled: false,
          lastError: { code: "daemon_unavailable" },
        },
      }),
    );
    expect(releaseMedia).toHaveBeenCalledOnce();
  });

  it("retains only the latest eligible frame while automatic inference is active", async () => {
    const fixture = await observationHarness(
      vi.fn(async (input) => ({
        ok: true as const,
        value: attachment(String(input.sizeBytes), input.sizeBytes),
      })),
    );
    const selectedHashes: string[] = [];
    let firstDone!: () => void;
    let serial = 0;
    fixture.observation.setListener(
      () => true,
      () => true,
    );
    connectTurnOwner(
      fixture.observation,
      async (_input, sink) => {
        serial += 1;
        const status = fixture.observation.status();
        if (!status.ok || !status.value.selectedFrame) throw new Error("frame was not selected");
        selectedHashes.push(status.value.selectedFrame.contentHash);
        const traceId = `trace-latest-${serial}`;
        sink({
          schemaVersion: 1,
          kind: "started",
          requestId: `request-latest-${serial}`,
          traceId,
          sessionId: "session-1",
        });
        if (serial === 1) {
          firstDone = () =>
            sink({
              schemaVersion: 1,
              kind: "done",
              sessionId: "session-1",
              traceId,
              outcome: "complete",
            });
        } else {
          sink({
            schemaVersion: 1,
            kind: "done",
            sessionId: "session-1",
            traceId,
            outcome: "complete",
          });
        }
        return {
          ok: true,
          value: { requestId: `request-latest-${serial}`, traceId, sessionId: "session-1" },
        };
      },
      vi.fn(),
    );
    fixture.observation.configure({
      sessionId: "session-1",
      instruction: "Use only the latest frame",
      trigger: "changes",
    });
    fixture.emitFrame(1);
    await vi.waitFor(() => expect(selectedHashes).toHaveLength(1));
    fixture.emitFrame(2);
    fixture.emitFrame(3);
    const latest = fixture.emitFrame(4);
    firstDone();
    await vi.waitFor(() => expect(selectedHashes).toHaveLength(2));
    expect(selectedHashes[1]).toBe(latest.contentHash);
    expect(fixture.observation.status()).toMatchObject({
      ok: true,
      value: { counters: { replacedPending: 2, inferencesStarted: 2 } },
    });
  });
});

function connectTurnOwner(
  observation: ObservationService,
  submit: (
    input: TurnSubmitInput,
    emit: (event: TurnEventV1) => void,
  ) => Promise<ClientResult<TurnSubmitValue>>,
  cancel: (input: { sessionId: string; traceId: string }) => Promise<ClientResult<unknown>>,
): void {
  observation.connectTurnOwner({
    async dispatch(prepared, deliver) {
      const result = await submit(prepared.input, (event) => {
        if (observation.acceptTurnEvent(prepared, event)) deliver(event);
      });
      return observation.settleSubmission(prepared, result);
    },
    cancel,
  });
}

function availableUsage(inputTokens: number) {
  return {
    usageAvailable: true,
    inputTokens,
    outputTokens: 3,
    totalTokens: inputTokens + 3,
    llmCalls: 1,
    durationMs: 20,
    costUsd: null,
    costSource: "unavailable" as const,
  };
}

function enableWatch(
  fixture: Awaited<ReturnType<typeof observationHarness>>,
  instruction: string,
): void {
  const configured = fixture.observation.configure({
    sessionId: "session-1",
    instruction,
    trigger: "changes",
  });
  if (!configured.ok) throw new Error(configured.error.code);
  fixture.emitFrame(fixture.frames.length + 1);
}

async function observationHarness(
  uploadMedia: ReturnType<typeof vi.fn>,
  releaseMedia: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const clock: MutableClock = {
    value: Date.now(),
    now() {
      return this.value;
    },
  };
  let emitWorker: ((event: unknown) => void) | null = null;
  let identity: { captureId: string; generation: number } | null = null;
  const platform: CapturePlatform = {
    platform: "darwin",
    permission: () => "granted",
    async sources() {
      return [source()];
    },
    async createWorker(input, emit) {
      identity = input;
      emitWorker = emit;
      queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
      return worker(input, emit);
    },
  };
  const capture = new CaptureService(platform, clock);
  const media = new MediaService({ uploadMedia, releaseMedia } as never);
  const observation = new ObservationService(capture, media, () => clock.value);
  const frames: CaptureFrameV1[] = [];
  await observation.activateSession("session-1");
  await capture.activateSession("session-1");
  const listed = await capture.sources({ sessionId: "session-1", sourceKind: "display" });
  if (!listed.ok) throw new Error(listed.error.code);
  const started = await capture.start(
    {
      sessionId: "session-1",
      candidateId: listed.value.candidates[0].candidateId,
      region: null,
    },
    (event: CaptureEventV1) => {
      observation.acceptCaptureEvent(event);
      if (event.kind === "frame") frames.push(event);
    },
  );
  if (!started.ok || !identity || !emitWorker) throw new Error("capture did not start");
  const bytes = jpeg(800, 600, 0);
  return {
    capture,
    media,
    observation,
    clock,
    frames,
    bytes,
    emitFrame(seed: number): CaptureFrameV1 {
      clock.value += 2000;
      emitWorker!({
        schemaVersion: 1,
        kind: "frame",
        captureId: identity!.captureId,
        generation: identity!.generation,
        sourceWidth: 800,
        sourceHeight: 600,
        width: 800,
        height: 600,
        bytes: new Uint8Array(jpeg(800, 600, seed)),
      });
      const frame = frames.at(-1);
      if (!frame) throw new Error("frame was not emitted");
      return frame;
    },
  };
}

function source(): CaptureNativeSource {
  return {
    nativeId: "screen:1",
    label: "Display 1",
    thumbnail: image(800, 600) as never,
    scaleFactor: 2,
  };
}

function image(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }: { width: number; height: number }) =>
      image(nextWidth, nextHeight),
    toJPEG: () => jpeg(width, height, 0),
  };
}

function worker(
  input: { captureId: string; generation: number },
  emit: (event: unknown) => void,
): CaptureWorkerController {
  return {
    configure(config) {
      emit({
        schemaVersion: 1,
        kind: "configured",
        captureId: config.captureId,
        generation: config.generation,
      });
    },
    async startWithGesture() {
      emit({
        schemaVersion: 1,
        kind: "stream_ready",
        captureId: input.captureId,
        generation: input.generation,
        sourceWidth: 800,
        sourceHeight: 600,
      });
      emit({
        schemaVersion: 1,
        kind: "frame",
        captureId: input.captureId,
        generation: input.generation,
        sourceWidth: 800,
        sourceHeight: 600,
        width: 800,
        height: 600,
        bytes: new Uint8Array(jpeg(800, 600, 0)),
      });
      return true;
    },
    async waitForAdmission() {},
    async stop() {},
  };
}

function jpeg(width: number, height: number, seed: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    seed,
    0xff,
    0xd9,
  ]);
}

function attachment(seed: string, sizeBytes: number): MediaAttachmentV1 {
  return {
    schemaVersion: 1,
    mediaId: seed.repeat(48).slice(0, 48),
    sessionId: "session-1",
    name: "observed-frame.jpg",
    mimeType: "image/jpeg",
    sizeBytes,
    kind: "image",
    turnCompatible: true,
    expiresAt: "2999-01-01T00:00:00Z",
  };
}
