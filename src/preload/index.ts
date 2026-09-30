import { contextBridge, ipcRenderer } from "electron";
import {
  type CaptureEventV1,
  IPC_CHANNELS,
  type NativeApi,
  type ObservationStatusV1,
  type TurnEventV1,
} from "../shared/contracts.js";

let activeTurnListener: ((_event: unknown, payload: unknown) => void) | null = null;
let activeCaptureListener: ((_event: unknown, payload: unknown) => void) | null = null;
let activeObservationListener: ((_event: unknown, payload: unknown) => void) | null = null;
const textEncoder = new TextEncoder();

const api: NativeApi = {
  runtime: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeStatus),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeCheck),
    stage: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeStage),
    control: (input) => ipcRenderer.invoke(IPC_CHANNELS.runtimeControl, input),
  },
  chatNames: {
    load: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatNamesLoad, input),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatNamesSave, input),
  },
  presentation: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.presentationLoad),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.presentationSave, input),
  },
  reports: { read: (input) => ipcRenderer.invoke(IPC_CHANNELS.reportsRead, input) },
  tasks: {
    control: (input) => ipcRenderer.invoke(IPC_CHANNELS.tasksControl, input),
  },
  profiles: {
    presets: () => ipcRenderer.invoke(IPC_CHANNELS.profilesPresets),
    setup: (input) => ipcRenderer.invoke(IPC_CHANNELS.profilesSetup, input),
    read: () => ipcRenderer.invoke(IPC_CHANNELS.profilesRead),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.profilesSave, input),
    import: (input) => ipcRenderer.invoke(IPC_CHANNELS.profilesImport, input),
  },
  identity: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.identityRead),
    verify: (input) => ipcRenderer.invoke(IPC_CHANNELS.identityVerify, input),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.identitySave, input),
  },
  app: {
    openLink: (url) => ipcRenderer.invoke(IPC_CHANNELS.openLink, url),
    copyText(text) {
      return ipcRenderer.invoke(IPC_CHANNELS.copyText, text);
    },
    async info() {
      return {
        appName: "OpenMinion",
        shellVersion: process.versions.electron,
      };
    },
  },
  daemon: {
    inspect: (kind) => ipcRenderer.invoke(IPC_CHANNELS.daemonInspect, kind),
    status() {
      return ipcRenderer.invoke(IPC_CHANNELS.daemonStatus);
    },
    retry() {
      return ipcRenderer.invoke(IPC_CHANNELS.daemonRetry);
    },
  },
  sessions: {
    export: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionsExport, input),
    list(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.sessionsList, input);
    },
    create(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.sessionsCreate, input);
    },
    load(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.sessionsLoad, input);
    },
    close(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.sessionsClose, input);
    },
    events(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.sessionsEvents, input);
    },
  },
  turns: {
    submit(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.turnsSubmit, input);
    },
    cancel(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.turnsCancel, input);
    },
    subscribe(listener) {
      if (activeTurnListener) {
        ipcRenderer.removeListener(IPC_CHANNELS.turnEvent, activeTurnListener);
      }
      const wrapped = (_event: unknown, payload: unknown) => {
        if (isTurnEvent(payload)) {
          listener(payload);
        }
      };
      activeTurnListener = wrapped;
      ipcRenderer.on(IPC_CHANNELS.turnEvent, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        ipcRenderer.removeListener(IPC_CHANNELS.turnEvent, wrapped);
        if (activeTurnListener === wrapped) {
          activeTurnListener = null;
        }
      };
    },
  },
  approvals: {
    decide(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.approvalsDecide, input);
    },
  },
  artifacts: {
    list(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.artifactsList, input);
    },
    read(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.artifactsRead, input);
    },
    detach(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.artifactsDetach, input);
    },
    restore(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.artifactsRestore, input);
    },
  },
  files: {
    pick(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.filesPick, input);
    },
    list(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.filesList, input);
    },
    import(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.filesImport, input);
    },
    release(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.filesRelease, input);
    },
  },
  media: {
    pick(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.mediaPick, input);
    },
    release(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.mediaRelease, input);
    },
  },
  capture: {
    status() {
      return ipcRenderer.invoke(IPC_CHANNELS.captureStatus);
    },
    sources(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.captureSources, input);
    },
    start(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.captureStart, input);
    },
    pause() {
      return ipcRenderer.invoke(IPC_CHANNELS.capturePause);
    },
    resume() {
      return ipcRenderer.invoke(IPC_CHANNELS.captureResume);
    },
    stop() {
      return ipcRenderer.invoke(IPC_CHANNELS.captureStop);
    },
    subscribe(listener) {
      if (activeCaptureListener) {
        ipcRenderer.removeListener(IPC_CHANNELS.captureEvent, activeCaptureListener);
      }
      const wrapped = (_event: unknown, payload: unknown) => {
        if (isCaptureEvent(payload)) listener(payload);
      };
      activeCaptureListener = wrapped;
      ipcRenderer.on(IPC_CHANNELS.captureEvent, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(IPC_CHANNELS.captureEvent, wrapped);
        if (activeCaptureListener === wrapped) activeCaptureListener = null;
      };
    },
  },
  observation: {
    status() {
      return ipcRenderer.invoke(IPC_CHANNELS.observationStatus);
    },
    configure(input) {
      return ipcRenderer.invoke(IPC_CHANNELS.observationConfigure, input);
    },
    stop() {
      return ipcRenderer.invoke(IPC_CHANNELS.observationStop);
    },
    subscribe(listener) {
      if (activeObservationListener) {
        ipcRenderer.removeListener(IPC_CHANNELS.observationEvent, activeObservationListener);
      }
      const wrapped = (_event: unknown, payload: unknown) => {
        if (isObservationStatus(payload)) listener(payload);
      };
      activeObservationListener = wrapped;
      ipcRenderer.on(IPC_CHANNELS.observationEvent, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(IPC_CHANNELS.observationEvent, wrapped);
        if (activeObservationListener === wrapped) activeObservationListener = null;
      };
    },
  },
};

