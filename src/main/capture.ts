// Main-owned bounded capture state, worker admission, and preview storage.

import { createHash, randomBytes } from "node:crypto";
import { nativeImage, type NativeImage } from "electron";
import type {
  CaptureCandidateV1,
  CaptureEventV1,
  CaptureFrameV1,
  CapturePermissionV1,
  CaptureRegionV1,
  CaptureSourceKind,
  CaptureSourcesInput,
  CaptureSourcesValue,
  CaptureStartInput,
  CaptureStateReasonV1,
  CaptureStateV1,
  ClientResult,
} from "../shared/contracts.js";
import {
  isCaptureWorkerEvent,
  type CaptureWorkerConfigV1,
  type CaptureWorkerEventV1,
} from "../shared/capture-worker.js";

const candidateTtlMs = 30_000;
const frameTtlMs = 30_000;
const pausedTtlMs = 300_000;
const sourceDeadlineMs = 5_000;
const workerDeadlineMs = 5_000;
const configuredDeadlineMs = 2_000;
const gestureDeadlineMs = 2_000;
const frameCadenceMs = 2_000;
const maxCandidateCount = 64;
const maxCandidateBytes = 16 * 1024 * 1024;
const maxCandidatePreviewBytes = 256 * 1024;
const maxFrameBytes = 2 * 1024 * 1024;
const maxRetainedFrameBytes = 4 * 1024 * 1024;
const idPattern = /^[0-9a-f]{48}$/;

export type CaptureNativeSource = {
  nativeId: string;
  label: string;
  thumbnail: NativeImage;
  scaleFactor: number | null;
  grantSource?: { id: string; name: string };
};

export type CaptureWorkerController = {
  configure(config: CaptureWorkerConfigV1): void;
  startWithGesture(): Promise<boolean>;
  waitForAdmission(): Promise<void>;
  stop(): Promise<void>;
};

export type CapturePlatform = {
  platform: NodeJS.Platform;
  permission(): CapturePermissionV1;
  sources(kind: CaptureSourceKind, thumbnail: boolean): Promise<CaptureNativeSource[]>;
  createWorker(
    input: {
      captureId: string;
      generation: number;
      nativeSourceId: string;
      grantSource: { id: string; name: string } | null;
    },
    onEvent: (event: unknown) => void,
  ): Promise<CaptureWorkerController>;
};

export type CapturePreview = {
  bytes: Buffer;
  contentType: "image/jpeg";
};

export type ObservationFrameLeaseInput = {
  sessionId: string;
  captureId: string;
  frameId: string;
  contentHash: string;
};

export type ObservationFrameLease = {
  frame: CaptureFrameV1;
  bytes: Buffer;
};

type Clock = {
  now(): number;
};

type CandidateRecord = {
  value: CaptureCandidateV1;
  nativeId: string;
  sessionId: string;
  sessionGeneration: number;
  expiresAtMs: number;
  preview: Buffer;
};

