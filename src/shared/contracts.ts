import type {
  ProfileSaveInput,
  ProfileSettings,
  ProfileSetupInput,
  SetupPreset,
} from "./profiles.js";
import type { TaskControlInput, TaskControlValue } from "./tasks.js";
import type { ReportInput, ReportValue } from "./reports.js";
export type DesktopClientReady = {
  schema_version: 1;
  event: "desktop.client.ready";
  host: "127.0.0.1" | "::1";
  port: number;
  protocol_min: 1;
  protocol_max: 1;
  daemon_version: string;
  config_id: string;
  client_id: string;
  client_token: string;
  expires_at: string;
};

export type DaemonState =
  | "idle"
  | "probing"
  | "starting"
  | "running"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped";

export type DaemonStatus = {
  state: DaemonState;
  reachable: boolean;
  daemonVersion: string | null;
  protocol: number | null;
  configId: string | null;
  capabilities: string[];
  errorCode: string | null;
};

export type AppInfo = {
  appName: "OpenMinion";
  shellVersion: string;
};

export type ErrorV1 = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
};

export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: ErrorV1 };

export type SessionStatus = "active" | "idle" | "paused" | "stale" | "closed";

export type SessionSummaryV1 = {
  isDraft?: boolean;
  schemaVersion: 1;
  sessionId: string;
  title: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  activeAgentId: string | null;
  model: { provider: string | null; modelId: string | null };
  projectId: string | null;
  eventCursor: string;
};

export type MessageV1 = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  body: string;
  profileName?: string | null;
  createdAt: string;
};

export type SessionEventFact = string | number | boolean | null | readonly string[];

export type SessionEventV1 = {
  schemaVersion: 1;
  eventType: string;
  cursor: string;
  createdAt: string;
  runId: string | null;
  traceId: string | null;
  state: string | null;
  facts: Record<string, SessionEventFact>;
};

export type TurnStartedV1 = {
  schemaVersion: 1;
  kind: "started";
  requestId: string;
  traceId: string;
  sessionId: string;
};

export type TurnProgressV1 =
  | {
      schemaVersion: 1;
      kind: "progress";
      progressKind: "status";
      sessionId: string;
      traceId: string;
      statusKey: string;
      label: string | null;
      detailText: string | null;
      createdAt: string;
    }
  | {
      schemaVersion: 1;
      kind: "progress";
      progressKind: "text";
      sessionId: string;
      traceId: string;
      text: string;
      createdAt: string;
    };

export type TurnResponseV1 = {
  schemaVersion: 1;
  kind: "response";
  sessionId: string;
  traceId: string;
  finalText: string;
  errors: ErrorV1[];
  usage: InferenceUsageV1;
};

export type InferenceUsageV1 = {
  usageAvailable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  llmCalls: number | null;
  durationMs: number | null;
  costUsd: null;
  costSource: "unavailable";
};

export type TurnErrorV1 = {
  schemaVersion: 1;
  kind: "error";
  sessionId: string;
  traceId: string | null;
  error: ErrorV1;
};

export type TurnDoneV1 = {
  schemaVersion: 1;
  kind: "done";
  sessionId: string;
  traceId: string | null;
  outcome: "complete" | "error" | "cancelled";
};

export type ToolProgressV1 = {
  schemaVersion: 1;
  kind: "tool";
  phase: "started" | "completed";
  sessionId: string;
  traceId: string;
  toolName: string;
  callId: string;
  state: string;
  createdAt: string;
  ok: boolean | null;
  durationMs: number | null;
  exitCode: number | null;
};

export type ApprovalDecision = "allow_once" | "deny";
export type ApprovalOutcome =
  | "pending"
  | "applied"
  | "denied"
  | "expired"
  | "cancelled"
  | "interrupted"
  | "event_failed";

export type ApprovalEventV1 = {
  schemaVersion: 1;
  kind: "approval";
  phase: "requested" | "resolved";
  sessionId: string;
  traceId: string;
  approvalId: string;
  toolName: string;
  callId: string;
  argumentKeys: string[];
  requestedAt: string | null;
  expiresAt: string | null;
  decision: ApprovalDecision | null;
  outcome: ApprovalOutcome;
  resolvedAt: string | null;
};