contextBridge.exposeInMainWorld("openminion", api);

const captureStates = new Set([
  "idle",
  "selecting",
  "starting",
  "observing",
  "paused",
  "stopping",
  "blocked",
  "failed",
]);
const captureReasons = new Set([
  "ready",
  "user_started",
  "user_paused",
  "user_resumed",
  "user_changed_source",
  "user_stopped",
  "permission_required",
  "permission_denied",
  "permission_restricted",
  "permission_unknown",
  "source_enumeration_failed",
  "source_timeout",
  "source_expired",
  "source_missing",
  "source_ended",
  "source_changed",
  "region_invalid",
  "display_changed",
  "screen_locked",
  "system_suspended",
  "renderer_lost",
  "session_changed",
  "session_closed",
  "app_quit",
  "worker_failed",
  "frame_invalid",
  "frame_too_large",
  "worker_timeout",
  "internal_error",
  "unsupported",
]);
const capturePermissions = new Set([
  "not_determined",
  "granted",
  "denied",
  "restricted",
  "unknown",
  "unsupported",
]);
const captureIdPattern = /^[0-9a-f]{48}$/;
const observationStates = new Set([
  "idle",
  "ready",
  "selecting",
  "uploading",
  "inferencing",
  "waiting",
  "stopping",
  "failed",
]);
const observationReasons = new Set(["initial", "user_send", "change", "post_action", "watch"]);
const observationErrors: Record<
  string,
  {
    message: string;
    retryable: boolean;
    retryAfterMs: number | null;
    states: readonly ObservationStatusV1["state"][];
  }
