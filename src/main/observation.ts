import type {
  CaptureEventV1,
  CaptureFrameV1,
  ClientResult,
  ErrorV1,
  InferenceUsageV1,
  MediaAttachmentV1,
  ObservationConfigureInput,
  ObservationCountersV1,
  ObservationFrameFactV1,
  ObservationReasonV1,
  ObservationStatusV1,
  ObservationTriggerV1,
  TurnCancelInput,
  TurnEventV1,
  TurnSubmitInput,
  TurnSubmitValue,
} from "../shared/contracts.js";
import type { CaptureService } from "./capture.js";
import type { MediaService } from "./media.js";

export type ObservationReason = ObservationReasonV1;

export type ObservationUploadInput = {
  sessionId: string;
  reason: ObservationReason;
  signal: AbortSignal;
};

export type ObservationUploadValue = {
  frame: CaptureFrameV1;
  attachment: MediaAttachmentV1;
  reason: ObservationReason;
};

export type ObservationPreparedTurn = {
  token: symbol;
  input: TurnSubmitInput;
};

export type ObservationTurnOwner = {
  dispatch(
    prepared: ObservationPreparedTurn,
    deliver: (event: TurnEventV1) => boolean,
  ): Promise<ClientResult<TurnSubmitValue>>;
  cancel(input: TurnCancelInput): Promise<ClientResult<unknown>>;
};

type ActiveUpload = {
  generation: number;
  frame: CaptureFrameV1;
  controller: AbortController;
  done: Promise<void>;
  settle(): void;
};

type ManualTurnAdmission = {
  admitted: boolean;
  token: symbol | null;
};

type PendingCleanup = {
  sessionId: string;
  mediaId: string;
};

type ActiveTurn = {
  token: symbol;
  sessionId: string;
  mediaId: string;
  frame: CaptureFrameV1;
  reason: ObservationReason;
  generation: number;
  automatic: boolean;
  started: boolean;
  traceId: string | null;
  cancel: ObservationTurnOwner["cancel"] | null;
  cancelRequested: boolean;
  usage: InferenceUsageV1;
  terminal: Promise<void>;
  settleTerminal(): void;
  admitted: Promise<void>;
  settleAdmission(): void;
  responseErrors: ErrorV1[];
  turnError: ErrorV1 | null;
  cancelTarget: "idle" | "ready" | null;
};

type ObservationState = ObservationStatusV1["state"];
type RateBuckets = { seconds: number[]; values: number[] };
type AutomaticReason = Exclude<ObservationReason, "user_send">;

const reasons = new Set<ObservationReason>([
  "initial",
  "user_send",
  "change",
  "post_action",
  "watch",
]);
const triggers = new Set<ObservationTriggerV1>(["changes", "interval"]);

export class ObservationService {
  readonly #capture: CaptureService;
  readonly #media: MediaService;
  readonly #now: () => number;
  #selectedSessionId: string | null = null;
  #pendingSessionId: string | null = null;
  #generation = 0;
  #acceptFrames = false;
  #pending: CaptureFrameV1 | null = null;
  #pendingReason: AutomaticReason | null = null;
  #active: ActiveUpload | null = null;
  #pendingCleanup: PendingCleanup | null = null;
  #lastAutomaticHash: string | null = null;
  #lastAutomaticCapturedAt: number | null = null;
  #lastInferenceStartedAt: number | null = null;
  #turn: ActiveTurn | null = null;
  #turnOwner: ObservationTurnOwner | null = null;
  #automaticAdmission: { token: symbol; sessionId: string } | null = null;
  #manualTurns = new Map<string, symbol>();
  #usage = unavailableUsage();
  #watchEnabled = false;
  #trigger: ObservationTriggerV1 | null = null;
  #instruction: string | null = null;
  #state: ObservationState = "idle";
  #currentReason: ObservationReason | null = null;
  #selectedFrame: ObservationFrameFactV1 | null = null;
  #sentFrame: ObservationFrameFactV1 | null = null;
  #lastError: ErrorV1 | null = null;
  #updatedAt: string;
  #counters = emptyCounters();
  #captureRates = emptyBuckets();
  #inferenceRates = emptyBuckets();
  #listener: ((status: ObservationStatusV1) => boolean) | null = null;
  #turnListener: ((event: TurnEventV1) => boolean) | null = null;
  #stopPromise: Promise<ClientResult<ObservationStatusV1>> | null = null;
  #policyTimer: ReturnType<typeof setTimeout> | null = null;
  #drainQueued = false;

  constructor(capture: CaptureService, media: MediaService, now: () => number = Date.now) {
    this.#capture = capture;
    this.#media = media;
    this.#now = now;
    this.#updatedAt = isoNow(now);
  }

  setListener(
    listener: ((status: ObservationStatusV1) => boolean) | null,
    turnListener: ((event: TurnEventV1) => boolean) | null = null,
  ): void {
    this.#listener = listener;
    this.#turnListener = turnListener;
  }