export type ApprovalDecisionV1 = {
  schemaVersion: 1;
  approvalId: string;
  sessionId: string;
  traceId: string;
  callId: string;
  decision: ApprovalDecision;
  outcome: "applied" | "denied" | "already_applied" | "already_denied";
  resolvedAt: string;
};

export type TurnEventV1 =
  | TurnStartedV1
  | TurnProgressV1
  | TurnResponseV1
  | TurnErrorV1
  | TurnDoneV1
  | ToolProgressV1
  | ApprovalEventV1;

export type SessionListInput = { cursor?: string; limit?: number };
export type SessionCreateInput = {
  agentId?: string;
  title?: string;
  projectId?: string;
};
export type SessionLoadInput = {
  sessionId: string;
  messageAfter?: string;
  messageLimit?: number;
};
export type SessionCloseInput = { sessionId: string; reason?: string };
export type SessionEventsInput = {
  sessionId: string;
  after?: string;
  limit?: number;
};
export type TurnSubmitInput = {
  sessionId: string;
  message: string;
  attachmentIds?: string[];
  observation?: { includeCurrentView: true };
};
export type ObservationReasonV1 = "initial" | "user_send" | "change" | "post_action" | "watch";
export type ObservationTriggerV1 = "changes" | "interval";
export type ObservationConfigureInput = {
  sessionId: string;
  instruction: string;
  trigger: ObservationTriggerV1;
};
export type ObservationFrameFactV1 = {
  schemaVersion: 1;
  frameId: string;
  contentHash: string;
  width: number;
  height: number;
  capturedAt: string;
  expiresAt: string;
  previewUrl: string;
  reason: ObservationReasonV1;
  selectedAt: string;
  sentAt: string | null;
  traceId: string | null;
};
export type ObservationCountersV1 = {
  schemaVersion: 1;
  captureFrames: number;
  captureBytes: number;
  selectedFrames: number;
  sentFrames: number;
  uploadedBytes: number;
  skippedUnchanged: number;
  skippedBusy: number;
  replacedPending: number;
  inferencesStarted: number;
  inferencesCompleted: number;
  inferencesFailed: number;
  inferencesCancelled: number;
};
export type ObservationRatesV1 = {
  schemaVersion: 1;
  windowMs: 60000;
  capturedFrames: number;
  inferencesStarted: number;
  sampledAt: string;
};
export type ObservationStatusV1 = {
  schemaVersion: 1;
  sessionId: string | null;
  watchEnabled: boolean;
  trigger: ObservationTriggerV1 | null;
  state:
    | "idle"
    | "ready"
    | "selecting"
    | "uploading"
    | "inferencing"
    | "waiting"
    | "stopping"
    | "failed";
  currentReason: ObservationReasonV1 | null;
  selectedFrame: ObservationFrameFactV1 | null;
  sentFrame: ObservationFrameFactV1 | null;
  counters: ObservationCountersV1;
  rates: ObservationRatesV1;
  usage: InferenceUsageV1;
  lastError: ErrorV1 | null;
  updatedAt: string;
};
export type TurnCancelInput = { sessionId: string; traceId: string };
export type ApprovalDecisionInput = {
  sessionId: string;
  traceId: string;
  approvalId: string;
  decision: ApprovalDecision;
};
export type MediaPickInput = {
  sessionId: string;
  kind: "image" | "file";
};
export type MediaAttachmentV1 = {
  schemaVersion: 1;
  mediaId: string;
  sessionId: string;
  name: string;
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "application/pdf"
    | "text/plain"
    | "application/json";
  sizeBytes: number;
  kind: "image" | "file";
  turnCompatible: boolean;
  expiresAt: string;
};
export type MediaPickValue = { attachments: MediaAttachmentV1[] };
export type MediaReleaseInput = { sessionId: string; mediaId: string };
export type MediaReleaseValue = { mediaId: string; released: true };

export type ArtifactKind = "artifact" | "tool_output";
export type ArtifactState = "active" | "detached" | "missing" | "unsupported";
export type ArtifactContentKind = "text" | "json" | "diff" | "unavailable";
export type ArtifactAction = "read" | "detach" | "restore";