> = {
  observation_capture_inactive: {
    message: "Start computer observation first.",
    retryable: false,
    retryAfterMs: null,
    states: ["waiting"],
  },
  observation_frame_unavailable: {
    message: "The selected frame is no longer available.",
    retryable: false,
    retryAfterMs: null,
    states: ["waiting"],
  },
  observation_frame_mismatch: {
    message: "The selected frame changed before use.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_backpressure: {
    message: "Observation is waiting for the active turn.",
    retryable: true,
    retryAfterMs: 1000,
    states: ["waiting"],
  },
  observation_upload_failed: {
    message: "The selected frame could not be uploaded.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_cleanup_failed: {
    message: "Observation cleanup did not complete.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_accounting_failed: {
    message: "Observation accounting could not be updated.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  daemon_unavailable: {
    message: "The local OpenMinion daemon is not ready.",
    retryable: true,
    retryAfterMs: null,
    states: ["failed"],
  },
  session_turn_active: {
    message: "A turn is already active for this session.",
    retryable: true,
    retryAfterMs: null,
    states: ["waiting"],
  },
  submission_ambiguous: {
    message: "Check session history before retrying.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  invalid_daemon_response: {
    message: "The daemon returned an invalid response.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_turn_cancelled: {
    message: "Automatic observation was cancelled.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_turn_failed: {
    message: "Automatic observation turn failed.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
  observation_stream_failed: {
    message: "Automatic observation stream failed.",
    retryable: false,
    retryAfterMs: null,
    states: ["failed"],
  },
};

function isObservationStatus(value: unknown): value is ObservationStatusV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "sessionId",
      "watchEnabled",
      "trigger",
      "state",
      "currentReason",
      "selectedFrame",
      "sentFrame",
      "counters",
      "rates",
      "usage",
      "lastError",
      "updatedAt",
    ])
  )
    return false;
  if (
    value.schemaVersion !== 1 ||
    !observationStates.has(String(value.state)) ||
    (value.sessionId !== null && !safeText(value.sessionId, 256)) ||
    typeof value.watchEnabled !== "boolean" ||
    (value.watchEnabled
      ? !["changes", "interval"].includes(String(value.trigger))
      : value.trigger !== null) ||
    (value.currentReason !== null && !observationReasons.has(String(value.currentReason))) ||
    (value.selectedFrame !== null && !isObservationFrame(value.selectedFrame)) ||
    (value.sentFrame !== null && !isObservationFrame(value.sentFrame)) ||
    !isObservationCounters(value.counters) ||
    !isObservationRates(value.rates) ||
    !isInferenceUsage(value.usage) ||
    (value.lastError !== null && !isObservationError(value.lastError, value.state)) ||
    !iso(value.updatedAt)
  )
    return false;
  if (value.state === "idle") {
    return (
      !value.watchEnabled &&
      value.sessionId === null &&
      value.currentReason === null &&
      value.selectedFrame === null &&
      value.sentFrame === null &&
      value.lastError === null
    );
  }
  if (value.sessionId === null) return false;
  if (value.state === "ready") return value.lastError === null;
  if (value.state === "waiting") return value.watchEnabled;
  if (value.state === "selecting" || value.state === "uploading") {
    return (
      value.selectedFrame !== null &&
      value.sentFrame === null &&
      value.currentReason !== null &&
      value.lastError === null
    );
  }
  if (value.state === "inferencing") {
    return (
      value.currentReason !== null &&
      isRecord(value.sentFrame) &&
      value.sentFrame.sentAt !== null &&
      value.sentFrame.traceId !== null &&
      value.lastError === null
    );
  }
  if (value.state === "stopping") {
    return (
      !value.watchEnabled &&
      value.selectedFrame !== null &&
      value.lastError === null &&
      (value.sentFrame === null ||
        (isRecord(value.sentFrame) &&
          value.sentFrame.sentAt !== null &&
          value.sentFrame.traceId !== null))
    );
  }
  if (value.state === "failed") return !value.watchEnabled && value.lastError !== null;
  return false;
}

function isObservationError(value: unknown, state: unknown): boolean {
  if (!isError(value) || !isRecord(value)) return false;
  const expected = observationErrors[String(value.code)];
  return (
    Boolean(expected) &&
    expected.message === value.message &&
    expected.retryable === value.retryable &&
    expected.retryAfterMs === value.retryAfterMs &&
    expected.states.includes(state as ObservationStatusV1["state"])
  );
}

function isObservationFrame(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "frameId",
      "contentHash",
      "width",
      "height",
      "capturedAt",
      "expiresAt",
      "previewUrl",
      "reason",
      "selectedAt",
      "sentAt",
      "traceId",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    captureId(value.frameId) &&
    typeof value.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.contentHash) &&
    boundedInteger(value.width, 1920) &&
    boundedInteger(value.height, 1080) &&
    iso(value.capturedAt) &&
    iso(value.expiresAt) &&
    iso(value.selectedAt) &&
    nullableIso(value.sentAt) &&
    (value.traceId === null || safeText(value.traceId, 256)) &&
    observationReasons.has(String(value.reason)) &&
    value.previewUrl === `openminion://app/capture/frames/${value.frameId}` &&
    ((value.sentAt === null && value.traceId === null) ||
      (value.sentAt !== null && value.traceId !== null))
  );
}

function isObservationCounters(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "captureFrames",
      "captureBytes",
      "selectedFrames",
      "sentFrames",
      "uploadedBytes",
      "skippedUnchanged",
      "skippedBusy",
      "replacedPending",
      "inferencesStarted",
      "inferencesCompleted",
      "inferencesFailed",
      "inferencesCancelled",
    ]) ||
    value.schemaVersion !== 1
  )
    return false;
  return Object.entries(value).every(
    ([key, item]) => key === "schemaVersion" || nonnegativeInteger(item),
  );
}