type FrameRecord = {
  value: CaptureFrameV1;
  expiresAtMs: number;
  bytes: Buffer;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

type TerminalSignal = {
  promise: Promise<string>;
  resolve(reason: string): void;
};

type ActiveCapture = {
  captureId: string;
  generation: number;
  sessionId: string;
  sessionGeneration: number;
  nativeSourceId: string;
  sourceKind: CaptureSourceKind;
  publicSourceKind: CaptureSourceKind | "region";
  sourceLabel: string;
  scaleFactor: number | null;
  region: CaptureRegionV1 | null;
  worker: CaptureWorkerController | null;
  startup: Promise<CaptureWorkerController> | null;
  cleanup: Promise<void> | null;
  ready: Deferred;
  configured: Deferred;
  streamReady: Deferred;
  firstFrame: Deferred;
  terminal: TerminalSignal;
  sourceWidth: number | null;
  sourceHeight: number | null;
  pausedUntilMs: number | null;
  startReason: "user_started" | "user_resumed";
  phase:
    | "created"
    | "ready"
    | "configured"
    | "gesture"
    | "stream"
    | "pausing"
    | "paused"
    | "revalidating";
  acceptEvents: boolean;
  grantSource: { id: string; name: string } | null;
};

type SourceRevalidation =
  | { ok: true; source: CaptureNativeSource | null }
  | { ok: false; reason: "source_enumeration_failed" | "source_timeout" };

const systemClock: Clock = { now: () => Date.now() };

export class CaptureService {
  #platform: CapturePlatform;
  #clock: Clock;
  #selectedSessionId: string | null = null;
  #sessionGeneration = 0;
  #operationGeneration = 0;
  #stopping = 0;
  #cleanup: Promise<void> | null = null;
  #listing: object | null = null;
  #candidates = new Map<string, CandidateRecord>();
  #frames = new Map<string, FrameRecord>();
  #candidateTimer: NodeJS.Timeout | null = null;
  #frameTimers = new Map<string, NodeJS.Timeout>();
  #pausedTimer: NodeJS.Timeout | null = null;
  #active: ActiveCapture | null = null;
  #listener: ((event: CaptureEventV1) => unknown) | null = null;
  #indicator: ((state: CaptureStateV1) => void) | null = null;
  #state: CaptureStateV1 = idleState("unknown");

  constructor(platform: CapturePlatform = unavailablePlatform(), clock: Clock = systemClock) {
    this.#platform = platform;
    this.#clock = clock;
    if (platform.platform !== "darwin") {
      this.#state = blockedState("unsupported", "unsupported");
    }
  }

  status(): ClientResult<CaptureStateV1> {
    this.#purgeExpired();
    return success(this.#snapshot());
  }

  setIndicator(listener: ((state: CaptureStateV1) => void) | null): void {
    this.#indicator = listener;
    this.#notifyIndicator();
  }

  async activateSession(sessionId: string): Promise<void> {
    if (!validSessionId(sessionId) || sessionId === this.#selectedSessionId) return;
    const sessionGeneration = ++this.#sessionGeneration;
    this.#selectedSessionId = sessionId;
    this.#purgeCandidates();
    const operationGeneration = await this.#stopActive("session_changed");
    if (
      this.#sessionGeneration === sessionGeneration &&
      this.#operationGeneration === operationGeneration &&
      this.#selectedSessionId === sessionId
    ) {
      this.#state = idleState(this.#permission());
    }
  }

  async fenceSession(sessionId: string, reason: "session_closed"): Promise<void> {
    if (!validSessionId(sessionId) || sessionId !== this.#selectedSessionId) return;
    const sessionGeneration = ++this.#sessionGeneration;
    this.#selectedSessionId = null;
    this.#purgeCandidates();
    const operationGeneration = await this.#stopActive(reason);
    if (
      this.#sessionGeneration === sessionGeneration &&
      this.#operationGeneration === operationGeneration &&
      this.#selectedSessionId === null
    ) {
      this.#state = idleState(this.#permission());
    }
  }

  async close(reason: CaptureStateReasonV1 = "app_quit"): Promise<void> {
    const sessionGeneration = ++this.#sessionGeneration;
    this.#selectedSessionId = null;
    this.#purgeCandidates();
    const operationGeneration = await this.#stopActive(reason);
    if (
      this.#sessionGeneration === sessionGeneration &&
      this.#operationGeneration === operationGeneration &&
      this.#selectedSessionId === null
    ) {
      this.#listener = null;
    }
  }

  async sources(input: unknown): Promise<ClientResult<CaptureSourcesValue>> {
    const validated = validateSourcesInput(input);
    if (!validated) return failure("invalid_request", "Capture source request is invalid.");
    const sessionError = this.#sessionError(validated.sessionId);
    if (sessionError) return sessionError;
    if (this.#active || this.#stopping > 0) {
      return failure("capture_busy", "Capture must stop before sources are changed.");
    }
    if (this.#platform.platform !== "darwin") {
      this.#purgeCandidates();
      this.#setState(blockedState("unsupported", "unsupported"));
      return failure("capture_unsupported", "Screen capture is not supported on this platform.");
    }
    if (this.#listing) return failure("capture_busy", "Capture sources are already loading.");

    const listing = {};
    this.#listing = listing;
    this.#purgeCandidates();
    const sessionGeneration = this.#sessionGeneration;
    const operationGeneration = ++this.#operationGeneration;
    let permission = this.#permission();
    this.#setState({ ...idleState(permission), state: "selecting" });
    try {
      if (permission === "denied" || permission === "restricted" || permission === "unknown") {
        return this.#permissionFailure(permission);
      }
      let sources: CaptureNativeSource[];
      try {
        sources = await deadline(
          this.#platform.sources(validated.sourceKind, true),
          sourceDeadlineMs,
          "source_timeout",
        );
      } catch (error) {
        const reason =
          error instanceof CaptureFailure && error.code === "source_timeout"
            ? "source_timeout"
            : "source_enumeration_failed";
        if (this.#current(sessionGeneration, operationGeneration)) {
          this.#setState(failedState(reason, this.#permission()));
        }
        return reason === "source_timeout"
          ? failure("capture_source_timeout", "Capture source enumeration timed out.")
          : failure("capture_source_unavailable", "Capture sources are unavailable.");
      }
      if (!this.#current(sessionGeneration, operationGeneration)) {
        return failure("capture_wrong_session", "Capture session changed.");
      }
      if (permission === "not_determined") {
        permission = this.#permission();
        if (permission !== "granted") {
          return this.#permissionFailure(permission);
        }
      }
      if (permission !== "granted") return this.#permissionFailure(permission);

      const published = this.#buildCandidates(sources, validated, sessionGeneration);
      if (!this.#current(sessionGeneration, operationGeneration)) {
        published.records.forEach((record) => {
          overwrite(record.preview);
        });
        return failure("capture_wrong_session", "Capture session changed.");
      }
      this.#purgeCandidates();
      for (const record of published.records)
        this.#candidates.set(record.value.candidateId, record);
      this.#candidateTimer = schedule(candidateTtlMs, () => this.#purgeExpired());
      this.#setState(idleState(permission));
      return success({
        schemaVersion: 1,
        permission,
        candidates: published.records.map((record) => record.value),
        truncated: sources.length > maxCandidateCount,
        expiresAt: iso(published.expiresAtMs),
      });
    } catch {
      if (this.#current(sessionGeneration, operationGeneration)) {
        this.#setState(failedState("internal_error", this.#permission()));
      }
      return failure("capture_internal_error", "Capture sources could not be prepared.");
    } finally {
      if (this.#listing === listing) this.#listing = null;
    }
  }

  async start(
    input: unknown,
    listener?: (event: CaptureEventV1) => unknown,
  ): Promise<ClientResult<CaptureStateV1>> {
    const validated = validateStartInput(input);
    if (!validated) return failure("invalid_request", "Capture start request is invalid.");
    const sessionError = this.#sessionError(validated.sessionId);
    if (sessionError) return sessionError;
    if (this.#stopping > 0) return failure("capture_busy", "Capture cleanup is in progress.");
    if (this.#active) return failure("capture_already_active", "A capture is already active.");
    this.#purgeExpired();
    const candidate = this.#candidates.get(validated.candidateId);
    if (!candidate || candidate.expiresAtMs <= this.#clock.now()) {
      return failure("capture_source_expired", "Capture source selection expired.");
    }
    if (
      candidate.sessionId !== validated.sessionId ||
      candidate.sessionGeneration !== this.#sessionGeneration
    ) {
      return failure("capture_wrong_session", "Capture session changed.");
    }
    if (!validRegion(validated.region)) {
      return failure("capture_region_invalid", "Capture region is invalid.");
    }
    const permission = this.#permission();
    if (permission !== "granted") return this.#permissionFailure(permission);

    const captureId = opaqueId();
    const generation = ++this.#operationGeneration;
    const active = activeCapture(captureId, generation, candidate, validated.region);
    this.#active = active;
    this.#listener = listener ?? null;
    this.#consumeCandidates();
    if (!this.#setState(startingState(active, permission, this.#clock.now(), this.#state))) {
      await this.#failActive(active, "internal_error");
      return failure("capture_internal_error", "Capture event delivery failed.");
    }
    const revalidated = await this.#revalidateSource(active);
    if (!this.#isActive(active)) {
      return failure("capture_wrong_session", "Capture session changed.");
    }
    if (!revalidated.ok) {
      await this.#failActive(active, revalidated.reason);
      return revalidationFailure(revalidated.reason);
    }
    if (!revalidated.source) {
      await this.#stopActive("source_missing");
      return failure("capture_source_missing", "Capture source is no longer available.");
    }
    active.nativeSourceId = revalidated.source.nativeId;
    active.grantSource = revalidated.source.grantSource ?? null;
    const currentPermission = this.#permission();
    if (currentPermission !== "granted") {
      await this.#stopActive(permissionReason(currentPermission));
      return this.#permissionFailure(currentPermission);
    }
    return this.#runWorker(active);
  }

  async pause(): Promise<ClientResult<CaptureStateV1>> {
    const active = this.#active;
    if (!active) return failure("capture_inactive", "No capture is active.");
    if (this.#state.state === "paused") return success(this.#snapshot());
    if (this.#state.state !== "observing") {
      return failure("capture_inactive", "Capture is not observing.");
    }
    if (active.phase !== "stream") {
      return failure("capture_inactive", "Capture lifecycle transition is in progress.");
    }
    active.phase = "pausing";
    const operationGeneration = ++this.#operationGeneration;
    active.acceptEvents = false;
    await this.#finishActive(active);
    if (!this.#isActive(active) || this.#operationGeneration !== operationGeneration) {
      return failure("capture_inactive", "Capture changed while pausing.");
    }
    active.worker = null;
    active.startup = null;
    active.cleanup = null;
    active.pausedUntilMs = this.#clock.now() + pausedTtlMs;
    active.phase = "paused";
    clearTimer(this.#pausedTimer);
    this.#pausedTimer = schedule(pausedTtlMs, () => this.#purgeExpired());
    this.#purgeFrames();
    if (
      !this.#setState({
        ...this.#snapshot(),
        state: "paused",
        reason: "user_paused",
        pausedAt: iso(this.#clock.now()),
        retainedBytes: 0,
        lastFrameAt: null,
      })
    ) {
      await this.#failActive(active, "internal_error");
      return failure("capture_internal_error", "Capture event delivery failed.");
    }
    return success(this.#snapshot());
  }

  async resume(): Promise<ClientResult<CaptureStateV1>> {
    const active = this.#active;
    if (!active || this.#state.state !== "paused") {
      return failure("capture_inactive", "Capture is not paused.");
    }
    if (active.phase !== "paused") {
      return failure("capture_inactive", "Capture lifecycle transition is in progress.");
    }
    if (active.pausedUntilMs === null || active.pausedUntilMs <= this.#clock.now()) {
      await this.#stopActive("source_expired");
      return failure("capture_source_expired", "Capture source selection expired.");
    }
    active.phase = "revalidating";
    return this.#restart(active);
  }

  async stop(reason: CaptureStateReasonV1 = "user_stopped"): Promise<ClientResult<CaptureStateV1>> {
    await this.#stopActive(reason);
    return success(this.#snapshot());
  }

  preview(kind: "candidates" | "frames", id: string): CapturePreview | null {
    if (!idPattern.test(id)) return null;
    this.#purgeExpired();
    if (kind === "candidates") {
      const record = this.#candidates.get(id);
      return record ? { bytes: Buffer.from(record.preview), contentType: "image/jpeg" } : null;
    }
    const record = this.#frames.get(id);
    return record ? { bytes: Buffer.from(record.bytes), contentType: "image/jpeg" } : null;
  }

  acquireFrameForObservation(input: ObservationFrameLeaseInput): ObservationFrameLease | null {
    const record = this.#observationFrame(input);
    if (!record) return null;
    return { frame: { ...record.value }, bytes: Buffer.from(record.bytes) };
  }

  hasFrameForObservation(input: ObservationFrameLeaseInput): boolean {
    return this.#observationFrame(input) !== null;
  }

  #observationFrame(input: ObservationFrameLeaseInput): FrameRecord | null {
    if (
      !plainExact(input, ["sessionId", "captureId", "frameId", "contentHash"]) ||
      !validSessionId(input.sessionId) ||
      !idPattern.test(input.captureId) ||
      !idPattern.test(input.frameId) ||
      !/^[0-9a-f]{64}$/u.test(input.contentHash)
    ) {
      return null;
    }
    this.#purgeExpired();
    const active = this.#active;
    const record = this.#frames.get(input.frameId);
    return active &&
      record &&
      this.#state.state === "observing" &&
      active.sessionId === input.sessionId &&
      active.captureId === input.captureId &&
      record.value.sessionId === input.sessionId &&
      record.value.captureId === input.captureId &&
      record.value.frameId === input.frameId &&
      record.value.contentHash === input.contentHash &&
      record.value.encoding === "image/jpeg" &&
      record.value.sizeBytes === record.bytes.length &&
      jpeg(record.bytes) &&
      createHash("sha256").update(record.bytes).digest("hex") === input.contentHash
      ? record
      : null;
  }

  async #restart(active: ActiveCapture): Promise<ClientResult<CaptureStateV1>> {
    const revalidated = await this.#revalidateSource(active);
    if (!this.#isActive(active)) {
      return failure("capture_wrong_session", "Capture session changed.");
    }
    if (!revalidated.ok) {
      await this.#failActive(active, revalidated.reason);
      return revalidationFailure(revalidated.reason);
    }
    if (!revalidated.source) {
      await this.#stopActive("source_missing");
      return failure("capture_source_missing", "Capture source is no longer available.");
    }
    active.nativeSourceId = revalidated.source.nativeId;
    active.grantSource = revalidated.source.grantSource ?? null;
    active.generation = ++this.#operationGeneration;
    active.worker = null;
    active.startup = null;
    active.cleanup = null;
    active.ready = deferred();
    active.configured = deferred();
    active.streamReady = deferred();
    active.firstFrame = deferred();
    active.terminal = terminalSignal();
    active.sourceWidth = null;
    active.sourceHeight = null;
    active.pausedUntilMs = null;
    active.startReason = "user_resumed";
    active.phase = "created";
    active.acceptEvents = true;
    clearTimer(this.#pausedTimer);
    this.#pausedTimer = null;
    const permission = this.#permission();
    if (permission !== "granted") {
      await this.#stopActive(permissionReason(permission));
      return this.#permissionFailure(permission);
    }
    if (!this.#setState(startingState(active, permission, this.#clock.now(), this.#state))) {
      await this.#failActive(active, "internal_error");
      return failure("capture_internal_error", "Capture event delivery failed.");
    }
    return this.#runWorker(active);
  }

  async #runWorker(active: ActiveCapture): Promise<ClientResult<CaptureStateV1>> {
    try {
      const workerGeneration = active.generation;
      const workerPromise = this.#platform.createWorker(
        {
          captureId: active.captureId,
          generation: workerGeneration,
          nativeSourceId: active.nativeSourceId,
          grantSource: active.grantSource,
        },
        (event) => void this.#acceptWorkerEvent(active, workerGeneration, event),
      );
      active.grantSource = null;
      active.startup = deadline(workerPromise, workerDeadlineMs, "worker_timeout");
      let worker: CaptureWorkerController;
      try {
        worker = await active.startup;
      } catch (error) {
        void workerPromise.then(
          (lateWorker) => safelyStop(lateWorker),
          () => undefined,
        );
        throw error;
      }
      if (!this.#isActive(active)) {
        await this.#finishActive(active);
        return failure("capture_wrong_session", "Capture session changed.");
      }
      active.worker = worker;
      await waitForActive(active.ready.promise, active.terminal, workerDeadlineMs);
      worker.configure(workerConfig(active));
      await waitForActive(active.configured.promise, active.terminal, configuredDeadlineMs);
      active.phase = "gesture";
      if (
        (await waitForActive(worker.startWithGesture(), active.terminal, gestureDeadlineMs)) !==
        true
      ) {
        throw new CaptureFailure("worker_failed");
      }
      await waitForActive(worker.waitForAdmission(), active.terminal, workerDeadlineMs);
      await waitForActive(active.streamReady.promise, active.terminal, workerDeadlineMs);
      await waitForActive(active.firstFrame.promise, active.terminal, workerDeadlineMs);
      if (!this.#isActive(active))
        return failure("capture_worker_failed", "Capture worker stopped.");
      return success(this.#snapshot());
    } catch (error) {
      const code = errorCode(error);
      await this.#failActive(active, code);
      return workerFailure(code);
    }
  }

  async #revalidateSource(active: ActiveCapture): Promise<SourceRevalidation> {
    try {
      const sources = await deadline(
        this.#platform.sources(active.sourceKind, false),
        sourceDeadlineMs,
        "source_timeout",
      );
      const matched = sources.find((source) => source.nativeId === active.nativeSourceId);
      return { ok: true, source: matched && validNativeSource(matched) ? matched : null };
    } catch (error) {
      return {
        ok: false,
        reason:
          errorCode(error) === "source_timeout" ? "source_timeout" : "source_enumeration_failed",
      };
    }
  }

  async #acceptWorkerEvent(
    active: ActiveCapture,
    workerGeneration: number,
    value: unknown,
  ): Promise<void> {
    if (!this.#isActive(active) || active.generation !== workerGeneration || !active.acceptEvents) {
      if (isFrameLike(value)) value.bytes.fill(0);
      return;
    }
    if (!isCaptureWorkerEvent(value)) {
      const oversized = isFrameLike(value) && value.bytes.byteLength > maxFrameBytes;
      if (isFrameLike(value)) value.bytes.fill(0);
      if (this.#isActive(active) && active.acceptEvents) {
        await this.#failActive(active, oversized ? "frame_too_large" : "frame_invalid");
      }
      return;
    }
    const event = value as CaptureWorkerEventV1;
    if (event.kind === "ready") {
      if (active.phase !== "created") {
        await this.#failActive(active, "worker_failed");
        return;
      }
      active.phase = "ready";
      active.ready.resolve();
      return;
    }
    if (event.captureId !== active.captureId || event.generation !== active.generation) {
      if (event.kind === "frame") {
        event.bytes.fill(0);
        if (
          !this.#setState({
            ...this.#snapshot(),
            droppedFrames: this.#state.droppedFrames + 1,
          })
        ) {
          await this.#failActive(active, "internal_error");
        }
      } else {
        await this.#failActive(active, "worker_failed");
      }
      return;
    }
    if (event.kind === "configured") {
      if (active.phase !== "ready") {
        await this.#failActive(active, "worker_failed");
        return;
      }
      active.phase = "configured";
      active.configured.resolve();
      return;
    }
    if (event.kind === "stream_ready") {
      if (active.phase !== "gesture") {
        await this.#failActive(active, "worker_failed");
        return;
      }
      if (!this.#admitSourceSize(active, event.sourceWidth, event.sourceHeight)) return;
      active.phase = "stream";
      active.streamReady.resolve();
      return;
    }
    if (event.kind === "ended") {
      await this.#stopActive(event.reason === "track_ended" ? "source_ended" : "worker_failed");
      return;
    }
    if (active.phase !== "stream") {
      event.bytes.fill(0);
      await this.#failActive(active, "frame_invalid");
      return;
    }
    await this.#admitFrame(active, event);
  }

  #admitSourceSize(active: ActiveCapture, width: number, height: number): boolean {
    if (
      active.sourceWidth !== null &&
      (active.sourceWidth !== width || active.sourceHeight !== height)
    ) {
      void this.#stopActive("source_changed");
      return false;
    }
    active.sourceWidth = width;
    active.sourceHeight = height;
    if (active.region) {
      const crop = cropSize(active.region, width, height);
      if (crop.width < 64 || crop.height < 64) {
        void this.#failActive(active, "region_invalid");
        return false;
      }
    }
    return true;
  }

  async #admitFrame(
    active: ActiveCapture,
    event: Extract<CaptureWorkerEventV1, { kind: "frame" }>,
  ): Promise<void> {
    const bytes = Buffer.from(event.bytes);
    event.bytes.fill(0);
    const permission = this.#permission();
    if (permission !== "granted") {
      overwrite(bytes);
      await this.#stopActive(permissionReason(permission));
      this.#permissionFailure(permission);
      return;
    }
    if (!this.#admitSourceSize(active, event.sourceWidth, event.sourceHeight)) {
      overwrite(bytes);
      return;
    }
    const expected = outputSize(active.region, event.sourceWidth, event.sourceHeight);
    let decoded: NativeImage;
    let decodedSize: { width: number; height: number };
    try {
      decoded = nativeImage.createFromBuffer(bytes);
      decodedSize = decoded.getSize();
    } catch {
      overwrite(bytes);
      await this.#failActive(active, "frame_invalid");
      return;
    }
    const now = this.#clock.now();
    const invalid =
      bytes.length === 0 ||
      !jpeg(bytes) ||
      decoded.isEmpty() ||
      event.width !== expected.width ||
      event.height !== expected.height ||
      decodedSize.width !== event.width ||
      decodedSize.height !== event.height ||
      (this.#state.lastFrameAt !== null &&
        now - Date.parse(this.#state.lastFrameAt) < frameCadenceMs);
    if (invalid || bytes.length > maxFrameBytes) {
      overwrite(bytes);
      await this.#failActive(
        active,
        bytes.length > maxFrameBytes ? "frame_too_large" : "frame_invalid",
      );
      return;
    }
    const frameId = opaqueId();
    const capturedAt = iso(now);
    const frame: CaptureFrameV1 = {
      schemaVersion: 1,
      kind: "frame",
      captureId: active.captureId,
      frameId,
      sessionId: active.sessionId,
      sourceKind: active.publicSourceKind,
      parentSourceKind: active.sourceKind,
      width: event.width,
      height: event.height,
      scaleFactor: active.scaleFactor,
      capturedAt,
      expiresAt: iso(now + frameTtlMs),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      encoding: "image/jpeg",
      sizeBytes: bytes.length,
      previewUrl: `openminion://app/capture/frames/${frameId}`,
    };
    this.#storeFrame(frame, bytes, now + frameTtlMs);
    const stateDelivered = this.#setState({
      ...this.#snapshot(),
      state: "observing",
      reason: active.startReason,
      pausedAt: null,
      capturedFrames: this.#state.capturedFrames + 1,
      retainedBytes: retainedBytes(this.#frames),
      lastFrameAt: capturedAt,
    });
    const frameDelivered = stateDelivered && this.#emit(frame);
    if (!frameDelivered) {
      await this.#failActive(active, "internal_error");
      return;
    }
    active.firstFrame.resolve();
  }

  #storeFrame(frame: CaptureFrameV1, bytes: Buffer, expiresAtMs: number): void {
    this.#purgeExpired();
    while (
      this.#frames.size >= 2 ||
      retainedBytes(this.#frames) + bytes.length > maxRetainedFrameBytes
    ) {
      const oldest = this.#frames.entries().next().value as [string, FrameRecord] | undefined;
      if (!oldest) break;
      overwrite(oldest[1].bytes);
      clearTimer(this.#frameTimers.get(oldest[0]));
      this.#frameTimers.delete(oldest[0]);
      this.#frames.delete(oldest[0]);
    }
    this.#frames.set(frame.frameId, { value: frame, bytes, expiresAtMs });
    this.#frameTimers.set(
      frame.frameId,
      schedule(frameTtlMs, () => this.#purgeExpired()),
    );
  }

  #buildCandidates(
    sources: CaptureNativeSource[],
    input: CaptureSourcesInput,
    sessionGeneration: number,
  ): { records: CandidateRecord[]; expiresAtMs: number } {
    const expiresAtMs = this.#clock.now() + candidateTtlMs;
    const records: CandidateRecord[] = [];
    let aggregate = 0;
    for (const [index, source] of sources.slice(0, maxCandidateCount).entries()) {
      if (!validNativeSource(source)) continue;
      const prepared = candidatePreview(source.thumbnail);
      if (!prepared) continue;
      if (aggregate + prepared.bytes.length > maxCandidateBytes) {
        overwrite(prepared.bytes);
        continue;
      }
      aggregate += prepared.bytes.length;
      const candidateId = opaqueId();
      const value: CaptureCandidateV1 = {
        schemaVersion: 1,
        candidateId,
        sourceKind: input.sourceKind,
        label: safeLabel(source.label, input.sourceKind, index + 1),
        previewUrl: `openminion://app/capture/candidates/${candidateId}`,
        previewWidth: prepared.width,
        previewHeight: prepared.height,
        scaleFactor:
          input.sourceKind === "display" && finitePositive(source.scaleFactor)
            ? source.scaleFactor
            : null,
      };
      records.push({
        value,
        nativeId: source.nativeId,
        sessionId: input.sessionId,
        sessionGeneration,
        expiresAtMs,
        preview: prepared.bytes,
      });
    }
    return { records, expiresAtMs };
  }

  #sessionError(sessionId: string): ClientResult<never> | null {
    if (!this.#selectedSessionId) {
      return failure("capture_session_required", "A selected session is required.");
    }
    if (sessionId !== this.#selectedSessionId) {
      return failure("capture_wrong_session", "Capture session does not match.");
    }
    return null;
  }

  #permission(): CapturePermissionV1 {
    if (this.#platform.platform !== "darwin") return "unsupported";
    try {
      const permission = this.#platform.permission();
      return ["not_determined", "granted", "denied", "restricted", "unknown"].includes(permission)
        ? permission
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  #permissionFailure(permission: CapturePermissionV1): ClientResult<never> {
    const values = {
      not_determined: [
        "capture_permission_required",
        "Screen recording permission is required.",
        "permission_required",
      ],
      denied: [
        "capture_permission_denied",
        "Screen recording permission was denied.",
        "permission_denied",
      ],
      restricted: [
        "capture_permission_restricted",
        "Screen recording permission is restricted.",
        "permission_restricted",
      ],
      unknown: [
        "capture_permission_unknown",
        "Screen recording permission is unavailable.",
        "permission_unknown",
      ],
      unsupported: [
        "capture_unsupported",
        "Screen capture is not supported on this platform.",
        "unsupported",
      ],
    } as const;
    const value = permission === "granted" ? values.unknown : values[permission];
    this.#setState(blockedState(value[2], permission));
    return failure(value[0], value[1]);
  }

  #current(sessionGeneration: number, operationGeneration: number): boolean {
    return (
      this.#sessionGeneration === sessionGeneration &&
      this.#operationGeneration === operationGeneration
    );
  }

  #isActive(active: ActiveCapture): boolean {
    return this.#active === active && active.sessionGeneration === this.#sessionGeneration;
  }

  async #failActive(active: ActiveCapture, reason: string): Promise<void> {
    if (!this.#isActive(active)) {
      if (active.cleanup) await active.cleanup;
      return;
    }
    const operationGeneration = ++this.#operationGeneration;
    const listener = this.#listener;
    active.terminal.resolve(reason);
    active.acceptEvents = false;
    this.#active = null;
    clearTimer(this.#pausedTimer);
    this.#pausedTimer = null;
    this.#purgeFrames();
    const failed = failedState(reason, this.#permission());
    this.#setState({ ...this.#snapshot(), state: "stopping", reason: failed.reason });
    await this.#finishActive(active);
    if (this.#operationGeneration === operationGeneration) {
      this.#setState(failed);
      if (this.#listener === listener) this.#listener = null;
    }
  }

  async #stopActive(reason: CaptureStateReasonV1): Promise<number> {
    const operationGeneration = ++this.#operationGeneration;
    const active = this.#active;
    if (!active) {
      const listener = this.#listener;
      clearTimer(this.#pausedTimer);
      this.#pausedTimer = null;
      this.#purgeFrames();
      await this.#joinCleanup();
      if (this.#operationGeneration === operationGeneration) {
        this.#setState({ ...idleState(this.#permission()), reason });
        if (this.#listener === listener) this.#listener = null;
      }
      return operationGeneration;
    }
    const listener = this.#listener;
    this.#active = null;
    active.acceptEvents = false;
    clearTimer(this.#pausedTimer);
    this.#pausedTimer = null;
    active.terminal.resolve(reason);
    this.#purgeFrames();
    this.#setState({ ...this.#snapshot(), state: "stopping", reason });
    await this.#finishActive(active);
    if (this.#operationGeneration !== operationGeneration) return operationGeneration;
    this.#setState({ ...idleState(this.#permission()), reason });
    if (this.#listener === listener) this.#listener = null;
    return operationGeneration;
  }

  async #finishActive(active: ActiveCapture): Promise<void> {
    if (!active.cleanup) {
      active.cleanup = (async () => {
        let worker = active.worker;
        if (!worker && active.startup) {
          try {
            worker = await active.startup;
          } catch {
            return;
          }
        }
        await safelyStop(worker);
      })();
    }
    const cleanup = active.cleanup;
    this.#cleanup = cleanup;
    this.#stopping += 1;
    try {
      await cleanup;
    } finally {
      this.#stopping -= 1;
      if (this.#cleanup === cleanup) this.#cleanup = null;
    }
  }

  async #joinCleanup(): Promise<void> {
    if (this.#cleanup) await this.#cleanup;
  }

  #consumeCandidates(): void {
    clearTimer(this.#candidateTimer);
    this.#candidateTimer = null;
    for (const record of this.#candidates.values()) overwrite(record.preview);
    this.#candidates.clear();
  }

  #purgeCandidates(): void {
    this.#consumeCandidates();
  }

  #purgeFrames(): void {
    for (const timer of this.#frameTimers.values()) clearTimer(timer);
    this.#frameTimers.clear();
    for (const record of this.#frames.values()) overwrite(record.bytes);
    this.#frames.clear();
  }

  #purgeExpired(): void {
    const now = this.#clock.now();
    let framesChanged = false;
    for (const [id, record] of this.#candidates) {
      if (record.expiresAtMs <= now) {
        overwrite(record.preview);
        this.#candidates.delete(id);
      }
    }
    if (this.#candidates.size === 0) {
      clearTimer(this.#candidateTimer);
      this.#candidateTimer = null;
    }
    for (const [id, record] of this.#frames) {
      if (record.expiresAtMs <= now) {
        overwrite(record.bytes);
        clearTimer(this.#frameTimers.get(id));
        this.#frameTimers.delete(id);
        this.#frames.delete(id);
        framesChanged = true;
      }
    }
    if (framesChanged) {
      const latest = [...this.#frames.values()].at(-1);
      this.#state = {
        ...this.#state,
        retainedBytes: retainedBytes(this.#frames),
        lastFrameAt: latest?.value.capturedAt ?? null,
      };
    }
    if (
      this.#active?.pausedUntilMs !== null &&
      this.#active?.pausedUntilMs !== undefined &&
      this.#active.pausedUntilMs <= now
    ) {
      void this.#stopActive("source_expired");
    }
  }

  #setState(value: CaptureStateV1): boolean {
    this.#state = value;
    this.#notifyIndicator();
    return this.#emit({ schemaVersion: 1, kind: "state", value: this.#snapshot() });
  }

  #notifyIndicator(): void {
    try {
      this.#indicator?.(this.#snapshot());
    } catch {
      // Indicator failures never widen capture authority or interrupt cleanup.
    }
  }

  #snapshot(): CaptureStateV1 {
    return { ...this.#state };
  }

  #emit(event: CaptureEventV1): boolean {
    try {
      return this.#listener?.(event) !== false;
    } catch {
      return false;
    }
  }
}

function validateSourcesInput(value: unknown): CaptureSourcesInput | null {
  if (!plainExact(value, ["sessionId", "sourceKind"])) return null;
  return validSessionId(value.sessionId) &&
    (value.sourceKind === "display" || value.sourceKind === "window")
    ? (value as CaptureSourcesInput)
    : null;
}

function validateStartInput(value: unknown): CaptureStartInput | null {
  if (!plainExact(value, ["sessionId", "candidateId", "region"])) return null;
  if (
    !validSessionId(value.sessionId) ||
    typeof value.candidateId !== "string" ||
    !idPattern.test(value.candidateId)
  )
    return null;
  if (value.region === null) return value as CaptureStartInput;
  if (!plainExact(value.region, ["xBps", "yBps", "widthBps", "heightBps"])) return null;
  return [
    value.region.xBps,
    value.region.yBps,
    value.region.widthBps,
    value.region.heightBps,
  ].every((part) => typeof part === "number" && Number.isFinite(part) && Number.isInteger(part))
    ? (value as CaptureStartInput)
    : null;
}

function validRegion(value: unknown): value is CaptureRegionV1 | null {
  if (value === null) return true;
  if (!plainExact(value, ["xBps", "yBps", "widthBps", "heightBps"])) return false;
  const region = value as Record<string, unknown>;
  return (
    basis(region.xBps, true) &&
    basis(region.yBps, true) &&
    basis(region.widthBps, false) &&
    basis(region.heightBps, false) &&
    Number(region.xBps) + Number(region.widthBps) <= 10_000 &&
    Number(region.yBps) + Number(region.heightBps) <= 10_000
  );
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function plainExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function basis(value: unknown, zeroAllowed: boolean): boolean {
  return (
    Number.isInteger(value) && Number(value) <= 10_000 && Number(value) >= (zeroAllowed ? 0 : 1)
  );
}

function candidatePreview(
  image: NativeImage,
): { bytes: Buffer; width: number; height: number } | null {
  let bytes: Buffer | null = null;
  try {
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    const ratio = Math.min(1, 480 / size.width, 270 / size.height);
    const width = Math.max(1, Math.floor(size.width * ratio));
    const height = Math.max(1, Math.floor(size.height * ratio));
    const resized = image.resize({ width, height, quality: "good" });
    bytes = resized.toJPEG(60);
    if (bytes.length === 0 || bytes.length > maxCandidatePreviewBytes || !jpeg(bytes)) {
      overwrite(bytes);
      return null;
    }
    const decoded = nativeImage.createFromBuffer(bytes);
    const decodedSize = decoded.getSize();
    if (decoded.isEmpty() || decodedSize.width !== width || decodedSize.height !== height) {
      overwrite(bytes);
      return null;
    }
    return { bytes, width, height };
  } catch {
    if (bytes) overwrite(bytes);
    return null;
  }
}

function validNativeSource(value: CaptureNativeSource): boolean {
  return (
    typeof value.nativeId === "string" &&
    value.nativeId.length > 0 &&
    Buffer.byteLength(value.nativeId, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value.nativeId) &&
    typeof value.label === "string" &&
    value.thumbnail !== null &&
    typeof value.thumbnail === "object"
  );
}

function safeLabel(value: string, kind: CaptureSourceKind, index: number): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const withoutPaths = withoutControls
    .replace(/file:(?:\/\/)?[^)\]}"'`,;]+/giu, "[path]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^)\]}"'`,;]+/gu, "[path]")
    .replace(/(^|[\s([{'"`])(\/[^)\]}"'`,;]+)/gu, "$1[path]");
  const compact = withoutPaths.replace(/\s+/gu, " ").trim();
  const fallback = `${kind === "display" ? "Display" : "Window"} ${index}`;
  return truncateUtf8(compact || fallback, 128) || fallback;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

function activeCapture(
  captureId: string,
  generation: number,
  candidate: CandidateRecord,
  region: CaptureRegionV1 | null,
): ActiveCapture {
  return {
    captureId,
    generation,
    sessionId: candidate.sessionId,
    sessionGeneration: candidate.sessionGeneration,
    nativeSourceId: candidate.nativeId,
    sourceKind: candidate.value.sourceKind,
    publicSourceKind: region ? "region" : candidate.value.sourceKind,
    sourceLabel: candidate.value.label,
    scaleFactor: candidate.value.scaleFactor,
    region: region ? { ...region } : null,
    worker: null,
    startup: null,
    cleanup: null,
    ready: deferred(),
    configured: deferred(),
    streamReady: deferred(),
    firstFrame: deferred(),
    terminal: terminalSignal(),
    sourceWidth: null,
    sourceHeight: null,
    pausedUntilMs: null,
    startReason: "user_started",
    phase: "created",
    acceptEvents: true,
    grantSource: null,
  };
}

function workerConfig(active: ActiveCapture): CaptureWorkerConfigV1 {
  return {
    schemaVersion: 1,
    kind: "configure",
    captureId: active.captureId,
    generation: active.generation,
    region: active.region,
    cadenceMs: 2000,
    maxWidth: 1920,
    maxHeight: 1080,
    jpegQuality: 0.8,
    maxBytes: 2_097_152,
  };
}

function startingState(
  active: ActiveCapture,
  permission: CapturePermissionV1,
  now: number,
  previous: CaptureStateV1,
): CaptureStateV1 {
  return {
    schemaVersion: 1,
    state: "starting",
    reason: active.startReason,
    permission,
    captureId: active.captureId,
    sessionId: active.sessionId,
    sourceKind: active.publicSourceKind,
    parentSourceKind: active.sourceKind,
    sourceLabel: active.sourceLabel,
    scaleFactor: active.scaleFactor,
    startedAt: active.startReason === "user_resumed" ? previous.startedAt : iso(now),
    pausedAt: null,
    capturedFrames: active.startReason === "user_resumed" ? previous.capturedFrames : 0,
    droppedFrames: active.startReason === "user_resumed" ? previous.droppedFrames : 0,
    retainedBytes: 0,
    lastFrameAt: null,
  };
}

function idleState(permission: CapturePermissionV1): CaptureStateV1 {
  return {
    schemaVersion: 1,
    state: "idle",
    reason: "ready",
    permission,
    captureId: null,
    sessionId: null,
    sourceKind: null,
    parentSourceKind: null,
    sourceLabel: null,
    scaleFactor: null,
    startedAt: null,
    pausedAt: null,
    capturedFrames: 0,
    droppedFrames: 0,
    retainedBytes: 0,
    lastFrameAt: null,
  };
}

function blockedState(
  reason: CaptureStateReasonV1,
  permission: CapturePermissionV1,
): CaptureStateV1 {
  return { ...idleState(permission), state: "blocked", reason };
}

function failedState(reason: string, permission: CapturePermissionV1): CaptureStateV1 {
  const allowed: CaptureStateReasonV1[] = [
    "source_enumeration_failed",
    "source_timeout",
    "region_invalid",
    "worker_failed",
    "frame_invalid",
    "frame_too_large",
    "worker_timeout",
    "internal_error",
  ];
  return {
    ...idleState(permission),
    state: "failed",
    reason: allowed.includes(reason as CaptureStateReasonV1)
      ? (reason as CaptureStateReasonV1)
      : "worker_failed",
  };
}

function cropSize(region: CaptureRegionV1 | null, width: number, height: number) {
  if (!region) return { width, height };
  const left = Math.floor((region.xBps * width) / 10_000);
  const top = Math.floor((region.yBps * height) / 10_000);
  const right = Math.ceil(((region.xBps + region.widthBps) * width) / 10_000);
  const bottom = Math.ceil(((region.yBps + region.heightBps) * height) / 10_000);
  return { width: right - left, height: bottom - top };
}

function outputSize(region: CaptureRegionV1 | null, width: number, height: number) {
  const crop = cropSize(region, width, height);
  const ratio = Math.min(1, 1920 / crop.width, 1080 / crop.height);
  return {
    width: Math.max(1, Math.floor(crop.width * ratio)),
    height: Math.max(1, Math.floor(crop.height * ratio)),
  };
}

function unavailablePlatform(): CapturePlatform {
  return {
    platform: process.platform,
    permission: () => (process.platform === "darwin" ? "unknown" : "unsupported"),
    sources: async () => {
      throw new Error("capture platform unavailable");
    },
    createWorker: async () => {
      throw new Error("capture worker unavailable");
    },
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function terminalSignal(): TerminalSignal {
  let resolve!: (reason: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class CaptureFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CaptureFailure(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForActive<T>(
  promise: Promise<T>,
  terminal: TerminalSignal,
  timeoutMs: number,
): Promise<T> {
  return deadline(
    Promise.race([
      promise,
      terminal.promise.then((reason) => {
        throw new CaptureFailure(reason);
      }),
    ]),
    timeoutMs,
    "worker_timeout",
  );
}

function errorCode(error: unknown): string {
  return error instanceof CaptureFailure ? error.code : "worker_failed";
}

function revalidationFailure(
  reason: "source_enumeration_failed" | "source_timeout",
): ClientResult<never> {
  return reason === "source_timeout"
    ? failure("capture_source_timeout", "Capture source revalidation timed out.")
    : failure("capture_source_unavailable", "Capture source revalidation failed.");
}

async function safelyStop(worker: CaptureWorkerController | null): Promise<void> {
  try {
    if (worker) await deadline(worker.stop(), workerDeadlineMs, "worker_timeout");
  } catch {
    // Cleanup stays fail-closed even when the platform worker rejects stop.
  }
}

function workerFailure(code: string): ClientResult<never> {
  if (code === "worker_timeout") {
    return failure("capture_worker_timeout", "Capture worker timed out.");
  }
  if (code === "region_invalid") {
    return failure("capture_region_too_small", "Capture region is too small.");
  }
  if (code === "permission_denied") {
    return failure("capture_permission_denied", "Screen recording permission was denied.");
  }
  if (code === "permission_restricted") {
    return failure("capture_permission_restricted", "Screen recording permission is restricted.");
  }
  if (code === "permission_required") {
    return failure("capture_permission_required", "Screen recording permission is required.");
  }
  if (code === "permission_unknown") {
    return failure("capture_permission_unknown", "Screen recording permission is unavailable.");
  }
  if (code === "frame_invalid") {
    return failure("capture_frame_invalid", "Capture frame is invalid.");
  }
  if (code === "frame_too_large") {
    return failure("capture_frame_too_large", "Capture frame is too large.");
  }
  if (code === "source_timeout") {
    return failure("capture_source_timeout", "Capture source revalidation timed out.");
  }
  if (code === "source_enumeration_failed") {
    return failure("capture_source_unavailable", "Capture source revalidation failed.");
  }
  if (code === "internal_error") {
    return failure("capture_internal_error", "Capture event delivery failed.");
  }
  return failure("capture_worker_failed", "Capture worker failed.");
}

function opaqueId(): string {
  return randomBytes(24).toString("hex");
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function jpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function overwrite(bytes: Uint8Array): void {
  bytes.fill(0);
}

function retainedBytes(records: Map<string, FrameRecord>): number {
  let total = 0;
  for (const record of records.values()) total += record.bytes.length;
  return total;
}

function finitePositive(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function permissionReason(permission: CapturePermissionV1): CaptureStateReasonV1 {
  if (permission === "denied") return "permission_denied";
  if (permission === "restricted") return "permission_restricted";
  if (permission === "not_determined") return "permission_required";
  if (permission === "unsupported") return "unsupported";
  return "permission_unknown";
}

function isFrameLike(value: unknown): value is { bytes: Uint8Array } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { bytes?: unknown }).bytes instanceof Uint8Array
  );
}

function schedule(delayMs: number, action: () => void): NodeJS.Timeout {
  const timer = setTimeout(action, delayMs);
  timer.unref();
  return timer;
}

function clearTimer(timer: NodeJS.Timeout | null | undefined): void {
  if (timer) clearTimeout(timer);
}

function success<T>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function failure<T = never>(code: string, message: string): ClientResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: false, retryAfterMs: null },
  };
}