export type ArtifactCatalogItemV1 = {
  schemaVersion: 1;
  artifactId: string;
  sessionId: string;
  kind: ArtifactKind;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  source: "attachment" | "tool";
  state: ArtifactState;
  contentKind: ArtifactContentKind;
  occurrenceCount: number;
  toolName: string | null;
  toolStatus: string | null;
  summary: string | null;
  actions: ArtifactAction[];
};

export type ArtifactContentV1 = {
  schemaVersion: 1;
  artifactId: string;
  sessionId: string;
  contentKind: ArtifactContentKind;
  text: string | null;
  complete: boolean;
  nextCursor: string | null;
};

export type ArtifactListInput = {
  sessionId: string;
  cursor?: string;
  limit?: number;
};
export type ArtifactListValue = {
  artifacts: ArtifactCatalogItemV1[];
  nextCursor: string | null;
  complete: boolean;
};
export type ArtifactReadInput = {
  sessionId: string;
  artifactId: string;
  cursor?: string;
  limitBytes?: number;
};
export type ArtifactDecisionInput = {
  sessionId: string;
  artifactId: string;
};
export type ArtifactDecisionValue = {
  artifactId: string;
  sessionId: string;
  state: "active" | "detached";
  outcome: "applied" | "already_applied";
};

export type FileGrantV1 = {
  schemaVersion: 1;
  grantId: string;
  sessionId: string;
  kind: "file" | "directory";
  displayName: string;
  expiresAt: string;
  canList: boolean;
  canImport: boolean;
};
export type FileGrantEntryV1 = {
  schemaVersion: 1;
  entryId: string;
  grantId: string;
  displayName: string;
  kind: "file" | "directory";
  sizeBytes: number;
  canImport: boolean;
};
export type FilePickInput = { sessionId: string; kind: "file" | "directory" };
export type FilePickValue = { grant: FileGrantV1 | null };
export type FileListInput = {
  sessionId: string;
  grantId: string;
  cursor?: string;
  limit?: number;
};
export type FileListValue = {
  grantId: string;
  entries: FileGrantEntryV1[];
  nextCursor: string | null;
  complete: boolean;
};
export type FileImportInput = {
  sessionId: string;
  grantId: string;
  entryId?: string;
};
export type FileImportValue = {
  grantId: string;
  entryId: string | null;
  attachment: MediaAttachmentV1;
};
export type FileReleaseInput = { sessionId: string; grantId: string };
export type FileReleaseValue = { grantId: string; released: true };