function isObservationRates(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "schemaVersion",
      "windowMs",
      "capturedFrames",
      "inferencesStarted",
      "sampledAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.windowMs === 60_000 &&
    nonnegativeInteger(value.capturedFrames) &&
    nonnegativeInteger(value.inferencesStarted) &&
    iso(value.sampledAt)
  );
}

function isCaptureEvent(value: unknown): value is CaptureEventV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "state") {
    return exactKeys(value, ["schemaVersion", "kind", "value"]) && isCaptureState(value.value);
  }
  if (
    value.kind !== "frame" ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "captureId",
      "frameId",
      "sessionId",
      "sourceKind",
      "parentSourceKind",
      "width",
      "height",
      "scaleFactor",
      "capturedAt",
      "expiresAt",
      "contentHash",
      "encoding",
      "sizeBytes",
      "previewUrl",
    ])
  )
    return false;
  return (
    captureId(value.captureId) &&
    captureId(value.frameId) &&
    safeText(value.sessionId, 256) &&
    ["display", "window", "region"].includes(String(value.sourceKind)) &&
    ["display", "window"].includes(String(value.parentSourceKind)) &&
    boundedInteger(value.width, 1920) &&
    boundedInteger(value.height, 1080) &&
    (value.scaleFactor === null || finitePositive(value.scaleFactor)) &&
    iso(value.capturedAt) &&
    iso(value.expiresAt) &&
    typeof value.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.contentHash) &&
    value.encoding === "image/jpeg" &&
    boundedInteger(value.sizeBytes, 2_097_152) &&
    value.previewUrl === `openminion://app/capture/frames/${value.frameId}`
  );
}

function isCaptureState(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "state",
      "reason",
      "permission",
      "captureId",
      "sessionId",
      "sourceKind",
      "parentSourceKind",
      "sourceLabel",
      "scaleFactor",
      "startedAt",
      "pausedAt",
      "capturedFrames",
      "droppedFrames",
      "retainedBytes",
      "lastFrameAt",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    captureStates.has(String(value.state)) &&
    captureReasons.has(String(value.reason)) &&
    capturePermissions.has(String(value.permission)) &&
    (value.captureId === null || captureId(value.captureId)) &&
    (value.sessionId === null || safeText(value.sessionId, 256)) &&
    (value.sourceKind === null ||
      ["display", "window", "region"].includes(String(value.sourceKind))) &&
    (value.parentSourceKind === null ||
      ["display", "window"].includes(String(value.parentSourceKind))) &&
    (value.sourceLabel === null || safeText(value.sourceLabel, 512)) &&
    (value.scaleFactor === null || finitePositive(value.scaleFactor)) &&
    nullableIso(value.startedAt) &&
    nullableIso(value.pausedAt) &&
    nonnegativeInteger(value.capturedFrames) &&
    nonnegativeInteger(value.droppedFrames) &&
    nonnegativeInteger(value.retainedBytes) &&
    nullableIso(value.lastFrameAt)
  );
}

function captureId(value: unknown): boolean {
  return typeof value === "string" && captureIdPattern.test(value);
}

function safeText(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function iso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableIso(value: unknown): boolean {
  return value === null || iso(value);
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedInteger(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isTurnEvent(value: unknown): value is TurnEventV1 {
  if (!isRecord(value)) {
    return false;
  }
  const record = value;
  if (record.schemaVersion !== 1) {
    return false;
  }
  if (record.kind === "started") {
    return (
      exactKeys(record, ["schemaVersion", "kind", "requestId", "traceId", "sessionId"]) &&
      strings(record, ["requestId", "traceId", "sessionId"])
    );
  }
  if (record.kind === "progress" && record.progressKind === "status") {
    return (
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "progressKind",
        "sessionId",
        "traceId",
        "statusKey",
        "label",
        "detailText",
        "createdAt",
      ]) &&
      strings(record, ["sessionId", "traceId", "statusKey", "createdAt"]) &&
      nullableString(record.label) &&
      nullableString(record.detailText)
    );
  }
  if (record.kind === "progress" && record.progressKind === "text") {
    return (
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "progressKind",
        "sessionId",
        "traceId",
        "text",
        "createdAt",
      ]) && strings(record, ["sessionId", "traceId", "text", "createdAt"])
    );
  }
  if (record.kind === "response") {
    return (
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "sessionId",
        "traceId",
        "finalText",
        "errors",
        "usage",
      ]) &&
      strings(record, ["sessionId", "traceId", "finalText"]) &&
      Array.isArray(record.errors) &&
      record.errors.every(isError) &&
      isInferenceUsage(record.usage)
    );
  }
  if (record.kind === "error") {
    return (
      exactKeys(record, ["schemaVersion", "kind", "sessionId", "traceId", "error"]) &&
      strings(record, ["sessionId"]) &&
      nullableString(record.traceId) &&
      isError(record.error)
    );
  }
  if (record.kind === "tool") {
    return (
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "phase",
        "sessionId",
        "traceId",
        "toolName",
        "callId",
        "state",
        "createdAt",
        "ok",
        "durationMs",
        "exitCode",
      ]) &&
      (record.phase === "started" || record.phase === "completed") &&
      strings(record, ["sessionId", "traceId", "toolName", "callId", "state", "createdAt"]) &&
      nullableBoolean(record.ok) &&
      nullableNumber(record.durationMs) &&
      nullableNumber(record.exitCode) &&
      (record.phase === "completed" ||
        (record.ok === null && record.durationMs === null && record.exitCode === null))
    );
  }
  if (record.kind === "approval") {
    return isApprovalEvent(record);
  }
  return (
    record.kind === "done" &&
    exactKeys(record, ["schemaVersion", "kind", "sessionId", "traceId", "outcome"]) &&
    strings(record, ["sessionId"]) &&
    nullableString(record.traceId) &&
    ["complete", "error", "cancelled"].includes(String(record.outcome))
  );
}

