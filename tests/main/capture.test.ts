import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFromBuffer = vi.hoisted(() =>
  vi.fn((bytes?: Uint8Array) => ({
    isEmpty: () => !bytes || bytes.length < 8,
    getSize: () => ({
      width: bytes ? bytes[2] * 256 + bytes[3] : 0,
      height: bytes ? bytes[4] * 256 + bytes[5] : 0,
    }),
  })),
);

vi.mock("electron", () => ({ nativeImage: { createFromBuffer } }));

import {
  CaptureService,
  type CaptureNativeSource,
  type CapturePlatform,
  type CaptureWorkerController,
} from "../../src/main/capture.js";
import type { CaptureWorkerEventV1 } from "../../src/shared/capture-worker.js";
import type { CaptureFrameV1 } from "../../src/shared/contracts.js";

type MutableClock = { value: number; now(): number };

function image(width: number, height: number) {
  return {
    isEmpty: () => width <= 0 || height <= 0,
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }: { width: number; height: number }) =>
      image(nextWidth, nextHeight),
    toJPEG: () => jpeg(width, height),
  };
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0xff,
    0xd9,
  ]);
}

function source(
  nativeId = "screen:77:9",
  label = "Editor /Users/person/private/file.txt",
  width = 800,
  height = 600,
): CaptureNativeSource {
  return {
    nativeId,
    label,
    thumbnail: image(width, height) as never,
    scaleFactor: 2,
  };
}

function observingWorker(
  input: { captureId: string; generation: number },
  emit: (event: unknown) => void,
  stop: () => Promise<void> = async () => {},
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
        bytes: new Uint8Array(jpeg(800, 600)),
      });
      return true;
    },
    async waitForAdmission() {},
    stop,
  };
}

function harness(
  options: {
    sources?: CaptureNativeSource[];
    permission?: CapturePlatform["permission"];
    worker?: (
      input: { captureId: string; generation: number; nativeSourceId: string },
      emit: (event: unknown) => void,
    ) => Promise<CaptureWorkerController>;
  } = {},
) {
  const clock: MutableClock = {
    value: 1_700_000_000_000,
    now() {
      return this.value;
    },
  };
  const nativeSources = options.sources ?? [source()];
  const calls: string[] = [];
  let emitWorker: ((event: unknown) => void) | null = null;
  let workerIdentity: { captureId: string; generation: number } | null = null;
  const platform: CapturePlatform = {
    platform: "darwin",
    permission: options.permission ?? (() => "granted"),
    async sources(_kind, thumbnail) {
      calls.push(thumbnail ? "sources:thumbnail" : "sources:identity");
      return nativeSources;
    },
    async createWorker(input, emit) {
      emitWorker = emit;
      workerIdentity = input;
      if (options.worker) return options.worker(input, emit);
      const controller: CaptureWorkerController = {
        configure(config) {
          calls.push("configure");
          emit({
            schemaVersion: 1,
            kind: "configured",
            captureId: config.captureId,
            generation: config.generation,
          });
        },
        async startWithGesture() {
          calls.push("gesture");
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
            bytes: new Uint8Array(jpeg(800, 600)),
          });
          return true;
        },
        async waitForAdmission() {},
        async stop() {
          calls.push("stop");
          emit({
            schemaVersion: 1,
            kind: "ended",
            captureId: input.captureId,
            generation: input.generation,
            reason: "track_ended",
          });
        },
      };
      queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
      return controller;
    },
  };
  const service = new CaptureService(platform, clock);
  return {
    service,
    platform,
    clock,
    calls,
    emit(event: CaptureWorkerEventV1) {
      emitWorker?.(event);
    },
    identity() {
      if (!workerIdentity) throw new Error("worker was not created");
      return workerIdentity;
    },
  };
}