export type SessionListValue = {
  sessions: SessionSummaryV1[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type SessionLoadValue = {
  session: SessionSummaryV1;
  messages: MessageV1[];
  nextMessageCursor: string;
  messagesHasMore: boolean;
};
export type SessionEventsValue = {
  events: SessionEventV1[];
  nextCursor: string;
  hasMore: boolean;
};
export type TurnSubmitValue = {
  requestId: string;
  traceId: string;
  sessionId: string;
};
export type TurnCancellationValue = {
  sessionId: string;
  traceId: string;
  runId: string | null;
  state: "requested" | "already_requested" | "completed" | "failed" | "cancelled";
  terminal: boolean;
};

export type CapturePermissionV1 =
  | "not_determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown"
  | "unsupported";

export type CaptureSourceKind = "display" | "window";
export type CapturePublicSourceKind = CaptureSourceKind | "region";

export type CaptureSourcesInput = {
  sessionId: string;
  sourceKind: CaptureSourceKind;
};

export type CaptureCandidateV1 = {
  schemaVersion: 1;
  candidateId: string;
  sourceKind: CaptureSourceKind;
  label: string;
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  scaleFactor: number | null;
};

export type CaptureSourcesValue = {
  schemaVersion: 1;
  permission: CapturePermissionV1;
  candidates: CaptureCandidateV1[];
  truncated: boolean;
  expiresAt: string;
};

export type CaptureRegionV1 = {
  xBps: number;
  yBps: number;
  widthBps: number;
  heightBps: number;
};

export type CaptureStartInput = {
  sessionId: string;
  candidateId: string;
  region: CaptureRegionV1 | null;
};

export type CaptureStateReasonV1 =
  | "ready"
  | "user_started"
  | "user_paused"
  | "user_resumed"
  | "user_changed_source"
  | "user_stopped"
  | "permission_required"
  | "permission_denied"
  | "permission_restricted"
  | "permission_unknown"
  | "source_enumeration_failed"
  | "source_timeout"
  | "source_expired"
  | "source_missing"
  | "source_ended"
  | "source_changed"
  | "region_invalid"
  | "display_changed"
  | "screen_locked"
  | "system_suspended"
  | "renderer_lost"
  | "session_changed"
  | "session_closed"
  | "app_quit"
  | "worker_failed"
  | "frame_invalid"
  | "frame_too_large"
  | "worker_timeout"
  | "internal_error"
  | "unsupported";

export type CaptureStateV1 = {
  schemaVersion: 1;
  state:
    | "idle"
    | "selecting"
    | "starting"
    | "observing"
    | "paused"
    | "stopping"
    | "blocked"
    | "failed";
  reason: CaptureStateReasonV1;
  permission: CapturePermissionV1;
  captureId: string | null;
  sessionId: string | null;
  sourceKind: CapturePublicSourceKind | null;
  parentSourceKind: CaptureSourceKind | null;
  sourceLabel: string | null;
  scaleFactor: number | null;
  startedAt: string | null;
  pausedAt: string | null;
  capturedFrames: number;
  droppedFrames: number;
  retainedBytes: number;
  lastFrameAt: string | null;
};

export type CaptureFrameV1 = {
  schemaVersion: 1;
  kind: "frame";
  captureId: string;
  frameId: string;
  sessionId: string;
  sourceKind: CapturePublicSourceKind;
  parentSourceKind: CaptureSourceKind;
  width: number;
  height: number;
  scaleFactor: number | null;
  capturedAt: string;
  expiresAt: string;
  contentHash: string;
  encoding: "image/jpeg";
  sizeBytes: number;
  previewUrl: string;
};

export type CaptureEventV1 =
  | { schemaVersion: 1; kind: "state"; value: CaptureStateV1 }
  | CaptureFrameV1;

export type NativeApi = {
  reports: {
    read(input: ReportInput): Promise<ClientResult<ReportValue>>;
  };
  tasks: {
    control(input: TaskControlInput): Promise<ClientResult<TaskControlValue>>;
  };
  profiles: {
    presets(): Promise<ClientResult<SetupPreset[]>>;
    setup(
      input: ProfileSetupInput,
    ): Promise<ClientResult<{ settings: ProfileSettings; daemon: DaemonStatus }>>;
    read(): Promise<ClientResult<ProfileSettings>>;
    save(
      input: ProfileSaveInput,
    ): Promise<ClientResult<{ settings: ProfileSettings; daemon: DaemonStatus }>>;
    import(input: {
      revision: string;
    }): Promise<ClientResult<{ settings: ProfileSettings; daemon: DaemonStatus } | null>>;
  };
  app: {
    info(): Promise<AppInfo>;
    copyText(text: string): Promise<ClientResult<null>>;
  };
  daemon: {
    status(): Promise<DaemonStatus>;
    retry(): Promise<DaemonStatus>;
  };
  sessions: {
    export(input: { sessionId: string }): Promise<ClientResult<{ cancelled: boolean }>>;
    list(input: SessionListInput): Promise<ClientResult<SessionListValue>>;
    create(input: SessionCreateInput): Promise<ClientResult<SessionSummaryV1>>;
    load(input: SessionLoadInput): Promise<ClientResult<SessionLoadValue>>;
    close(input: SessionCloseInput): Promise<ClientResult<SessionSummaryV1>>;
    events(input: SessionEventsInput): Promise<ClientResult<SessionEventsValue>>;
  };
  turns: {
    submit(input: TurnSubmitInput): Promise<ClientResult<TurnSubmitValue>>;
    cancel(input: TurnCancelInput): Promise<ClientResult<TurnCancellationValue>>;
    subscribe(listener: (event: TurnEventV1) => void): () => void;
  };
  approvals: {
    decide(input: ApprovalDecisionInput): Promise<ClientResult<ApprovalDecisionV1>>;
  };
  artifacts: {
    list(input: ArtifactListInput): Promise<ClientResult<ArtifactListValue>>;
    read(input: ArtifactReadInput): Promise<ClientResult<ArtifactContentV1>>;
    detach(input: ArtifactDecisionInput): Promise<ClientResult<ArtifactDecisionValue>>;
    restore(input: ArtifactDecisionInput): Promise<ClientResult<ArtifactDecisionValue>>;
  };
  files: {
    pick(input: FilePickInput): Promise<ClientResult<FilePickValue>>;
    list(input: FileListInput): Promise<ClientResult<FileListValue>>;
    import(input: FileImportInput): Promise<ClientResult<FileImportValue>>;
    release(input: FileReleaseInput): Promise<ClientResult<FileReleaseValue>>;
  };
  media: {
    pick(input: MediaPickInput): Promise<ClientResult<MediaPickValue>>;
    release(input: MediaReleaseInput): Promise<ClientResult<MediaReleaseValue>>;
  };
  capture: {
    status(): Promise<ClientResult<CaptureStateV1>>;
    sources(input: CaptureSourcesInput): Promise<ClientResult<CaptureSourcesValue>>;
    start(input: CaptureStartInput): Promise<ClientResult<CaptureStateV1>>;
    pause(): Promise<ClientResult<CaptureStateV1>>;
    resume(): Promise<ClientResult<CaptureStateV1>>;
    stop(): Promise<ClientResult<CaptureStateV1>>;
    subscribe(listener: (event: CaptureEventV1) => void): () => void;
  };
  observation: {
    status(): Promise<ClientResult<ObservationStatusV1>>;
    configure(input: ObservationConfigureInput): Promise<ClientResult<ObservationStatusV1>>;
    stop(): Promise<ClientResult<ObservationStatusV1>>;
    subscribe(listener: (value: ObservationStatusV1) => void): () => void;
  };
};

export const PROTOCOL_SCHEME = "openminion";
export const PROTOCOL_HOST = "app";
export const CLIENT_TOKEN_HEADER = "X-OpenMinion-Client-Token";
export const DESKTOP_CAPABILITIES = [
  "daemon.health",
  "daemon.ready",
  "client.capabilities",
  "client.lease.renew",
  "client.lease.revoke",
  "sessions.list",
  "sessions.create",
  "sessions.load",
  "sessions.close",
  "sessions.events",
  "turns.submit",
  "turns.cancel",
  "turns.tool_progress",
  "approvals.decide",
  "media.upload",
  "media.read",
  "media.release",
  "artifacts.catalog.v1",
  "artifacts.content.v1",
  "artifacts.detach_restore.v1",
  "tool_outputs.read.v1",
] as const;
export const IPC_CHANNELS = {
  reportsRead: "openminion:reports:read",
  sessionsExport: "openminion:sessions:export",
  tasksControl: "openminion:tasks:control",
  profilesRead: "openminion:profiles:read",
  profilesPresets: "openminion:profiles:presets",
  profilesSetup: "openminion:profiles:setup",
  profilesSave: "openminion:profiles:save",
  profilesImport: "openminion:profiles:import",
  copyText: "openminion:copy-text",
  daemonStatus: "openminion:daemon-status",
  daemonRetry: "openminion:daemon-retry",
  sessionsList: "openminion:sessions-list",
  sessionsCreate: "openminion:sessions-create",
  sessionsLoad: "openminion:sessions-load",
  sessionsClose: "openminion:sessions-close",
  sessionsEvents: "openminion:sessions-events",
  turnsSubmit: "openminion:turns-submit",
  turnsCancel: "openminion:turns-cancel",
  approvalsDecide: "openminion:approvals-decide",
  artifactsList: "openminion:artifacts-list",
  artifactsRead: "openminion:artifacts-read",
  artifactsDetach: "openminion:artifacts-detach",
  artifactsRestore: "openminion:artifacts-restore",
  filesPick: "openminion:files-pick",
  filesList: "openminion:files-list",
  filesImport: "openminion:files-import",
  filesRelease: "openminion:files-release",
  mediaPick: "openminion:media-pick",
  mediaRelease: "openminion:media-release",
  turnEvent: "openminion:turn-event",
  captureStatus: "openminion:capture-status",
  captureSources: "openminion:capture-sources",
  captureStart: "openminion:capture-start",
  capturePause: "openminion:capture-pause",
  captureResume: "openminion:capture-resume",
  captureStop: "openminion:capture-stop",
  captureEvent: "openminion:capture-event",
  observationStatus: "desktop:observation:status",
  observationConfigure: "desktop:observation:configure",
  observationStop: "desktop:observation:stop",
  observationEvent: "desktop:observation:event",
} as const;