function isInferenceUsage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "usageAvailable",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "llmCalls",
      "durationMs",
      "costUsd",
      "costSource",
    ])
  )
    return false;
  const nullableCount = (item: unknown) => item === null || nonnegativeInteger(item);
  if (
    typeof value.usageAvailable !== "boolean" ||
    !nullableCount(value.inputTokens) ||
    !nullableCount(value.outputTokens) ||
    !nullableCount(value.totalTokens) ||
    !nullableCount(value.llmCalls) ||
    !nullableCount(value.durationMs) ||
    value.costUsd !== null ||
    value.costSource !== "unavailable"
  )
    return false;
  if (!value.usageAvailable) {
    return (
      value.inputTokens === null &&
      value.outputTokens === null &&
      value.totalTokens === null &&
      value.llmCalls === null &&
      value.durationMs === null
    );
  }
  return (
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.totalTokens === "number" &&
    value.totalTokens === value.inputTokens + value.outputTokens &&
    Number.isSafeInteger(value.totalTokens) &&
    typeof value.llmCalls === "number" &&
    typeof value.durationMs === "number"
  );
}

function isApprovalEvent(record: Record<string, unknown>): boolean {
  if (
    !exactKeys(record, [
      "schemaVersion",
      "kind",
      "phase",
      "sessionId",
      "traceId",
      "approvalId",
      "toolName",
      "callId",
      "argumentKeys",
      "requestedAt",
      "expiresAt",
      "decision",
      "outcome",
      "resolvedAt",
    ]) ||
    !strings(record, ["sessionId", "traceId", "approvalId", "toolName", "callId"]) ||
    !boundedStringArray(record.argumentKeys) ||
    !nullableString(record.requestedAt) ||
    !nullableString(record.expiresAt) ||
    !nullableString(record.decision) ||
    !nullableString(record.resolvedAt)
  ) {
    return false;
  }
  if (record.phase === "requested") {
    return (
      record.outcome === "pending" &&
      record.decision === null &&
      typeof record.requestedAt === "string" &&
      typeof record.expiresAt === "string" &&
      record.resolvedAt === null
    );
  }
  if (
    record.phase !== "resolved" ||
    record.argumentKeys.length !== 0 ||
    record.requestedAt !== null ||
    record.expiresAt !== null ||
    typeof record.resolvedAt !== "string"
  ) {
    return false;
  }
  if (record.outcome === "applied") {
    return record.decision === "allow_once";
  }
  if (record.outcome === "denied") {
    return record.decision === "deny";
  }
  return (
    ["expired", "cancelled", "interrupted", "event_failed"].includes(String(record.outcome)) &&
    record.decision === null
  );
}

function isError(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["code", "message", "retryable", "retryAfterMs"]) &&
    strings(value, ["code", "message"]) &&
    typeof value.retryable === "boolean" &&
    (value.retryAfterMs === null ||
      (typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs)))
  );
}

function exactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(record).length === keys.length &&
    Object.keys(record).every((key) => keys.includes(key))
  );
}

function strings(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function boundedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => typeof item === "string" && textEncoder.encode(item).byteLength <= 256) &&
    new Set(value).size === value.length &&
    value.every((item, index) => index === 0 || value[index - 1] <= item) &&
    textEncoder.encode(JSON.stringify(value)).byteLength <= 8 * 1024
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