async function candidates(service: CaptureService) {
  await service.activateSession("session-1");
  const result = await service.sources({ sessionId: "session-1", sourceKind: "display" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

beforeEach(() => createFromBuffer.mockClear());

describe("capture main owner", () => {
  it("publishes opaque bounded candidates and keeps native identity private", async () => {
    const { service } = harness();
    const value = await candidates(service);
    expect(value.permission).toBe("granted");
    expect(value.candidates).toHaveLength(1);
    const candidate = value.candidates[0];
    expect(candidate.candidateId).toMatch(/^[0-9a-f]{48}$/);
    expect(candidate.previewUrl).toBe(
      `openminion://app/capture/candidates/${candidate.candidateId}`,
    );
    expect(candidate.label).not.toContain("/Users/person/private");
    expect(JSON.stringify(value)).not.toContain("screen:77:9");
    expect(service.preview("candidates", candidate.candidateId)?.bytes).toEqual(jpeg(360, 270));
  });

  it("redacts punctuation-delimited and space-containing paths from public labels", async () => {
    const labels = [
      "Editor (/Users/person/My Project/private.txt)",
      "Editor C:\\Users\\person\\Private Project\\file.txt",
      "Editor \\\\server\\share\\Private Project\\file.txt",
      "Editor file:///Users/person/My%20Project/private.txt",
    ];
    const { service } = harness({
      sources: labels.map((label, index) => source(`screen:${index}`, label)),
    });
    const value = await candidates(service);
    expect(value.candidates).toHaveLength(labels.length);
    for (const candidate of value.candidates) {
      expect(candidate.label).toContain("[path]");
      expect(candidate.label).not.toMatch(/Users|person|Private|server|share|%20Project/u);
    }
  });

  it("overwrites candidate JPEG bytes when decode validation throws", async () => {
    const encoded = jpeg(360, 270);
    const thumbnail = image(800, 600) as ReturnType<typeof image>;
    thumbnail.resize = () => ({
      ...image(360, 270),
      toJPEG: () => encoded,
    });
    createFromBuffer.mockImplementationOnce(() => {
      throw new Error("decode failed");
    });
    const { service } = harness({
      sources: [{ ...source(), thumbnail: thumbnail as never }],
    });
    const value = await candidates(service);
    expect(value.candidates).toEqual([]);
    expect(encoded.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects wrong sessions and malformed inputs before enumeration", async () => {
    const { service, calls } = harness();
    expect((await service.sources({ sessionId: "session-1", sourceKind: "display" })).ok).toBe(
      false,
    );
    await service.activateSession("session-1");
    const wrong = await service.sources({ sessionId: "session-2", sourceKind: "display" });
    const extra = await service.sources({
      sessionId: "session-1",
      sourceKind: "display",
      nativeId: "screen:77:9",
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: "capture_wrong_session" } });
    expect(extra).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toEqual([]);
  });

  it("orders worker configuration before gesture and retains only frame previews", async () => {
    const { service, calls } = harness();
    const listed = await candidates(service);
    const events: unknown[] = [];
    const started = await service.start(
      {
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      },
      (event) => events.push(event),
    );
    expect(started).toMatchObject({ ok: true, value: { state: "observing", capturedFrames: 1 } });
    expect(calls).toEqual(["sources:thumbnail", "sources:identity", "configure", "gesture"]);
    expect(service.preview("candidates", listed.candidates[0].candidateId)).toBeNull();
    const frame = events.find(
      (event) => (event as { kind?: string }).kind === "frame",
    ) as CaptureFrameV1;
    const bytes = jpeg(800, 600);
    expect(frame.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(frame.previewUrl).toBe(`openminion://app/capture/frames/${frame.frameId}`);
    expect(service.preview("frames", frame.frameId)?.bytes).toEqual(bytes);
    const lease = service.acquireFrameForObservation({
      sessionId: frame.sessionId,
      captureId: frame.captureId,
      frameId: frame.frameId,
      contentHash: frame.contentHash,
    });
    expect(lease?.frame).toEqual(frame);
    expect(lease?.bytes).toEqual(bytes);
    lease?.bytes.fill(1);
    expect(service.preview("frames", frame.frameId)?.bytes).toEqual(bytes);
    expect(JSON.stringify(events)).not.toContain("screen:77:9");
  });

  it("leases only the exact unexpired observing frame", async () => {
    const { service, clock } = harness();
    const listed = await candidates(service);
    const events: CaptureFrameV1[] = [];
    const started = await service.start(
      {
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      },
      (event) => {
        if (event.kind === "frame") events.push(event);
      },
    );
    expect(started.ok).toBe(true);
    const frame = events[0] as CaptureFrameV1;
    const exact = {
      sessionId: frame.sessionId,
      captureId: frame.captureId,
      frameId: frame.frameId,
      contentHash: frame.contentHash,
    };
    expect(service.acquireFrameForObservation({ ...exact, sessionId: "session-2" })).toBeNull();
    expect(service.acquireFrameForObservation({ ...exact, captureId: "a".repeat(48) })).toBeNull();
    expect(service.acquireFrameForObservation({ ...exact, frameId: "b".repeat(48) })).toBeNull();
    expect(
      service.acquireFrameForObservation({ ...exact, contentHash: "c".repeat(64) }),
    ).toBeNull();
    expect(service.acquireFrameForObservation({ ...exact, extra: true } as never)).toBeNull();
    clock.value += 30_001;
    expect(service.acquireFrameForObservation(exact)).toBeNull();
    expect(service.preview("frames", frame.frameId)).toBeNull();
  });

  it("invalidates frame leases when capture is paused or stopped", async () => {
    const { service } = harness();
    const listed = await candidates(service);
    const frames: CaptureFrameV1[] = [];
    await service.start(
      {
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      },
      (event) => {
        if (event.kind === "frame") frames.push(event);
      },
    );
    const frame = frames[0];
    if (!frame) throw new Error("frame was not emitted");
    const input = {
      sessionId: frame.sessionId,
      captureId: frame.captureId,
      frameId: frame.frameId,
      contentHash: frame.contentHash,
    };
    expect(service.acquireFrameForObservation(input)).not.toBeNull();
    await service.pause();
    expect(service.acquireFrameForObservation(input)).toBeNull();
    await service.stop();
    expect(service.acquireFrameForObservation(input)).toBeNull();
  });

  it("bounds media admission stream readiness and first frame independently", async () => {
    vi.useFakeTimers();
    try {
      let resolveAdmission!: () => void;
      const admission = new Promise<void>((resolve) => {
        resolveAdmission = resolve;
      });
      let admissionStarted!: () => void;
      const waitingForAdmission = new Promise<void>((resolve) => {
        admissionStarted = resolve;
      });
      let emitWorker!: (event: unknown) => void;
      let identity!: { captureId: string; generation: number };
      const { service } = harness({
        worker: async (input, emit) => {
          identity = input;
          emitWorker = emit;
          queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
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
              return true;
            },
            waitForAdmission() {
              admissionStarted();
              return admission;
            },
            async stop() {},
          };
        },
      });
      const listed = await candidates(service);
      const starting = service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      });
      await waitingForAdmission;
      await vi.advanceTimersByTimeAsync(4_999);
      resolveAdmission();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_999);
      emitWorker({
        schemaVersion: 1,
        kind: "stream_ready",
        captureId: identity.captureId,
        generation: identity.generation,
        sourceWidth: 800,
        sourceHeight: 600,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_999);
      emitWorker({
        schemaVersion: 1,
        kind: "frame",
        captureId: identity.captureId,
        generation: identity.generation,
        sourceWidth: 800,
        sourceHeight: 600,
        width: 800,
        height: 600,
        bytes: new Uint8Array(jpeg(800, 600)),
      });
      await expect(starting).resolves.toMatchObject({ ok: true, value: { state: "observing" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a candidate after basis validation fails", async () => {
    const { service } = harness();
    const listed = await candidates(service);
    const candidateId = listed.candidates[0].candidateId;
    const invalid = await service.start({
      sessionId: "session-1",
      candidateId,
      region: { xBps: 9000, yBps: 0, widthBps: 2000, heightBps: 1000 },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "capture_region_invalid" } });
    expect(service.preview("candidates", candidateId)).not.toBeNull();
  });

  it("fails closed when source dimensions change after the first frame", async () => {
    const { service, clock, emit, identity } = harness();
    const listed = await candidates(service);
    const started = await service.start({
      sessionId: "session-1",
      candidateId: listed.candidates[0].candidateId,
      region: null,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    clock.value += 2000;
    const bytes = new Uint8Array(jpeg(800, 600));
    emit({
      schemaVersion: 1,
      kind: "frame",
      captureId: identity().captureId,
      generation: identity().generation,
      sourceWidth: 801,
      sourceHeight: 600,
      width: 800,
      height: 600,
      bytes,
    });
    await vi.waitFor(() => {
      expect(service.status()).toMatchObject({
        ok: true,
        value: { state: "idle", reason: "source_changed", retainedBytes: 0 },
      });
    });
    expect(bytes.every((value) => value === 0)).toBe(true);
  });

  it("pauses without bytes, resumes the same capture, and stops idempotently", async () => {
    const { service, clock } = harness();
    const listed = await candidates(service);
    const started = await service.start({
      sessionId: "session-1",
      candidateId: listed.candidates[0].candidateId,
      region: null,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const captureId = started.value.captureId;
    expect(await service.pause()).toMatchObject({
      ok: true,
      value: { state: "paused", retainedBytes: 0, capturedFrames: 1 },
    });
    clock.value += 2000;
    expect(await service.resume()).toMatchObject({
      ok: true,
      value: {
        state: "observing",
        reason: "user_resumed",
        captureId,
        capturedFrames: 2,
      },
    });
    expect(await service.stop()).toMatchObject({
      ok: true,
      value: { state: "idle", reason: "user_stopped", retainedBytes: 0 },
    });
    expect(await service.stop()).toMatchObject({
      ok: true,
      value: { state: "idle", reason: "user_stopped", retainedBytes: 0 },
    });
  });

  it("updates the main-owned indicator without letting indicator errors affect capture", async () => {
    const { service } = harness();
    const states: string[] = [];
    service.setIndicator((state) => states.push(state.state));
    const listed = await candidates(service);
    const started = await service.start({
      sessionId: "session-1",
      candidateId: listed.candidates[0].candidateId,
      region: null,
    });
    expect(started.ok).toBe(true);
    expect(states).toContain("starting");
    expect(states.at(-1)).toBe("observing");
    service.setIndicator(() => {
      throw new Error("indicator unavailable");
    });
    expect(await service.pause()).toMatchObject({ ok: true, value: { state: "paused" } });
    expect(await service.stop("screen_locked")).toMatchObject({
      ok: true,
      value: { state: "idle", reason: "screen_locked" },
    });
  });

  it("does not let a delayed pause overwrite a newer selected session", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return observingWorker(input, emit, () => stopBarrier);
      },
    });
    const listed = await candidates(service);
    expect(
      (
        await service.start({
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        })
      ).ok,
    ).toBe(true);

    const pausing = service.pause();
    expect(await service.sources({ sessionId: "session-1", sourceKind: "display" })).toMatchObject({
      ok: false,
      error: { code: "capture_busy" },
    });
    const switching = service.activateSession("session-2");
    releaseStop();
    await switching;
    expect(await pausing).toMatchObject({ ok: false, error: { code: "capture_inactive" } });
    expect(service.status()).toMatchObject({ ok: true, value: { state: "idle" } });
    expect(await service.sources({ sessionId: "session-2", sourceKind: "display" })).toMatchObject({
      ok: true,
    });
  });

  it("keeps source work fenced until delayed stop cleanup finishes", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return observingWorker(input, emit, () => stopBarrier);
      },
    });
    const listed = await candidates(service);
    expect(
      (
        await service.start({
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        })
      ).ok,
    ).toBe(true);
    const stopping = service.stop();
    let repeatedResolved = false;
    const repeatedStop = service.stop().then((result) => {
      repeatedResolved = true;
      return result;
    });
    expect(await service.sources({ sessionId: "session-1", sourceKind: "display" })).toMatchObject({
      ok: false,
      error: { code: "capture_busy" },
    });
    await Promise.resolve();
    expect(repeatedResolved).toBe(false);
    expect(service.status()).toMatchObject({ ok: true, value: { state: "stopping" } });
    releaseStop();
    expect(await stopping).toMatchObject({ ok: true, value: { state: "idle" } });
    expect(await repeatedStop).toMatchObject({ ok: true, value: { state: "idle" } });
  });

  it("does not finish a session switch before prior worker cleanup", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return observingWorker(input, emit, () => stopBarrier);
      },
    });
    const listed = await candidates(service);
    expect(
      (
        await service.start({
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        })
      ).ok,
    ).toBe(true);

    let activated = false;
    const switching = service.activateSession("session-2").then(() => {
      activated = true;
    });
    await Promise.resolve();
    expect(activated).toBe(false);
    expect(service.status()).toMatchObject({ ok: true, value: { state: "stopping" } });
    expect(await service.sources({ sessionId: "session-2", sourceKind: "display" })).toMatchObject({
      ok: false,
      error: { code: "capture_busy" },
    });
    releaseStop();
    await switching;
    expect(activated).toBe(true);
    expect(await service.sources({ sessionId: "session-2", sourceKind: "display" })).toMatchObject({
      ok: true,
    });
  });

  it("does not finish stop before bounded worker startup settles and cleans up", async () => {
    let resolveWorker!: (worker: CaptureWorkerController) => void;
    let creatingWorker = false;
    const pendingWorker = new Promise<CaptureWorkerController>((resolve) => {
      resolveWorker = resolve;
    });
    const workerStop = vi.fn(async () => {});
    const { service } = harness({
      worker: async () => {
        creatingWorker = true;
        return pendingWorker;
      },
    });
    const listed = await candidates(service);
    const starting = service.start({
      sessionId: "session-1",
      candidateId: listed.candidates[0].candidateId,
      region: null,
    });
    await vi.waitFor(() => expect(creatingWorker).toBe(true));

    let stopped = false;
    const stopping = service.stop().then((result) => {
      stopped = true;
      return result;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveWorker({
      configure() {},
      startWithGesture: async () => true,
      waitForAdmission: async () => {},
      stop: workerStop,
    });
    expect(await stopping).toMatchObject({ ok: true, value: { state: "idle" } });
    expect(workerStop).toHaveBeenCalledOnce();
    expect(await starting).toMatchObject({
      ok: false,
      error: { code: "capture_wrong_session" },
    });
  });

  it("admits only one pause or resume transition at a time", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { service, platform } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return observingWorker(input, emit, () => stopBarrier);
      },
    });
    const listed = await candidates(service);
    expect(
      (
        await service.start({
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        })
      ).ok,
    ).toBe(true);
    const firstPause = service.pause();
    expect(await service.pause()).toMatchObject({
      ok: false,
      error: { code: "capture_inactive" },
    });
    releaseStop();
    expect(await firstPause).toMatchObject({ ok: true, value: { state: "paused" } });

    let resolveSources!: (sources: CaptureNativeSource[]) => void;
    platform.sources = async () =>
      new Promise((resolve) => {
        resolveSources = resolve;
      });
    const firstResume = service.resume();
    expect(await service.resume()).toMatchObject({
      ok: false,
      error: { code: "capture_inactive" },
    });
    resolveSources([source()]);
    expect(await firstResume).toMatchObject({ ok: true, value: { state: "observing" } });
  });

  it("releases the stopped worker epoch before retaining paused metadata", async () => {
    const workerStop = vi.fn(async () => {});
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return observingWorker(input, emit, workerStop);
      },
    });
    const listed = await candidates(service);
    expect(
      (
        await service.start({
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        })
      ).ok,
    ).toBe(true);
    expect(await service.pause()).toMatchObject({ ok: true, value: { state: "paused" } });
    expect(workerStop).toHaveBeenCalledOnce();
    expect((await service.stop()).ok).toBe(true);
    expect(workerStop).toHaveBeenCalledOnce();
  });

  it("ignores every late event from the worker epoch replaced by resume", async () => {
    const emitters: Array<(event: unknown) => void> = [];
    const identities: Array<{ captureId: string; generation: number }> = [];
    const { service } = harness({
      worker: async (input, emit) => {
        identities.push(input);
        const workerIndex = emitters.push(emit) - 1;
        if (workerIndex === 0) {
          queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        }
        return observingWorker(input, emit);
      },
    });
    const listed = await candidates(service);
    const started = await service.start({
      sessionId: "session-1",
      candidateId: listed.candidates[0].candidateId,
      region: null,
    });
    expect(started).toMatchObject({ ok: true, value: { capturedFrames: 1 } });
    expect((await service.pause()).ok).toBe(true);

    const resuming = service.resume();
    await vi.waitFor(() => expect(emitters).toHaveLength(2));
    const previousIdentity = identities[0];
    const oldFrame = new Uint8Array(jpeg(800, 600));
    emitters[0]({ schemaVersion: 1, kind: "ready" });
    emitters[0]({
      schemaVersion: 1,
      kind: "configured",
      captureId: previousIdentity.captureId,
      generation: previousIdentity.generation,
    });
    emitters[0]({
      schemaVersion: 1,
      kind: "ended",
      captureId: previousIdentity.captureId,
      generation: previousIdentity.generation,
      reason: "track_ended",
    });
    emitters[0]({
      schemaVersion: 1,
      kind: "frame",
      captureId: previousIdentity.captureId,
      generation: previousIdentity.generation,
      sourceWidth: 800,
      sourceHeight: 600,
      width: 800,
      height: 600,
      bytes: oldFrame,
    });
    expect(oldFrame.every((byte) => byte === 0)).toBe(true);

    emitters[1]({ schemaVersion: 1, kind: "ready" });
    expect(await resuming).toMatchObject({
      ok: true,
      value: { state: "observing", capturedFrames: 2 },
    });
  });

  it("discards an enumeration result after the selected session changes", async () => {
    let resolve!: (sources: CaptureNativeSource[]) => void;
    const pending = new Promise<CaptureNativeSource[]>((done) => {
      resolve = done;
    });
    const { service, platform } = harness();
    platform.sources = async () => pending;
    await service.activateSession("session-1");
    const listing = service.sources({ sessionId: "session-1", sourceKind: "window" });
    await service.activateSession("session-2");
    resolve([source()]);
    expect(await listing).toMatchObject({
      ok: false,
      error: { code: "capture_wrong_session" },
    });
  });

  it("enforces candidate count, replacement, and expiry bounds", async () => {
    const many = Array.from({ length: 65 }, (_, index) =>
      source(`screen:${index}`, `Display ${index + 1}`, 480, 270),
    );
    const { service, clock } = harness({ sources: many });
    const first = await candidates(service);
    expect(first.candidates).toHaveLength(64);
    expect(first.truncated).toBe(true);
    const firstId = first.candidates[0].candidateId;
    const second = await service.sources({ sessionId: "session-1", sourceKind: "display" });
    expect(second.ok).toBe(true);
    expect(service.preview("candidates", firstId)).toBeNull();
    if (!second.ok) return;
    const secondId = second.value.candidates[0].candidateId;
    clock.value += 30_001;
    expect(service.preview("candidates", secondId)).toBeNull();
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId: secondId,
        region: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "capture_source_expired" } });
  });

  it("permits only one source listing operation", async () => {
    let resolve!: (sources: CaptureNativeSource[]) => void;
    const pending = new Promise<CaptureNativeSource[]>((done) => {
      resolve = done;
    });
    const { service, platform } = harness();
    platform.sources = async () => pending;
    await service.activateSession("session-1");
    const first = service.sources({ sessionId: "session-1", sourceKind: "window" });
    expect(await service.sources({ sessionId: "session-1", sourceKind: "window" })).toMatchObject({
      ok: false,
      error: { code: "capture_busy" },
    });
    resolve([source()]);
    expect(await first).toMatchObject({ ok: true });
  });

  it("consumes a candidate when the actual region is too small", async () => {
    const { service } = harness({
      worker: async (input, emit) => {
        const controller: CaptureWorkerController = {
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
              sourceWidth: 100,
              sourceHeight: 100,
            });
            return true;
          },
          async waitForAdmission() {},
          async stop() {},
        };
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return controller;
      },
    });
    const listed = await candidates(service);
    const candidateId = listed.candidates[0].candidateId;
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId,
        region: { xBps: 0, yBps: 0, widthBps: 100, heightBps: 100 },
      }),
    ).toMatchObject({ ok: false, error: { code: "capture_region_too_small" } });
    expect(service.preview("candidates", candidateId)).toBeNull();
    expect(service.status()).toMatchObject({
      ok: true,
      value: { state: "failed", reason: "region_invalid", retainedBytes: 0 },
    });
  });

  it("fails closed on a duplicate worker phase", async () => {
    const { service } = harness({
      worker: async (_input, emit) => {
        const controller: CaptureWorkerController = {
          configure(config) {
            const configured = {
              schemaVersion: 1,
              kind: "configured",
              captureId: config.captureId,
              generation: config.generation,
            } as const;
            emit(configured);
            emit(configured);
          },
          async startWithGesture() {
            return true;
          },
          async waitForAdmission() {},
          async stop() {},
        };
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return controller;
      },
    });
    const listed = await candidates(service);
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "capture_worker_failed" } });
    expect(service.status()).toMatchObject({
      ok: true,
      value: { state: "failed", reason: "worker_failed", retainedBytes: 0 },
    });
  });

  it("normalizes source revalidation rejection separately from a missing source", async () => {
    const { service, platform } = harness();
    const listed = await candidates(service);
    platform.sources = async () => {
      throw new Error("native enumeration rejected");
    };
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "capture_source_unavailable" } });
    expect(service.status()).toMatchObject({
      ok: true,
      value: { state: "failed", reason: "source_enumeration_failed" },
    });
  });

  it("normalizes a source revalidation deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { service, platform } = harness();
      const listed = await candidates(service);
      platform.sources = async () => new Promise(() => {});
      const starting = service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await starting).toMatchObject({
        ok: false,
        error: { code: "capture_source_timeout" },
      });
      expect(service.status()).toMatchObject({
        ok: true,
        value: { state: "failed", reason: "source_timeout" },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ["invalid", new Uint8Array([1, 2, 3, 4]), "capture_frame_invalid", "frame_invalid"],
    ["oversized", new Uint8Array(2_097_153), "capture_frame_too_large", "frame_too_large"],
  ])("returns the exact %s first-frame failure", async (_name, bytes, errorCode, reason) => {
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        const controller = observingWorker(input, emit);
        controller.startWithGesture = async () => {
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
            bytes,
          });
          return true;
        };
        return controller;
      },
    });
    const listed = await candidates(service);
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      }),
    ).toMatchObject({ ok: false, error: { code: errorCode } });
    expect(service.status()).toMatchObject({ ok: true, value: { state: "failed", reason } });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("waits for worker cleanup before returning a worker-event failure", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopStarted = false;
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        const controller = observingWorker(input, emit, async () => {
          stopStarted = true;
          await stopBarrier;
        });
        controller.startWithGesture = async () => {
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
            bytes: new Uint8Array([1, 2, 3, 4]),
          });
          return true;
        };
        return controller;
      },
    });
    const listed = await candidates(service);
    const events: Array<{ kind: string; value?: { state?: string; captureId?: string | null } }> =
      [];
    let startResolved = false;
    const starting = service
      .start(
        {
          sessionId: "session-1",
          candidateId: listed.candidates[0].candidateId,
          region: null,
        },
        (event) => events.push(event),
      )
      .then((result) => {
        startResolved = true;
        return result;
      });
    await vi.waitFor(() => expect(stopStarted).toBe(true));
    await Promise.resolve();
    expect(startResolved).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "state",
      value: { state: "stopping", captureId: expect.any(String) },
    });
    releaseStop();
    expect(await starting).toMatchObject({
      ok: false,
      error: { code: "capture_frame_invalid" },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "state",
      value: { state: "failed", captureId: null },
    });
  });

  it("lets a newer stop publish after joining held failure cleanup", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopStarted = false;
    const { service } = harness({
      worker: async (input, emit) => {
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        const controller = observingWorker(input, emit, async () => {
          stopStarted = true;
          await stopBarrier;
        });
        controller.startWithGesture = async () => {
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
            bytes: new Uint8Array([1, 2, 3, 4]),
          });
          return true;
        };
        return controller;
      },
    });
    const listed = await candidates(service);
    const events: Array<{ kind: string; value?: { state?: string; reason?: string } }> = [];
    const starting = service.start(
      {
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      },
      (event) => events.push(event),
    );
    await vi.waitFor(() => expect(stopStarted).toBe(true));
    const stopping = service.stop();
    expect(events.at(-1)).toMatchObject({ kind: "state", value: { state: "stopping" } });
    releaseStop();
    expect((await starting).ok).toBe(false);
    expect(await stopping).toMatchObject({
      ok: true,
      value: { state: "idle", reason: "user_stopped" },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "state",
      value: { state: "idle", reason: "user_stopped" },
    });
  });

  it("fails the active capture when renderer delivery is unavailable", async () => {
    for (const listener of [
      () => false,
      () => {
        throw new Error("renderer send failed");
      },
    ]) {
      const { service } = harness();
      const listed = await candidates(service);
      expect(
        await service.start(
          {
            sessionId: "session-1",
            candidateId: listed.candidates[0].candidateId,
            region: null,
          },
          listener,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "capture_internal_error" },
      });
      expect(service.status()).toMatchObject({
        ok: true,
        value: { state: "failed", reason: "internal_error", retainedBytes: 0 },
      });
    }
  });

  it("reports permission and unsupported states without leaking platform facts", async () => {
    const denied = harness({ permission: () => "denied" });
    await denied.service.activateSession("session-1");
    expect(
      await denied.service.sources({ sessionId: "session-1", sourceKind: "display" }),
    ).toMatchObject({ ok: false, error: { code: "capture_permission_denied" } });

    const unsupported = new CaptureService({
      platform: "linux",
      permission: () => "granted",
      sources: async () => {
        throw new Error("must not enumerate");
      },
      createWorker: async () => {
        throw new Error("must not create");
      },
    });
    await unsupported.activateSession("session-1");
    expect(
      await unsupported.sources({ sessionId: "session-1", sourceKind: "display" }),
    ).toMatchObject({ ok: false, error: { code: "capture_unsupported" } });
  });

  it("enumerates once for an explicit not-determined request and rereads permission", async () => {
    for (const [finalPermission, expected] of [
      ["granted", { ok: true }],
      ["denied", { ok: false, error: { code: "capture_permission_denied" } }],
    ] as const) {
      let read = 0;
      const { service, calls } = harness({
        permission: () => (read++ === 0 ? "not_determined" : finalPermission),
      });
      await service.activateSession("session-1");
      read = 0;
      expect(
        await service.sources({ sessionId: "session-1", sourceKind: "display" }),
      ).toMatchObject(expected);
      expect(calls).toEqual(["sources:thumbnail"]);
    }
  });

  it("uses one permission snapshot for start admission and its public error", async () => {
    const { service, platform } = harness();
    const listed = await candidates(service);
    const permissions = ["denied", "granted"] as const;
    let call = 0;
    platform.permission = () => permissions[Math.min(call++, permissions.length - 1)];
    expect(
      await service.start({
        sessionId: "session-1",
        candidateId: listed.candidates[0].candidateId,
        region: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "capture_permission_denied" } });
    expect(service.status()).toMatchObject({
      ok: true,
      value: { state: "blocked", reason: "permission_denied", permission: "denied" },
    });
    expect(call).toBe(1);
  });

  it("uses the admitted resume permission until the next lifecycle check", async () => {
    const { service, platform } = harness();
    const listed = await candidates(service);
    const events: Array<{ kind: string; value?: { state?: string; permission?: string } }> = [];
    expect(
      (
        await service.start(
          {
            sessionId: "session-1",
            candidateId: listed.candidates[0].candidateId,
            region: null,
          },
          (event) => events.push(event),
        )
      ).ok,
    ).toBe(true);
    expect((await service.pause()).ok).toBe(true);

    let call = 0;
    platform.permission = () => (call++ === 0 ? "granted" : "denied");
    expect(await service.resume()).toMatchObject({
      ok: false,
      error: { code: "capture_permission_denied" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "state",
        value: expect.objectContaining({ state: "starting", permission: "granted" }),
      }),
    );
    expect(service.status()).toMatchObject({
      ok: true,
      value: { state: "blocked", reason: "permission_denied", permission: "denied" },
    });
  });
});