  status(): ClientResult<ObservationStatusV1> {
    return { ok: true, value: this.#snapshot() };
  }

  configure(input: ObservationConfigureInput): ClientResult<ObservationStatusV1> {
    const validated = validateConfigureInput(input);
    if (!validated.ok) return validated;
    if (validated.value.sessionId !== this.#selectedSessionId) {
      return failure("observation_wrong_session", "Observation session changed.");
    }
    if (
      this.#instruction === validated.value.instruction &&
      this.#trigger === validated.value.trigger &&
      this.#watchEnabled
    ) {
      return this.status();
    }
    if (["selecting", "uploading", "inferencing", "stopping"].includes(this.#state)) {
      return failure(
        "observation_backpressure",
        "Observation is waiting for the active turn.",
        true,
        1000,
      );
    }
    if (this.#state === "failed") {
      return { ok: false, error: this.#lastError ?? fixedError("observation_cleanup_failed") };
    }
    this.#generation += 1;
    this.#clearPolicyTimer();
    this.#pending = null;
    this.#pendingReason = null;
    this.#instruction = validated.value.instruction;
    this.#trigger = validated.value.trigger;
    this.#watchEnabled = true;
    this.#lastAutomaticHash = null;
    this.#lastAutomaticCapturedAt = null;
    this.#lastInferenceStartedAt = null;
    this.#state = "waiting";
    this.#currentReason = null;
    this.#lastError = null;
    this.#publish();
    if (validated.value.trigger === "interval") this.#armInterval();
    return this.status();
  }

  async activateSession(sessionId: string): Promise<void> {
    if (!validSessionId(sessionId)) return;
    if (sessionId === this.#selectedSessionId && this.#pendingSessionId === null) {
      await this.#retryCleanup();
      this.#acceptFrames = true;
      this.#publish();
      return;
    }
    const active = this.#fenceAdmission();
    const generation = this.#generation;
    this.#pendingSessionId = sessionId;
    this.#lastAutomaticHash = null;
    this.#lastAutomaticCapturedAt = null;
    this.#lastInferenceStartedAt = null;
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    if (active || this.#turn) {
      this.#state = "stopping";
      this.#currentReason = null;
      this.#publish();
    }
    if (active) await active.done;
    await this.#stopTurn("ready");
    await this.#retryCleanup();
    if (generation !== this.#generation || this.#pendingSessionId !== sessionId) return;
    if (!this.#turn) this.#activatePendingSession();
  }

  async fenceSession(sessionId: string): Promise<void> {
    if (
      !validSessionId(sessionId) ||
      (sessionId !== this.#selectedSessionId && sessionId !== this.#pendingSessionId)
    )
      return;
    const active = this.#fenceAdmission();
    this.#pendingSessionId = null;
    this.#lastAutomaticHash = null;
    this.#usage = unavailableUsage();
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    this.#state = "stopping";
    this.#currentReason = null;
    if (active) await active.done;
    await this.#stopTurn("idle");
    await this.#retryCleanup();
    if (this.#turn) return;
    this.#selectedSessionId = null;
    this.#resetPublicSession("idle");
    this.#publish();
  }

  stop(): Promise<ClientResult<ObservationStatusV1>> {
    if (this.#stopPromise) return this.#stopPromise;
    if (
      !this.#watchEnabled &&
      !this.#active &&
      !this.#turn &&
      !this.#pendingCleanup &&
      (this.#state === "idle" || this.#state === "ready")
    ) {
      return Promise.resolve(this.status());
    }
    const stopping = this.#stopOnce();
    this.#stopPromise = stopping;
    const clear = () => {
      if (this.#stopPromise === stopping) this.#stopPromise = null;
    };
    void stopping.then(clear, clear);
    return stopping;
  }

  async #stopOnce(): Promise<ClientResult<ObservationStatusV1>> {
    const active = this.#fenceAdmission();
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    this.#state = active || this.#turn ? "stopping" : this.#selectedSessionId ? "ready" : "idle";
    this.#currentReason = null;
    this.#publish();
    if (active) await active.done;
    await this.#stopTurn(this.#selectedSessionId ? "ready" : "idle");
    if (!(await this.#retryCleanup())) {
      this.#setFailure(fixedError("observation_cleanup_failed"));
      return { ok: false, error: fixedError("observation_cleanup_failed") };
    }
    if (this.#selectedSessionId !== null) this.#acceptFrames = true;
    if (!this.#turn) {
      this.#state = this.#selectedSessionId ? "ready" : "idle";
      this.#selectedFrame = null;
      this.#sentFrame = null;
      this.#lastError = null;
      this.#publish();
    }
    return this.status();
  }

  async close(): Promise<void> {
    const active = this.#fenceAdmission();
    this.#pendingSessionId = null;
    this.#lastAutomaticHash = null;
    this.#usage = unavailableUsage();
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    this.#state = "stopping";
    this.#listener = null;
    if (active) await active.done;
    await this.#stopTurn("idle");
    await this.#retryCleanup();
    this.#selectedSessionId = null;
    this.#resetPublicSession("idle");
  }

  async prepareManualTurn(input: TurnSubmitInput): Promise<ClientResult<ObservationPreparedTurn>> {
    return this.#prepareTurn(input, "user_send", false, null);
  }

  validateManualTurn(input: TurnSubmitInput): ClientResult<{ ready: true }> {
    if ((input.attachmentIds?.length ?? 0) > 3) {
      return failure(
        "observation_attachment_limit",
        "Remove an attachment before including the current view.",
      );
    }
    return { ok: true, value: { ready: true } };
  }

  connectTurnOwner(owner: ObservationTurnOwner): void {
    if (this.#turnOwner) throw new Error("observation turn owner already connected");
    this.#turnOwner = owner;
  }

  usage(): InferenceUsageV1 {
    return { ...this.#usage };
  }

  beginManualTurn(sessionId: string): ManualTurnAdmission {
    if (sessionId !== this.#selectedSessionId) return { admitted: true, token: null };
    if (this.#manualTurns.has(sessionId)) return { admitted: false, token: null };
    const token = Symbol("manual-turn");
    this.#manualTurns.set(sessionId, token);
    return { admitted: true, token };
  }

  endManualTurn(token: symbol | null): void {
    if (token === null) return;
    for (const [sessionId, activeToken] of this.#manualTurns) {
      if (activeToken !== token) continue;
      this.#manualTurns.delete(sessionId);
      return;
    }
  }

  async dispatchAutomaticTurn(
    input: { sessionId: string; message: string; reason: Exclude<ObservationReason, "user_send"> },
    deliver: (event: TurnEventV1) => boolean,
  ): Promise<ClientResult<TurnSubmitValue>> {
    if (input.sessionId !== this.#selectedSessionId) {
      return failure("observation_wrong_session", "Observation session changed.");
    }
    if (!this.#watchEnabled || this.#instruction !== input.message) {
      return failure("invalid_request", "Observation request is invalid.");
    }
    const owner = this.#turnOwner;
    if (!owner) {
      return failure("daemon_unavailable", "The local OpenMinion daemon is not ready.", true);
    }
    const prepared = await this.#prepareTurn(
      {
        sessionId: input.sessionId,
        message: input.message,
        observation: { includeCurrentView: true },
      },
      input.reason,
      true,
      (request) => owner.cancel(request),
    );
    if (!prepared.ok) return prepared;
    try {
      return await owner.dispatch(prepared.value, deliver);
    } catch {
      return this.settleSubmission(
        prepared.value,
        failure("daemon_unavailable", "The local OpenMinion daemon is not ready.", true),
      );
    }
  }

  acceptPolicySignal(reason: "post_action"): void {
    if (!this.#watchEnabled || !this.#pending || reason !== "post_action") return;
    this.#markAutomatic(reason);
  }

  acceptTurnEvent(prepared: ObservationPreparedTurn, event: TurnEventV1): boolean {
    const active = this.#activeTurn(prepared);
    if (!active || event.sessionId !== active.sessionId) return false;
    const deliver =
      this.#selectedSessionId === active.sessionId &&
      this.#pendingSessionId === null &&
      active.cancelTarget !== "idle" &&
      (!active.automatic || active.generation === this.#generation);
    if (event.kind === "started") {
      if (active.started) return false;
      active.started = true;
      active.traceId = event.traceId;
      active.usage = unavailableUsage();
      active.responseErrors = [];
      active.turnError = null;
      if (this.#selectedSessionId === active.sessionId) {
        this.#usage = unavailableUsage();
        const sentAt = isoNow(this.#now);
        this.#sentFrame = frameFact(
          active.frame,
          active.reason,
          this.#selectedFrame?.selectedAt ?? sentAt,
          sentAt,
          event.traceId,
        );
        this.#selectedFrame = this.#sentFrame;
        this.#state = active.generation !== this.#generation ? "stopping" : "inferencing";
        this.#currentReason = active.reason;
        if (active.automatic) {
          this.#lastAutomaticHash = active.frame.contentHash;
          this.#lastAutomaticCapturedAt = Date.parse(active.frame.capturedAt);
          this.#lastInferenceStartedAt = this.#now();
        }
        if (
          !this.#increment("sentFrames", 1) ||
          !this.#increment("inferencesStarted", 1) ||
          !this.#recordRate(this.#inferenceRates)
        ) {
          this.#setFailure(fixedError("observation_accounting_failed"));
          return false;
        }
        this.#publish();
      }
      active.settleAdmission();
      if (active.automatic && active.generation !== this.#generation) {
        void this.#cancelActive(active, active.cancelTarget ?? "ready");
      }
      return deliver;
    }
    if (!active.started || event.traceId !== active.traceId) return false;
    if (event.kind === "response") {
      active.usage = { ...event.usage };
      active.responseErrors = [...event.errors];
      if (this.#selectedSessionId === active.sessionId) {
        this.#usage = { ...event.usage };
        this.#publish();
      }
      return deliver;
    }
    if (event.kind === "error") {
      active.turnError = { ...event.error };
      return deliver;
    }
    if (event.kind !== "done") return deliver;
    if (this.#selectedSessionId === active.sessionId) {
      const counter =
        event.outcome === "complete"
          ? "inferencesCompleted"
          : event.outcome === "cancelled"
            ? "inferencesCancelled"
            : "inferencesFailed";
      if (!this.#increment(counter, 1)) {
        this.#setFailure(fixedError("observation_accounting_failed"));
      } else if (active.cancelTarget) {
        this.#watchEnabled = false;
        this.#trigger = null;
        this.#instruction = null;
        this.#state = active.cancelTarget;
        this.#lastError = null;
      } else if (event.outcome === "complete") {
        this.#state = this.#watchEnabled ? "waiting" : "ready";
        this.#lastError = null;
      } else if (active.automatic) {
        this.#watchEnabled = false;
        this.#trigger = null;
        this.#instruction = null;
        const terminalCode =
          event.outcome === "cancelled"
            ? active.responseErrors.some((error) => error.code === "cancelled")
              ? "observation_turn_cancelled"
              : "invalid_daemon_response"
            : Boolean(active.responseErrors.length) === Boolean(active.turnError)
              ? "invalid_daemon_response"
              : active.responseErrors.length
                ? "observation_turn_failed"
                : "observation_stream_failed";
        this.#setFailure(fixedError(terminalCode));
      } else {
        this.#state = "ready";
        this.#lastError = null;
      }
    }
    active.settleTerminal();
    if (this.#turn === active) this.#turn = null;
    if (this.#activatePendingSession()) return deliver;
    if (active.cancelTarget === "idle") {
      this.#selectedSessionId = null;
      this.#resetPublicSession("idle");
      this.#publish();
    } else if (this.#selectedSessionId === active.sessionId) {
      this.#publish();
      this.#queueAutomaticDrain();
    }
    return deliver;
  }

  async settleSubmission(
    prepared: ObservationPreparedTurn,
    result: ClientResult<TurnSubmitValue>,
  ): Promise<ClientResult<TurnSubmitValue>> {
    const active = this.#activeTurn(prepared);
    if (!active) return result;
    if (result.ok) {
      if (
        !active.started ||
        result.value.sessionId !== active.sessionId ||
        result.value.traceId !== active.traceId
      ) {
        active.settleAdmission();
        active.settleTerminal();
        if (this.#turn === active) this.#turn = null;
        if (!(await this.#clearUploadedMedia(active.sessionId, active.mediaId))) {
          this.#setFailure(fixedError("observation_cleanup_failed"));
          return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
        }
        this.#setFailure(fixedError("invalid_daemon_response"));
        return failure("invalid_daemon_response", "The daemon returned an invalid response.");
      }
      return result;
    }
    active.settleAdmission();
    if (result.error.code === "submission_ambiguous") {
      this.#setFailure(fixedError("submission_ambiguous"));
      return result;
    }
    active.settleTerminal();
    if (this.#turn === active) this.#turn = null;
    if (!(await this.#clearUploadedMedia(active.sessionId, active.mediaId))) {
      this.#setFailure(fixedError("observation_cleanup_failed"));
      return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
    }
    if (this.#selectedSessionId === active.sessionId) {
      this.#applyAdmissionFailure(result.error, active.automatic);
    }
    return result;
  }

  validatePreparedTurn(prepared: ObservationPreparedTurn): ClientResult<{ ready: true }> {
    const active = this.#activeTurn(prepared);
    if (!active || active.sessionId !== this.#selectedSessionId) {
      return failure("observation_wrong_session", "Observation session changed.");
    }
    if (active.generation !== this.#generation) return this.#leaseFailure(active.frame);
    if (!this.#capture.hasFrameForObservation(frameIdentity(active.frame))) {
      return this.#leaseFailure(active.frame);
    }
    return { ok: true, value: { ready: true } };
  }

  async preemptAutomaticForManual(sessionId: string, preserveFrame = false): Promise<boolean> {
    if (sessionId === this.#selectedSessionId && this.#pendingReason !== null) {
      this.#pendingReason = null;
      if (!preserveFrame) this.#pending = null;
      if (this.#trigger === "changes") this.#clearPolicyTimer();
    }
    const admission = this.#automaticAdmission;
    if (admission?.sessionId === sessionId) {
      const upload = this.#active;
      if (preserveFrame && upload) this.#pending ??= { ...upload.frame };
      this.#generation += 1;
      if (!preserveFrame) this.#pending = null;
      this.#pendingReason = null;
      upload?.controller.abort();
      if (this.#automaticAdmission === admission) this.#automaticAdmission = null;
      if (upload) await upload.done;
    }
    const active = this.#turn;
    if (!active?.automatic || active.sessionId !== sessionId) return true;
    if (preserveFrame) this.#pending ??= { ...active.frame };
    if (active.generation === this.#generation) {
      this.#generation += 1;
      if (!preserveFrame) this.#pending = null;
      this.#pendingReason = null;
    }
    await this.#cancelActive(active, "ready");
    return waitFor(active.terminal, 5000);
  }

  acceptCaptureEvent(event: CaptureEventV1): void {
    if (event.kind === "state") {
      if (
        event.value.state !== "observing" &&
        (event.value.sessionId === null || event.value.sessionId === this.#selectedSessionId)
      ) {
        void this.stop();
      }
      return;
    }
    if (!this.#acceptFrames || event.sessionId !== this.#selectedSessionId) return;
    if (
      !this.#increment("captureFrames", 1) ||
      !this.#increment("captureBytes", event.sizeBytes) ||
      !this.#recordRate(this.#captureRates)
    ) {
      this.#setFailure(fixedError("observation_accounting_failed"));
      return;
    }
    if (
      this.#pending &&
      this.#pending.frameId !== event.frameId &&
      !this.#increment("replacedPending", 1)
    ) {
      this.#setFailure(fixedError("observation_accounting_failed"));
      return;
    }
    this.#pending = { ...event };
    this.#publish();
    if (!this.#watchEnabled) return;
    if (this.#lastAutomaticHash === null) {
      this.#markAutomatic("initial");
    } else if (this.#trigger === "changes") {
      if (event.contentHash === this.#lastAutomaticHash && this.#pendingReason !== "post_action") {
        this.#pendingReason = null;
        this.#skipUnchanged();
      } else {
        this.#markAutomatic("change");
      }
    }
  }

  async uploadLatestFrame(
    input: ObservationUploadInput,
  ): Promise<ClientResult<ObservationUploadValue>> {
    if (!validUploadInput(input)) {
      return failure("invalid_request", "Observation request is invalid.");
    }
    if (this.#selectedSessionId === null) {
      return failure("observation_session_required", "Select a session before observation.");
    }
    if (input.sessionId !== this.#selectedSessionId) {
      return failure("observation_wrong_session", "Observation session changed.");
    }
    if (this.#active) {
      return failure(
        "observation_backpressure",
        "Observation is waiting for the active turn.",
        true,
        1000,
      );
    }
    if (this.#pendingCleanup) {
      return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
    }
    const descriptor = this.#pending;
    if (!descriptor) {
      return this.#captureUnavailable();
    }
    if (input.reason !== "user_send" && descriptor.contentHash === this.#lastAutomaticHash) {
      if (!this.#increment("skippedUnchanged", 1)) {
        this.#setFailure(fixedError("observation_accounting_failed"));
        return failure(
          "observation_accounting_failed",
          "Observation accounting could not be updated.",
        );
      }
      this.#publish();
      return failure("observation_frame_unavailable", "The selected frame is no longer available.");
    }

    if (this.#pending?.frameId === descriptor.frameId) this.#pending = null;
    this.#currentReason = input.reason;
    this.#selectedFrame = frameFact(descriptor, input.reason, isoNow(this.#now), null, null);
    this.#sentFrame = null;
    this.#state = "uploading";
    this.#lastError = null;
    if (!this.#increment("selectedFrames", 1)) {
      this.#setFailure(fixedError("observation_accounting_failed"));
      return failure(
        "observation_accounting_failed",
        "Observation accounting could not be updated.",
      );
    }
    this.#publish();
    const active = activeUpload(this.#generation, descriptor);
    this.#active = active;
    const abort = () => active.controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      const identity = frameIdentity(descriptor);
      const lease = this.#capture.acquireFrameForObservation(identity);
      if (!lease) return this.#leaseFailure(descriptor);
      let uploaded: ClientResult<MediaAttachmentV1>;
      try {
        uploaded = await this.#media.uploadCapturedFrame({
          sessionId: input.sessionId,
          frame: lease.frame,
          bytes: lease.bytes,
          signal: active.controller.signal,
        });
      } finally {
        lease.bytes.fill(0);
      }

      const serviceCurrent = this.#current(active, input.sessionId);
      const frameCurrent = this.#capture.hasFrameForObservation(identity);
      if (!serviceCurrent || !frameCurrent) {
        if (
          uploaded.ok &&
          !(await this.#clearUploadedMedia(input.sessionId, uploaded.value.mediaId))
        ) {
          return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
        }
        if (serviceCurrent) return this.#leaseFailure(descriptor);
        return this.#selectedSessionId === input.sessionId && this.#pendingSessionId === null
          ? failure("observation_frame_unavailable", "The selected frame is no longer available.")
          : failure("observation_wrong_session", "Observation session changed.");
      }
      if (!uploaded.ok) return normalizeUploadFailure(uploaded.error);
      if (!this.#increment("uploadedBytes", descriptor.sizeBytes)) {
        if (!(await this.#clearUploadedMedia(input.sessionId, uploaded.value.mediaId))) {
          this.#setFailure(fixedError("observation_cleanup_failed"));
          return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
        }
        this.#setFailure(fixedError("observation_accounting_failed"));
        return failure(
          "observation_accounting_failed",
          "Observation accounting could not be updated.",
        );
      }
      this.#state = "selecting";
      this.#publish();
      return {
        ok: true,
        value: { frame: { ...lease.frame }, attachment: uploaded.value, reason: input.reason },
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
      active.settle();
      if (this.#active === active) this.#active = null;
    }
  }

  async #prepareTurn(
    input: TurnSubmitInput,
    reason: ObservationReason,
    automatic: boolean,
    cancel: ObservationTurnOwner["cancel"] | null,
  ): Promise<ClientResult<ObservationPreparedTurn>> {
    if (this.#turn) {
      return failure(
        "observation_backpressure",
        "Observation is waiting for the active turn.",
        true,
        1000,
      );
    }
    if (this.#automaticAdmission) {
      return failure(
        "observation_backpressure",
        "Observation is waiting for the active turn.",
        true,
        1000,
      );
    }
    const validManualTurn = this.validateManualTurn(input);
    if (!validManualTurn.ok) return validManualTurn;
    const generation = this.#generation;
    const admission = automatic
      ? { token: Symbol("automatic-admission"), sessionId: input.sessionId }
      : null;
    if (admission) this.#automaticAdmission = admission;
    let uploaded: ClientResult<ObservationUploadValue>;
    try {
      const controller = new AbortController();
      uploaded = await this.uploadLatestFrame({
        sessionId: input.sessionId,
        reason,
        signal: controller.signal,
      });
    } finally {
      if (admission && this.#automaticAdmission === admission) this.#automaticAdmission = null;
    }
    if (!uploaded.ok) {
      this.#applyAdmissionFailure(uploaded.error, automatic);
      return uploaded;
    }
    if (generation !== this.#generation || input.sessionId !== this.#selectedSessionId) {
      if (!(await this.#clearUploadedMedia(input.sessionId, uploaded.value.attachment.mediaId))) {
        return failure("observation_cleanup_failed", "Observation cleanup did not complete.");
      }
      return failure("observation_wrong_session", "Observation session changed.");
    }
    const token = Symbol("observation-turn");
    this.#turn = activeTurn({
      token,
      sessionId: input.sessionId,
      mediaId: uploaded.value.attachment.mediaId,
      frame: uploaded.value.frame,
      reason,
      generation,
      automatic,
      cancel,
    });
    const attachmentIds = [...(input.attachmentIds ?? []), uploaded.value.attachment.mediaId];
    return {
      ok: true,
      value: {
        token,
        input: { sessionId: input.sessionId, message: input.message, attachmentIds },
      },
    };
  }

  #fenceAdmission(): ActiveUpload | null {
    this.#generation += 1;
    this.#clearPolicyTimer();
    this.#acceptFrames = false;
    this.#pending = null;
    this.#pendingReason = null;
    const active = this.#active;
    active?.controller.abort();
    return active;
  }

  #activeTurn(prepared: ObservationPreparedTurn): ActiveTurn | null {
    return this.#turn?.token === prepared.token ? this.#turn : null;
  }

  async #stopTurn(target: "idle" | "ready"): Promise<void> {
    const active = this.#turn;
    if (!active) return;
    if (active.cancelTarget === null) active.cancelTarget = target;
    if (!active.started) await waitFor(active.admitted, 5000);
    if (active.automatic && active.started) {
      await this.#cancelActive(active, target);
      await waitFor(active.terminal, 5000);
    }
  }

  async #cancelActive(active: ActiveTurn, target: "idle" | "ready"): Promise<void> {
    if (active.cancelTarget === null) active.cancelTarget = target;
    if (active.cancelRequested || !active.cancel || !active.traceId) return;
    active.cancelRequested = true;
    await active.cancel({ sessionId: active.sessionId, traceId: active.traceId });
  }

  #current(active: ActiveUpload, sessionId: string): boolean {
    return (
      this.#active === active &&
      active.generation === this.#generation &&
      this.#selectedSessionId === sessionId &&
      !active.controller.signal.aborted
    );
  }

  #captureUnavailable(): ClientResult<never> {
    const status = this.#capture.status();
    if (!status.ok || status.value.state !== "observing") {
      return failure("observation_capture_inactive", "Start computer observation first.");
    }
    return failure("observation_frame_unavailable", "The selected frame is no longer available.");
  }

  #leaseFailure(descriptor: CaptureFrameV1): ClientResult<never> {
    const status = this.#capture.status();
    if (!status.ok || status.value.state !== "observing") {
      return failure("observation_capture_inactive", "Start computer observation first.");
    }
    if (Date.parse(descriptor.expiresAt) <= this.#now()) {
      return failure("observation_frame_unavailable", "The selected frame is no longer available.");
    }
    return failure("observation_frame_mismatch", "The selected frame changed before use.");
  }

  async #release(sessionId: string, mediaId: string): Promise<boolean> {
    try {
      const released = await this.#media.release({ sessionId, mediaId });
      return (
        released.ok ||
        ["media_not_found", "media_expired", "session_closed", "forbidden"].includes(
          released.error.code,
        )
      );
    } catch {
      return false;
    }
  }

  async #clearUploadedMedia(sessionId: string, mediaId: string): Promise<boolean> {
    if (await this.#release(sessionId, mediaId)) return true;
    this.#pendingCleanup = { sessionId, mediaId };
    return false;
  }

  async #retryCleanup(): Promise<boolean> {
    const pending = this.#pendingCleanup;
    if (!pending) return true;
    if (!(await this.#release(pending.sessionId, pending.mediaId))) return false;
    if (this.#pendingCleanup === pending) this.#pendingCleanup = null;
    return true;
  }

  #snapshot(): ObservationStatusV1 {
    const now = this.#now();
    return {
      schemaVersion: 1,
      sessionId: this.#selectedSessionId,
      watchEnabled: this.#watchEnabled,
      trigger: this.#watchEnabled ? this.#trigger : null,
      state: this.#state,
      currentReason: this.#currentReason,
      selectedFrame: cloneFrameFact(this.#selectedFrame),
      sentFrame: cloneFrameFact(this.#sentFrame),
      counters: { ...this.#counters },
      rates: {
        schemaVersion: 1,
        windowMs: 60_000,
        capturedFrames: rateTotal(this.#captureRates, now),
        inferencesStarted: rateTotal(this.#inferenceRates, now),
        sampledAt: new Date(now).toISOString(),
      },
      usage: { ...this.#usage },
      lastError: this.#lastError ? { ...this.#lastError } : null,
      updatedAt: this.#updatedAt,
    };
  }

  #resetPublicSession(state: "idle" | "ready"): void {
    this.#clearPolicyTimer();
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    this.#state = state;
    this.#currentReason = null;
    this.#selectedFrame = null;
    this.#sentFrame = null;
    this.#lastError = null;
    this.#usage = unavailableUsage();
    this.#counters = emptyCounters();
    this.#captureRates = emptyBuckets();
    this.#inferenceRates = emptyBuckets();
    this.#pendingReason = null;
    this.#lastAutomaticHash = null;
    this.#lastAutomaticCapturedAt = null;
    this.#lastInferenceStartedAt = null;
  }

  #activatePendingSession(): boolean {
    const sessionId = this.#pendingSessionId;
    if (sessionId === null || this.#turn) return false;
    this.#pendingSessionId = null;
    this.#selectedSessionId = sessionId;
    this.#lastAutomaticHash = null;
    this.#acceptFrames = true;
    this.#resetPublicSession("ready");
    this.#publish();
    return true;
  }

  #publish(): void {
    this.#updatedAt = isoNow(this.#now);
    const listener = this.#listener;
    if (!listener) return;
    let delivered = false;
    try {
      delivered = listener(this.#snapshot());
    } catch {
      delivered = false;
    }
    if (!delivered && this.#listener === listener) {
      this.#listener = null;
      this.#turnListener = null;
      void this.stop();
    }
  }

  #setFailure(error: ErrorV1): void {
    this.#clearPolicyTimer();
    this.#pending = null;
    this.#pendingReason = null;
    this.#watchEnabled = false;
    this.#trigger = null;
    this.#instruction = null;
    this.#state = "failed";
    this.#lastError = error;
    this.#publish();
  }

  #applyAdmissionFailure(error: ErrorV1, automatic: boolean): void {
    if (this.#selectedSessionId === null) return;
    const waiting =
      automatic &&
      [
        "observation_capture_inactive",
        "observation_frame_unavailable",
        "observation_backpressure",
        "media_backpressure",
        "session_turn_active",
      ].includes(error.code);
    if (waiting) {
      this.#state = "waiting";
      this.#lastError = { ...error };
      this.#selectedFrame = null;
      this.#sentFrame = null;
      this.#currentReason = null;
      this.#publish();
      return;
    }
    if (
      [
        "observation_frame_mismatch",
        "observation_upload_failed",
        "observation_cleanup_failed",
        "observation_accounting_failed",
        "daemon_unavailable",
        "invalid_daemon_response",
      ].includes(error.code)
    ) {
      this.#setFailure({ ...error });
      return;
    }
    this.#state = this.#watchEnabled ? "waiting" : "ready";
    this.#lastError = null;
    this.#selectedFrame = null;
    this.#sentFrame = null;
    this.#currentReason = null;
    this.#publish();
  }

  #increment(key: keyof Omit<ObservationCountersV1, "schemaVersion">, value: number): boolean {
    if (!Number.isSafeInteger(value) || value < 0) return false;
    const next = this.#counters[key] + value;
    if (!Number.isSafeInteger(next) || next < 0) return false;
    this.#counters[key] = next;
    return true;
  }

  #recordRate(buckets: RateBuckets): boolean {
    const second = Math.floor(this.#now() / 1000);
    const index = ((second % 60) + 60) % 60;
    if (buckets.seconds[index] !== second) {
      buckets.seconds[index] = second;
      buckets.values[index] = 0;
    }
    const next = buckets.values[index] + 1;
    if (!Number.isSafeInteger(next)) return false;
    buckets.values[index] = next;
    return true;
  }

  #markAutomatic(reason: AutomaticReason): void {
    if (!this.#watchEnabled || !this.#pending) return;
    if (this.#pendingReason !== "post_action" || reason === "post_action") {
      this.#pendingReason = reason;
    }
    this.#queueAutomaticDrain();
  }

  #queueAutomaticDrain(): void {
    if (this.#drainQueued) return;
    this.#drainQueued = true;
    queueMicrotask(() => {
      this.#drainQueued = false;
      void this.#drainAutomatic();
    });
  }

  async #drainAutomatic(): Promise<void> {
    const reason = this.#pendingReason;
    const frame = this.#pending;
    const deliver = this.#turnListener;
    if (
      !reason ||
      !frame ||
      !this.#watchEnabled ||
      !this.#instruction ||
      !this.#selectedSessionId ||
      !deliver ||
      !this.#turnOwner
    )
      return;
    if (reason === "change" && this.#lastInferenceStartedAt !== null) {
      const remaining = this.#lastInferenceStartedAt + 5000 - this.#now();
      if (remaining > 0) {
        this.#armPolicyTimer("change", remaining);
        return;
      }
    }
    if (
      reason === "watch" &&
      (frame.contentHash === this.#lastAutomaticHash ||
        (this.#lastAutomaticCapturedAt !== null &&
          Date.parse(frame.capturedAt) <= this.#lastAutomaticCapturedAt))
    ) {
      this.#pendingReason = null;
      this.#skipUnchanged();
      return;
    }
    const busyWithManual =
      (this.#turn !== null && !this.#turn.automatic) ||
      (this.#active !== null && this.#automaticAdmission === null) ||
      (this.#selectedSessionId !== null && this.#manualTurns.has(this.#selectedSessionId));
    if (busyWithManual) {
      this.#pending = null;
      this.#pendingReason = null;
      if (!this.#increment("skippedBusy", 1)) {
        this.#setFailure(fixedError("observation_accounting_failed"));
      } else {
        this.#state = "waiting";
        this.#lastError = fixedError("observation_backpressure");
        this.#publish();
      }
      return;
    }
    if (this.#turn || this.#active || this.#automaticAdmission) return;
    if (reason === "change") this.#clearPolicyTimer();
    this.#pendingReason = null;
    const result = await this.dispatchAutomaticTurn(
      {
        sessionId: this.#selectedSessionId,
        message: this.#instruction,
        reason,
      },
      deliver,
    );
    if (
      !result.ok &&
      ["observation_backpressure", "session_turn_active"].includes(result.error.code)
    ) {
      if (!this.#increment("skippedBusy", 1)) {
        this.#setFailure(fixedError("observation_accounting_failed"));
      } else {
        this.#publish();
      }
    }
  }

  #armInterval(): void {
    if (!this.#watchEnabled || this.#trigger !== "interval") return;
    this.#armPolicyTimer("watch", 30_000);
  }

  #armPolicyTimer(reason: "change" | "watch", delayMs: number): void {
    this.#clearPolicyTimer();
    const generation = this.#generation;
    this.#policyTimer = setTimeout(
      () => {
        this.#policyTimer = null;
        if (generation !== this.#generation) return;
        if (reason === "watch") {
          if (this.#watchEnabled && this.#trigger === "interval" && this.#pending) {
            this.#markAutomatic("watch");
          }
          this.#armInterval();
        } else if (this.#watchEnabled && this.#trigger === "changes" && this.#pending) {
          this.#queueAutomaticDrain();
        }
      },
      Math.max(0, delayMs),
    );
  }

  #clearPolicyTimer(): void {
    if (this.#policyTimer === null) return;
    clearTimeout(this.#policyTimer);
    this.#policyTimer = null;
  }

  #skipUnchanged(): void {
    if (!this.#increment("skippedUnchanged", 1)) {
      this.#setFailure(fixedError("observation_accounting_failed"));
      return;
    }
    if (this.#state === "waiting") this.#lastError = null;
    this.#publish();
  }
}

function frameIdentity(frame: CaptureFrameV1) {
  return {
    sessionId: frame.sessionId,
    captureId: frame.captureId,
    frameId: frame.frameId,
    contentHash: frame.contentHash,
  };
}

function frameFact(
  frame: CaptureFrameV1,
  reason: ObservationReason,
  selectedAt: string,
  sentAt: string | null,
  traceId: string | null,
): ObservationFrameFactV1 {
  return {
    schemaVersion: 1,
    frameId: frame.frameId,
    contentHash: frame.contentHash,
    width: frame.width,
    height: frame.height,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    previewUrl: frame.previewUrl,
    reason,
    selectedAt,
    sentAt,
    traceId,
  };
}

function cloneFrameFact(value: ObservationFrameFactV1 | null): ObservationFrameFactV1 | null {
  return value ? { ...value } : null;
}

function emptyCounters(): ObservationCountersV1 {
  return {
    schemaVersion: 1,
    captureFrames: 0,
    captureBytes: 0,
    selectedFrames: 0,
    sentFrames: 0,
    uploadedBytes: 0,
    skippedUnchanged: 0,
    skippedBusy: 0,
    replacedPending: 0,
    inferencesStarted: 0,
    inferencesCompleted: 0,
    inferencesFailed: 0,
    inferencesCancelled: 0,
  };
}

function emptyBuckets(): RateBuckets {
  return { seconds: Array(60).fill(-1), values: Array(60).fill(0) };
}

function rateTotal(buckets: RateBuckets, now: number): number {
  const current = Math.floor(now / 1000);
  let total = 0;
  for (let index = 0; index < 60; index += 1) {
    const age = current - buckets.seconds[index];
    if (age >= 0 && age < 60) total += buckets.values[index];
  }
  return total;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

function activeUpload(generation: number, frame: CaptureFrameV1): ActiveUpload {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    generation,
    frame: { ...frame },
    controller: new AbortController(),
    done,
    settle,
  };
}

function activeTurn(input: {
  token: symbol;
  sessionId: string;
  mediaId: string;
  frame: CaptureFrameV1;
  reason: ObservationReason;
  generation: number;
  automatic: boolean;
  cancel: ObservationTurnOwner["cancel"] | null;
}): ActiveTurn {
  let settleTerminal!: () => void;
  let settleAdmission!: () => void;
  const terminal = new Promise<void>((resolve) => {
    settleTerminal = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    settleAdmission = resolve;
  });
  return {
    ...input,
    started: false,
    traceId: null,
    cancelRequested: false,
    usage: unavailableUsage(),
    responseErrors: [],
    turnError: null,
    cancelTarget: null,
    terminal,
    settleTerminal,
    admitted,
    settleAdmission,
  };
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([promise.then(() => true as const), timedOut]);
  if (timer) clearTimeout(timer);
  return settled;
}

function unavailableUsage(): InferenceUsageV1 {
  return {
    usageAvailable: false,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    llmCalls: null,
    durationMs: null,
    costUsd: null,
    costSource: "unavailable",
  };
}

function validUploadInput(input: ObservationUploadInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Object.keys(input).length === 3 &&
    Object.hasOwn(input, "sessionId") &&
    Object.hasOwn(input, "reason") &&
    Object.hasOwn(input, "signal") &&
    validSessionId(input.sessionId) &&
    reasons.has(input.reason) &&
    input.signal instanceof AbortSignal
  );
}

function validateConfigureInput(
  input: ObservationConfigureInput,
): ClientResult<ObservationConfigureInput> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, "sessionId") ||
    !Object.hasOwn(input, "instruction") ||
    !Object.hasOwn(input, "trigger") ||
    !validSessionId(input.sessionId) ||
    typeof input.instruction !== "string" ||
    !triggers.has(input.trigger) ||
    !validUnicode(input.instruction)
  ) {
    return failure("invalid_request", "Observation request is invalid.");
  }
  const instruction = input.instruction.normalize("NFC");
  if (
    !instruction.trim() ||
    Buffer.byteLength(instruction, "utf8") > 4096 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(instruction)
  ) {
    return failure("invalid_request", "Observation request is invalid.");
  }
  return {
    ok: true,
    value: {
      sessionId: input.sessionId.trim(),
      instruction,
      trigger: input.trigger,
    },
  };
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeUploadFailure(error: ErrorV1): ClientResult<never> {
  if (error.code === "media_backpressure") {
    return failure(
      "observation_backpressure",
      "Observation is waiting for the active turn.",
      true,
      1000,
    );
  }
  if (error.code === "daemon_unavailable") {
    return failure("daemon_unavailable", "The local OpenMinion daemon is not ready.", true);
  }
  if (error.code === "observation_frame_mismatch") {
    return failure("observation_frame_mismatch", "The selected frame changed before use.");
  }
  return failure("observation_upload_failed", "The selected frame could not be uploaded.");
}

function fixedError(code: string): ErrorV1 {
  const messages: Record<string, string> = {
    observation_cleanup_failed: "Observation cleanup did not complete.",
    observation_accounting_failed: "Observation accounting could not be updated.",
    invalid_daemon_response: "The daemon returned an invalid response.",
    submission_ambiguous: "Check session history before retrying.",
    observation_turn_cancelled: "Automatic observation was cancelled.",
    observation_turn_failed: "Automatic observation turn failed.",
    observation_stream_failed: "Automatic observation stream failed.",
  };
  return {
    code,
    message: messages[code] ?? "Observation failed.",
    retryable: false,
    retryAfterMs: null,
  };
}

function failure(
  code: string,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): { ok: false; error: ErrorV1 } {
  return { ok: false, error: { code, message, retryable, retryAfterMs } };
}
