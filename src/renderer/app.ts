import type { CustomCommand } from "../shared/reports.js";
import type {
  ApprovalDecision,
  ApprovalDecisionV1,
  ApprovalEventV1,
  ArtifactCatalogItemV1,
  ArtifactContentKind,
  CaptureCandidateV1,
  CaptureEventV1,
  CaptureFrameV1,
  CapturePublicSourceKind,
  CaptureRegionV1,
  CaptureSourceKind,
  CaptureStateV1,
  ClientResult,
  DaemonStatus,
  ErrorV1,
  FileGrantV1,
  InferenceUsageV1,
  MediaAttachmentV1,
  MessageV1,
  NativeApi,
  ObservationFrameFactV1,
  ObservationStatusV1,
  RuntimeUpdateStatus,
  SessionEventV1,
  SessionSummaryV1,
  ToolProgressV1,
  ToolDisplay,
  TurnEventV1,
  TurnInputQueueEntry,
  TurnSubmitValue,
  TurnUsageDisplay,
} from "../shared/contracts.js";
import type { DelegationControlInput, ScheduleInput, TaskAction } from "../shared/tasks.js";
import { renderMarkdown } from "./markdown.js";
import { identitySourceLabel, identityStatusLabel } from "./identity.js";
import { mountProfiles } from "./profiles.js";
import { renderDelegation, renderTasks } from "./tasks.js";
import { renderToolProfile } from "./tool-profile.js";

declare global {
  interface Window {
    openminion: NativeApi;
  }
}

export type StatusView = {
  label: string;
  summary: string;
  tone: "pending" | "ready" | "degraded";
  showRetry: boolean;
  showRecovery: boolean;
};

export type ChatState = {
  sessionId: string | null;
  traceId: string | null;
  terminalTraceId: string | null;
  active: boolean;
  disconnected: boolean;
  startedAt: number | null;
  stopRequested: boolean;
  label: string;
  error: ErrorV1 | null;
  detail: string;
  lastUpdateAt: number | null;
};

export type RecoveredSession = {
  session: SessionSummaryV1;
  messages: MessageV1[];
  events: SessionEventV1[];
};

export type ActivityItem = ToolProgressV1 | ApprovalEventV1;

export const DESKTOP_COMMANDS = [
  {
    name: "/help",
    description: "Show commands currently connected in Desktop",
    usage: "/help [connected-command]",
  },
  { name: "/new", description: "Start a new session", usage: "/new [session]" },
  { name: "/sessions", description: "Pick a session" },
  { name: "/close", description: "Close the current session" },
  {
    name: "/tasks",
    description: "Inspect and control tasks",
    usage: "/tasks [task-id] · /tasks pause|resume|cancel <task-id>",
  },
  {
    name: "/delegate",
    description: "Delegate work or inspect a delegated task",
    usage: "/delegate [async] <agent> <instruction> · /delegate inspect <task-id>",
  },
  {
    name: "/agents",
    description: "List agents or find one by ID or name",
    usage: "/agents [agent-id-or-label]",
  },
  {
    name: "/tools",
    description: "View tools and manage access profiles",
    usage: "/tools [status|list|activate <profile>|deactivate <profile>]",
  },
  { name: "/mcp", description: "Show configured and exposed MCP servers" },
  { name: "/skills", description: "List skills or inspect one by ID", usage: "/skills [skill-id]" },
  {
    name: "/learning",
    description: "Show skill-learning proposals",
    usage: "/learning [proposal-id]",
  },
  {
    name: "/identity",
    description: "Show, verify, or reload the active identity",
    usage: "/identity [verify|reload]",
  },
  { name: "/tokens", description: "Show durable token usage details" },
  { name: "/export", description: "Export the saved conversation" },
  {
    name: "/status",
    description: "Show connection, conversation, agent, and model",
  },
  {
    name: "/model",
    description: "Show reported model (selection not connected yet)",
  },
  { name: "/copy", description: "Copy the latest reply or tool output" },
  { name: "/clear", description: "Clear the visible chat; keep saved history" },
  { name: "/quiet", description: "Hide tool activity; keep approvals visible" },
  { name: "/normal", description: "Show concise tool output" },
  { name: "/verbose", description: "Show full available tool output" },
  {
    name: "/details",
    description: "Toggle full tool output",
    usage: "/details [on|off|quiet|toggle]",
  },
  {
    name: "/graph",
    description: "Show graph help or check readiness",
    usage: "/graph [status]",
  },
  { name: "/editor", description: "Show Desktop composer shortcuts" },
] as const;

export const DESKTOP_ALIASES: Record<string, string> = {
  "/": "/help",
  "/session": "/sessions",
  "/cls": "/clear",
  "/task": "/tasks",
  "/agent": "/agents",
  "/tool": "/tools",
};

export function commandMatches(text: string, customCommands: CustomCommand[] = []) {
  const name = text.trim().split(/\s+/, 1)[0];
  return [...DESKTOP_COMMANDS, ...customCommands].filter(
    (command) =>
      command.name.startsWith(name) ||
      Object.entries(DESKTOP_ALIASES).some(
        ([alias, target]) => target === command.name && alias.startsWith(name),
      ),
  );
}

function isTaskCommand(text: string): boolean {
  const name = text.trim().split(/\s+/, 1)[0];
  return (DESKTOP_ALIASES[name] ?? name) === "/tasks";
}

export type ArtifactView = {
  item: ArtifactCatalogItemV1;
  contentKind: ArtifactContentKind;
  text: string | null;
};

type GuidancePending = {
  sessionId: string;
  requestId: string | null;
  traceId: string | null;
  started: boolean;
  resultReceived: boolean;
  frame: CaptureFrameV1;
  captureId: string;
  sourceKind: CapturePublicSourceKind;
  sourceLabel: string;
  selectedFrame: ObservationFrameFactV1 | null;
  sentFrame: ObservationFrameFactV1 | null;
  responseText: string | null;
  completed: boolean;
};

type GuidanceView = {
  sessionId: string;
  traceId: string;
  text: string;
  frame: ObservationFrameFactV1;
  captureId: string;
  sourceKind: CapturePublicSourceKind;
  sourceLabel: string;
  state: "current" | "stale";
  staleReason: "newer_frame" | "capture_inactive" | "source_changed" | "frame_expired" | null;
};

export function captureStatusCopy(state: CaptureStateV1 | null, hasSession: boolean): string {
  if (!hasSession) return "Choose a session to observe a screen or window.";
  if (!state) return "Computer observation is unavailable in this desktop build.";
  if (state.state === "observing") return `Observing ${state.sourceLabel ?? "computer"} locally.`;
  if (state.state === "paused") return "Observation paused. No preview frames are retained.";
  if (state.state === "selecting") return "Choose a screen or window to observe.";
  if (state.state === "starting" || state.state === "stopping") {
    return state.state === "starting"
      ? "Starting local observation…"
      : "Stopping local observation…";
  }
  const reasons: Partial<Record<CaptureStateV1["reason"], string>> = {
    permission_required: "Screen recording permission is required before observation can start.",
    permission_denied: "Screen recording permission was denied.",
    permission_restricted: "Screen recording is restricted on this computer.",
    permission_unknown: "Screen recording permission could not be verified.",
    source_enumeration_failed: "Available screens and windows could not be listed.",
    source_timeout: "Source selection timed out. Try choosing it again.",
    source_missing: "The selected source is no longer available.",
    source_ended: "Observation stopped because the selected source ended.",
    source_expired: "The source selection expired. Choose it again.",
    source_changed: "The source changed. Choose it again before observing.",
    display_changed: "Observation stopped because the display arrangement changed.",
    region_invalid: "The selected region is not available on this source.",
    screen_locked: "Observation stopped while the screen was locked.",
    system_suspended: "Observation stopped while the computer was suspended.",
    renderer_lost: "Observation stopped because the desktop view was closed.",
    session_changed: "Observation stopped when the active session changed.",
    session_closed: "Observation stopped when the session closed.",
    worker_failed: "Observation stopped because the local capture worker failed.",
    frame_invalid: "Observation stopped after an invalid preview frame.",
    frame_too_large: "Observation stopped because the preview exceeded its local limit.",
    worker_timeout: "Observation stopped because the local capture worker timed out.",
    internal_error: "Observation stopped after a local capture error.",
    unsupported: "Computer observation is unavailable on this system.",
  };
  return reasons[state.reason] ?? "Ready to observe a screen or window locally.";
}

export function observationStatusCopy(
  status: ObservationStatusV1 | null,
  hasSession: boolean,
): string {
  if (!hasSession) return "Choose a session and start local capture.";
  if (!status) return "OpenMinion observation is unavailable in this desktop build.";
  if (status.lastError) return status.lastError.message;
  const copy: Record<ObservationStatusV1["state"], string> = {
    idle: "Choose a session and start local capture.",
    ready: "Ready. Include the current view in a message or enable watch.",
    selecting: "Selecting the current frame…",
    uploading: "Uploading the selected frame to the local daemon…",
    inferencing: "OpenMinion is analyzing the sent frame…",
    waiting:
      status.trigger === "changes" ? "Watching for a changed frame." : "Watching every 30 seconds.",
    stopping: "Stopping observation safely…",
    failed: "Observation stopped after an error.",
  };
  return copy[status.state];
}

export function captureRegionFromPercentages(values: readonly string[]): CaptureRegionV1 | null {
  if (values.length !== 4) return null;
  const percentages = values.map(Number);
  if (percentages.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = percentages;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) {
    return null;
  }
  const region = {
    xBps: Math.round(x * 100),
    yBps: Math.round(y * 100),
    widthBps: Math.round(width * 100),
    heightBps: Math.round(height * 100),
  };
  if (
    region.xBps < 0 ||
    region.yBps < 0 ||
    region.widthBps < 1 ||
    region.heightBps < 1 ||
    region.xBps + region.widthBps > 10_000 ||
    region.yBps + region.heightBps > 10_000
  )
    return null;
  return region;
}

const DEGRADED_STATUS_SUMMARIES: Readonly<Record<string, string>> = {
  python_environment_failed: "Install Python 3.11 on this computer, then reconnect.",
  openminion_install_failed:
    "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
  openminion_executable_unavailable:
    "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
  runtime_root_unavailable:
    "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
  openminion_version_mismatch: "Check Runtime settings for a compatible update, then reconnect.",
  runtime_incompatible: "Check Runtime settings for a compatible update, then reconnect.",
  runtime_recovery_required:
    "Open Connection details and restart Desktop. Runtime recovery needs review.",
  config_initialization_failed:
    "Check Connection details and the configured OpenMinion paths, then restart Desktop.",
  daemon_roots_unavailable:
    "Check Connection details and the configured OpenMinion paths, then restart Desktop.",
  daemon_ownership_unverified: "Stop the externally managed daemon, then reconnect from Desktop.",
  invalid_daemon_status: "Check Connection details, then reconnect the local OpenMinion daemon.",
  daemon_status_failed: "Check Connection details, then reconnect the local OpenMinion daemon.",
  daemon_unavailable: "Check Connection details, then reconnect the local OpenMinion daemon.",
  daemon_start_failed: "Check Connection details, then reconnect the local OpenMinion daemon.",
  runtime_health_failed: "Check Connection details, then reconnect the local OpenMinion daemon.",
  daemon_stop_failed: "Quit Desktop and any remaining OpenMinion process, then reopen Desktop.",
};

export function statusView(status: DaemonStatus): StatusView {
  if (status.state === "ready" || status.capabilities.includes("turns.text")) {
    return {
      label: "Connected",
      summary:
        status.state === "ready"
          ? "Ready for messages."
          : "Connected to your local OpenMinion daemon.",
      tone: "ready",
      showRetry: false,
      showRecovery: false,
    };
  }
  if (status.state === "running") {
    return {
      label: "OpenMinion running",
      summary: "The local runtime is ready; Desktop chat is not connected yet.",
      tone: "pending",
      showRetry: false,
      showRecovery: true,
    };
  }
  if (status.state === "degraded") {
    return {
      label: "Not connected",
      summary:
        (status.errorCode && DEGRADED_STATUS_SUMMARIES[status.errorCode]) ||
        "Reconnect to send messages.",
      tone: "degraded",
      showRetry: true,
      showRecovery: true,
    };
  }
  return {
    label: "Connecting",
    summary: "Finding your local OpenMinion daemon…",
    tone: "pending",
    showRetry: false,
    showRecovery: false,
  };
}

export function initialChatState(): ChatState {
  return {
    sessionId: null,
    traceId: null,
    terminalTraceId: null,
    active: false,
    disconnected: false,
    startedAt: null,
    stopRequested: false,
    label: "Choose or create a conversation to begin.",
    error: null,
    detail: "",
    lastUpdateAt: null,
  };
}

export function applyTurnEvent(state: ChatState, event: TurnEventV1): ChatState {
  if (event.kind === "started") {
    if (
      !state.active ||
      (state.sessionId !== null && event.sessionId !== state.sessionId) ||
      (state.traceId !== null && event.traceId !== state.traceId)
    ) {
      return state;
    }
    return {
      ...state,
      sessionId: event.sessionId,
      traceId: event.traceId,
      terminalTraceId: null,
      active: true,
      startedAt: state.startedAt ?? Date.now(),
      label: "Working…",
      error: null,
      detail: "",
      lastUpdateAt: Date.now(),
    };
  }
  if (event.sessionId !== state.sessionId || event.traceId !== state.traceId) {
    return state;
  }
  if (event.kind === "connection") {
    return {
      ...state,
      active: event.state !== "unavailable",
      disconnected: event.state === "disconnected",
      traceId: event.state === "unavailable" ? null : state.traceId,
      label: event.error?.message ?? "Working…",
      error: event.error,
      detail: "",
      lastUpdateAt: Date.now(),
    };
  }
  if (event.kind === "progress") {
    if (state.stopRequested) return state;
    return {
      ...state,
      label: event.progressKind === "status" ? event.label?.trim() || "Working…" : "Writing…",
      detail: event.progressKind === "status" ? event.detailText?.trim() || "" : "",
      lastUpdateAt: Date.now(),
    };
  }
  if (event.kind === "response") {
    return {
      ...state,
      label: event.errors[0]?.message ?? (state.stopRequested ? state.label : "Finishing…"),
      error: event.errors[0] ?? null,
      detail: "",
      lastUpdateAt: Date.now(),
    };
  }
  if (event.kind === "error") {
    return {
      ...state,
      label: event.error.message,
      error: event.error,
      detail: "",
      lastUpdateAt: Date.now(),
    };
  }
  if (event.kind === "tool" || event.kind === "approval") {
    return state;
  }
  return {
    ...state,
    traceId: null,
    terminalTraceId: event.traceId,
    active: false,
    stopRequested: false,
    detail: "",
    lastUpdateAt: null,
    label:
      event.outcome === "complete"
        ? ""
        : event.outcome === "cancelled"
          ? "Stopped."
          : (state.error?.message ?? "Something went wrong. Try again."),
  };
}

export function applySubmitResult(state: ChatState, result: TurnSubmitValue): ChatState {
  if (
    !state.active ||
    state.sessionId !== result.sessionId ||
    state.traceId === result.traceId ||
    state.terminalTraceId === result.traceId
  ) {
    return state;
  }
  return {
    ...state,
    traceId: result.traceId,
    active: true,
    startedAt: state.startedAt ?? Date.now(),
    label: state.stopRequested ? state.label : "Working…",
  };
}

export function applyActivityEvent(activity: ActivityItem[], event: ActivityItem): ActivityItem[] {
  const key = activityKey(event);
  const prior = activity.find((item) => activityKey(item) === key);
  if (
    prior?.kind === "approval" &&
    event.kind === "approval" &&
    prior.outcome !== "pending" &&
    event.outcome === "pending"
  )
    return activity;
  if (
    prior?.kind === "tool" &&
    event.kind === "tool" &&
    prior.phase === "completed" &&
    event.phase === "started"
  )
    return activity;
  const next =
    event.kind === "approval" && prior?.kind === "approval"
      ? {
          ...event,
          consentPreview: event.consentPreview || prior.consentPreview,
          requestedAt: event.requestedAt ?? prior.requestedAt,
          expiresAt: event.expiresAt ?? prior.expiresAt,
        }
      : event;
  return [...activity.filter((item) => activityKey(item) !== key), next];
}

export function recoverActivity(sessionId: string, events: SessionEventV1[]): ActivityItem[] {
  return events.reduce<ActivityItem[]>((activity, event) => {
    const item = activityFromSessionEvent(sessionId, event);
    return item ? applyActivityEvent(activity, item) : activity;
  }, []);
}

export async function listSessions(api: NativeApi): Promise<SessionSummaryV1[] | ErrorV1> {
  const sessions: SessionSummaryV1[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await api.sessions.list(
      cursor === undefined ? { limit: 100 } : { cursor, limit: 100 },
    );
    if (!result.ok) {
      return result.error;
    }
    sessions.push(...result.value.sessions);
    if (!result.value.hasMore) {
      return sessions;
    }
    const next = result.value.nextCursor;
    if (!next || seen.has(next)) {
      return cursorError("session");
    }
    seen.add(next);
    cursor = next;
  }
}

export async function listArtifacts(
  api: NativeApi,
  sessionId: string,
): Promise<ArtifactCatalogItemV1[] | ErrorV1> {
  const artifacts: ArtifactCatalogItemV1[] = [];
  const artifactIds = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  while (true) {
    pages += 1;
    if (pages > 4096) {
      return invalidArtifactResponse();
    }
    const result = await api.artifacts.list(
      cursor === undefined ? { sessionId, limit: 100 } : { sessionId, cursor, limit: 100 },
    );
    if (!result.ok) {
      return result.error;
    }
    const pageIds = new Set(result.value.artifacts.map((item) => item.artifactId));
    if (
      pageIds.size !== result.value.artifacts.length ||
      result.value.artifacts.some((item) => artifactIds.has(item.artifactId))
    ) {
      return invalidArtifactResponse();
    }
    result.value.artifacts.forEach((item) => {
      artifactIds.add(item.artifactId);
    });
    artifacts.push(...result.value.artifacts);
    if (artifacts.length > 256) {
      return invalidArtifactResponse();
    }
    if (result.value.complete) {
      return artifacts;
    }
    const next = result.value.nextCursor;
    if (!next) {
      return cursorError("artifact");
    }
    cursor = next;
  }
}

export async function readArtifact(
  api: NativeApi,
  item: ArtifactCatalogItemV1,
): Promise<ArtifactView | ErrorV1> {
  const pages: string[] = [];
  let cursor: string | undefined;
  let contentKind: ArtifactContentKind | null = null;
  let pageCount = 0;
  let totalBytes = 0;
  while (true) {
    pageCount += 1;
    if (pageCount > 4) {
      return invalidArtifactResponse();
    }
    const result = await api.artifacts.read(
      cursor === undefined
        ? {
            sessionId: item.sessionId,
            artifactId: item.artifactId,
            limitBytes: 64 * 1024,
          }
        : {
            sessionId: item.sessionId,
            artifactId: item.artifactId,
            cursor,
            limitBytes: 64 * 1024,
          },
    );
    if (!result.ok) {
      return result.error;
    }
    if (contentKind !== null && contentKind !== result.value.contentKind) {
      return invalidArtifactResponse();
    }
    if (
      result.value.contentKind !== item.contentKind ||
      (result.value.contentKind === "unavailable" && item.kind !== "tool_output")
    ) {
      return invalidArtifactResponse();
    }
    contentKind = result.value.contentKind;
    if (result.value.text !== null) {
      pages.push(result.value.text);
      totalBytes += new TextEncoder().encode(result.value.text).byteLength;
      if (totalBytes > 256 * 1024) {
        return invalidArtifactResponse();
      }
    }
    if (result.value.complete) {
      return {
        item,
        contentKind,
        text: contentKind === "unavailable" ? null : pages.join(""),
      };
    }
    const next = result.value.nextCursor;
    if (!next) {
      return cursorError("artifact");
    }
    cursor = next;
  }
}

export async function recoverSession(
  api: NativeApi,
  sessionId: string,
): Promise<RecoveredSession | ErrorV1> {
  const loaded = await api.sessions.load({ sessionId, messageLimit: 200 });
  if (!loaded.ok) {
    return loaded.error;
  }
  let session = loaded.value.session;
  const messages = [...loaded.value.messages];
  const messageCursors = new Set<string>();
  let messageCursor = loaded.value.nextMessageCursor;
  let messagesHaveMore = loaded.value.messagesHasMore;
  while (messagesHaveMore) {
    if (!messageCursor || messageCursors.has(messageCursor)) {
      return cursorError("message");
    }
    messageCursors.add(messageCursor);
    const page = await api.sessions.load({
      sessionId,
      messageAfter: messageCursor,
      messageLimit: 200,
    });
    if (!page.ok) {
      return page.error;
    }
    session = page.value.session;
    messages.push(...page.value.messages);
    messageCursor = page.value.nextMessageCursor;
    messagesHaveMore = page.value.messagesHasMore;
  }

  const events: SessionEventV1[] = [];
  const eventCursors = new Set<string>();
  let eventCursor = session.eventCursor;
  while (true) {
    if (eventCursors.has(eventCursor)) {
      return cursorError("event");
    }
    eventCursors.add(eventCursor);
    const page = await api.sessions.events({
      sessionId,
      after: eventCursor,
      limit: 200,
    });
    if (!page.ok) {
      return page.error;
    }
    events.push(...page.value.events);
    if (!page.value.hasMore) {
      break;
    }
    if (!page.value.nextCursor || page.value.nextCursor === eventCursor) {
      return cursorError("event");
    }
    eventCursor = page.value.nextCursor;
  }
  return {
    session,
    messages,
    events,
  };
}

export async function mount(api: NativeApi, root: Document = document): Promise<void> {
  const elements = rendererElements(root);
  const info = await api.app.info();
  elements.shellVersion.textContent = info.shellVersion;
  let sessions: SessionSummaryV1[] = [];
  let selected: SessionSummaryV1 | null = null;
  let renamingSession: SessionSummaryV1 | null = null;
  const legacyNames: { sessionId: string; title: string }[] = [];
  const legacyKeys: string[] = [];
  let legacyStorage: Storage | null = null;
  let legacyReadFailed = false;
  try {
    legacyStorage = root.defaultView?.localStorage ?? null;
    if (legacyStorage) {
      for (let index = 0; index < legacyStorage.length; index += 1) {
        const key = legacyStorage.key(index)!;
        if (!key.startsWith("openminion.task-name:")) continue;
        legacyKeys.push(key);
        legacyNames.push({
          sessionId: key.slice("openminion.task-name:".length),
          title: legacyStorage.getItem(key)!,
        });
      }
    }
  } catch {
    // Retain legacy names when browser storage cannot be read; retry on next launch.
    legacyStorage = null;
    legacyReadFailed = true;
  }
  const savedNames = legacyReadFailed
    ? {
        ok: false as const,
        error: {
          message: "Could not read existing chat names. Restart the app to try again.",
        },
      }
    : await api.chatNames.load(legacyNames);
  const names = new Map(
    (savedNames.ok ? savedNames.value : legacyNames).map(({ sessionId, title }) => [
      sessionId,
      title,
    ]),
  );
  if (savedNames.ok && legacyStorage) {
    try {
      for (const key of legacyKeys) legacyStorage.removeItem(key);
    } catch {
      // SQLite records the completed import, so a leftover key cannot restore a reset name.
    }
  }
  const savedPresentation = await api.presentation.load();
  const taskName = (session: SessionSummaryV1): string =>
    names.get(session.sessionId) || session.title || "Untitled conversation";
  let savingName = false;
  let renameGeneration = 0;
  let renameFromSidebar = false;
  let contextSession: SessionSummaryV1 | null = null;
  let contextAnchor: HTMLButtonElement | null = null;
  let daemonReady = false;
  let connecting = true;
  let richContextReady = false;
  let creatingTask = false;
  let savingSubmission = false;
  let queuePending = false;
  let queuedInputs: TurnInputQueueEntry[] = [];
  let queueMessage = "";
  let pendingRunNext: { sessionId: string; text: string } | null = null;
  let pendingDraftTransfer: string | null = null;
  const reconnectingTurns = new Set<string>();
  let conversationLoading = false;
  let waitTimer: ReturnType<typeof setInterval> | null = null;
  let messages: MessageV1[] = [];
  const savedDrafts = await api.drafts.load();
  const drafts = new Map<string, string>(
    (savedDrafts.ok ? savedDrafts.value : []).map((draft) => [draft.sessionId, draft.text]),
  );
  const draftStatus = required(root, "draft-status");
  const draftErrors = new Map<string, string>();
  const draftSaves = new Map<string, number>();
  const showDraftStatus = () => {
    draftStatus.textContent =
      draftErrors.get(selected?.sessionId ?? "") ??
      (savedDrafts.ok ? "" : savedDrafts.error.message);
    draftStatus.hidden = !draftStatus.textContent;
  };
  const saveDraft = async (sessionId: string, text: string) => {
    drafts.set(sessionId, text);
    const generation = (draftSaves.get(sessionId) ?? 0) + 1;
    draftSaves.set(sessionId, generation);
    const clearUnbound = pendingDraftTransfer === sessionId;
    const result = await api.drafts.save({
      sessionId,
      text,
      ...(clearUnbound ? { clearUnbound: true as const } : {}),
    });
    if (result.ok && clearUnbound) {
      drafts.delete("");
      pendingDraftTransfer = null;
    }
    if (draftSaves.get(sessionId) === generation) {
      if (result.ok) draftErrors.delete(sessionId);
      else draftErrors.set(sessionId, result.error.message);
      showDraftStatus();
    }
    return result;
  };
  elements.composer.value = drafts.get("") ?? "";
  showDraftStatus();
  let submittedText: string | null = null;
  let responseText = "";
  let latestCopyText: string | null = null;
  let responseUsage: InferenceUsageV1 | undefined;
  const liveTurns = new Map<
    string,
    {
      state: ChatState;
      messages: MessageV1[];
      submittedText: string;
      responseText: string;
      latestCopyText: string | null;
      responseUsage?: InferenceUsageV1;
      activity: ActivityItem[];
    }
  >();
  let hiddenMessageCount = 0;
  let toolDisplay: ToolDisplay = savedPresentation.ok
    ? savedPresentation.value.toolDisplay
    : "normal";
  const display = required(root, "chat-display") as HTMLSelectElement;
  const displayStatus = required(root, "chat-display-status");
  display.value = toolDisplay;
  const saveDisplay = async (next: ToolDisplay) => {
    if (display.disabled) return;
    display.disabled = true;
    displayStatus.textContent = "Saving…";
    const result = await api.presentation.save({ toolDisplay: next });
    if (result.ok) toolDisplay = next;
    display.value = toolDisplay;
    display.disabled = false;
    displayStatus.textContent = result.ok ? "Saved." : result.error.message;
    renderChat();
    return result;
  };
  display.addEventListener("change", () => void saveDisplay(display.value as ToolDisplay));
  let commandIndex = 0;
  let commandDraft: string | null = null;
  let customCommands: CustomCommand[] = [];
  let renderingCommand = false;
  let commandsDismissed = false;
  let activity: ActivityItem[] = [];
  const activityBySession = new Map<string, ActivityItem[]>();
  let attachments: MediaAttachmentV1[] = [];
  let artifacts: ArtifactCatalogItemV1[] = [];
  let artifactView: ArtifactView | null = null;
  let artifactLabel = "Choose a session to view its artifacts.";
  let artifactPending = false;
  let fileGrants: FileGrantV1[] = [];
  let fileLabel = "Choose a session to import local files.";
  let attachmentPending = false;
  const deciding = new Set<string>();
  const approvalErrors = new Map<string, ErrorV1>();
  const approvalFocus = new Set<string>();
  const announcedApprovals = new Set<string>();
  let chat = initialChatState();
  let selectionGeneration = 0;
  let submissionGeneration = 0;
  let captureGeneration = 0;
  let captureState: CaptureStateV1 | null = null;
  let captureCandidates: CaptureCandidateV1[] = [];
  let selectedCandidate: CaptureCandidateV1 | null = null;
  let captureFrame: CaptureFrameV1 | null = null;
  let capturePending = false;
  let captureMessage: string | null = null;
  const captureApi = api.capture as NativeApi["capture"] | undefined;
  const observationApi = api.observation as NativeApi["observation"] | undefined;
  let observationStatus: ObservationStatusV1 | null = null;
  let observationPending = false;
  let observationGeneration = 0;
  let observationMessage: string | null = null;
  let automaticObservation: ObservationFrameFactV1 | null = null;
  let guidancePending: GuidancePending | null = null;
  let guidanceView: GuidanceView | null = null;
  let guidanceMessage = "Write an instruction and keep a current frame to ask for guidance.";
  let guidanceExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGuidanceTimer = () => {
    if (guidanceExpiryTimer !== null) clearTimeout(guidanceExpiryTimer);
    guidanceExpiryTimer = null;
  };

  const clearGuidance = () => {
    clearGuidanceTimer();
    guidancePending = null;
    guidanceView = null;
    guidanceMessage = "Write an instruction and keep a current frame to ask for guidance.";
  };

  const turnAttachmentsAreValid = () =>
    attachments.every(
      (attachment) => attachment.sessionId === selected?.sessionId && attachment.turnCompatible,
    );

  const staleGuidanceReason = (
    captureId: string,
    sourceKind: CapturePublicSourceKind,
    sourceLabel: string,
    frame: { frameId: string; contentHash: string; expiresAt: string },
  ): GuidanceView["staleReason"] => {
    if (Date.parse(frame.expiresAt) <= Date.now()) return "frame_expired";
    if (
      captureState?.state !== "observing" ||
      captureState.sessionId !== selected?.sessionId ||
      !captureFrame
    )
      return "capture_inactive";
    if (
      captureState.captureId !== captureId ||
      captureState.sourceKind !== sourceKind ||
      captureState.sourceLabel !== sourceLabel ||
      captureFrame.captureId !== captureId ||
      captureFrame.sourceKind !== sourceKind
    )
      return "source_changed";
    if (captureFrame.frameId !== frame.frameId || captureFrame.contentHash !== frame.contentHash)
      return "newer_frame";
    return null;
  };

  const staleGuidanceCopy = (reason: NonNullable<GuidanceView["staleReason"]>) =>
    ({
      newer_frame: "Guidance is stale because a newer frame is available.",
      capture_inactive: "Guidance is stale because capture is no longer active.",
      source_changed: "Guidance is stale because the capture source changed.",
      frame_expired: "Guidance is stale because its frame expired.",
    })[reason];

  const refreshGuidanceState = () => {
    if (!guidanceView || guidanceView.state === "stale") return;
    const reason = staleGuidanceReason(
      guidanceView.captureId,
      guidanceView.sourceKind,
      guidanceView.sourceLabel,
      guidanceView.frame,
    );
    if (!reason) return;
    guidanceView = { ...guidanceView, state: "stale", staleReason: reason };
    guidanceMessage = staleGuidanceCopy(reason);
    clearGuidanceTimer();
  };

  const scheduleGuidanceExpiry = () => {
    clearGuidanceTimer();
    if (guidanceView?.state !== "current") return;
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, Date.parse(guidanceView.frame.expiresAt) - Date.now()),
    );
    guidanceExpiryTimer = setTimeout(() => {
      guidanceExpiryTimer = null;
      refreshGuidanceState();
      if (guidanceView?.state === "current") scheduleGuidanceExpiry();
      renderGuidance();
    }, delay);
  };

  const settleGuidance = () => {
    const pending = guidancePending;
    if (
      !pending?.started ||
      !pending.resultReceived ||
      !pending.completed ||
      !pending.responseText ||
      !pending.requestId ||
      !pending.traceId
    )
      return;
    if (
      !matchesGuidanceFrame(pending.selectedFrame, pending, true) ||
      !matchesGuidanceFrame(pending.sentFrame, pending, true) ||
      pending.selectedFrame.selectedAt !== pending.sentFrame.selectedAt ||
      pending.selectedFrame.sentAt !== pending.sentFrame.sentAt
    )
      return;
    const staleReason = staleGuidanceReason(
      pending.captureId,
      pending.sourceKind,
      pending.sourceLabel,
      pending.frame,
    );
    guidanceView = {
      sessionId: pending.sessionId,
      traceId: pending.traceId,
      text: pending.responseText,
      frame: { ...pending.sentFrame },
      captureId: pending.captureId,
      sourceKind: pending.sourceKind,
      sourceLabel: pending.sourceLabel,
      state: staleReason ? "stale" : "current",
      staleReason,
    };
    guidancePending = null;
    guidanceMessage = staleReason
      ? staleGuidanceCopy(staleReason)
      : "Guidance is grounded in the displayed sent frame.";
    scheduleGuidanceExpiry();
  };

  const acceptGuidanceObservation = (status: ObservationStatusV1) => {
    const pending = guidancePending;
    if (!pending || status.sessionId !== pending.sessionId) return;
    if (matchesGuidanceFrame(status.selectedFrame, pending, false)) {
      pending.selectedFrame = { ...status.selectedFrame };
    }
    if (matchesGuidanceFrame(status.sentFrame, pending, true)) {
      pending.sentFrame = { ...status.sentFrame };
    }
    settleGuidance();
  };

  const renderGuidance = () => {
    refreshGuidanceState();
    const eligible = Boolean(
      richContextReady &&
        selected &&
        selected.status !== "closed" &&
        !conversationLoading &&
        !chat.active &&
        !attachmentPending &&
        attachments.length <= 3 &&
        turnAttachmentsAreValid() &&
        elements.composer.value.trim() &&
        guidanceSnapshot(selected.sessionId, captureState, captureFrame),
    );
    elements.askGuidance.disabled = !eligible;
    elements.guidanceStatus.textContent = guidanceMessage;
    elements.guidanceStatus.hidden = !guidanceView && !guidancePending;
    elements.guidanceCard.hidden = guidanceView === null;
    elements.guidanceState.textContent = guidanceView?.state === "stale" ? "Stale" : "Current";
    elements.guidanceText.textContent = guidanceView?.text ?? "";
    const previewUrl = guidanceView?.state === "current" ? guidanceView.frame.previewUrl : "";
    elements.guidancePreview.src = previewUrl;
    elements.guidancePreview.hidden = !previewUrl;
    elements.guidanceFacts.textContent = guidanceView
      ? `${guidanceView.sourceLabel} · ${guidanceView.sourceKind} · ${guidanceView.frame.width} × ${guidanceView.frame.height} · captured ${relativeAge(guidanceView.frame.capturedAt)} · sent ${relativeAge(guidanceView.frame.sentAt!)} · ${expiryCopy(guidanceView.frame.expiresAt)}`
      : "";
  };

  const renderObservationFrame = (
    container: HTMLElement,
    preview: HTMLImageElement,
    facts: HTMLElement,
    frame: ObservationFrameFactV1 | null,
    label: string,
  ) => {
    container.hidden = frame === null;
    preview.src = frame?.previewUrl ?? "";
    facts.textContent = frame
      ? `${label} · ${frame.width} × ${frame.height} · ${frame.reason.replace("_", " ")} · ${relativeAge(frame.capturedAt)} · ${expiryCopy(frame.expiresAt)}`
      : "";
  };

  const renderObservation = () => {
    elements.includeScreenshotControl.hidden = !richContextReady;
    elements.askGuidance.hidden = !richContextReady;
    elements.watchSettings.hidden = !richContextReady;
    const writable = Boolean(
      richContextReady && selected && selected.status !== "closed" && observationApi,
    );
    const state = observationStatus?.state ?? "idle";
    elements.observationState.textContent = state[0]!.toUpperCase() + state.slice(1);
    elements.observationStatus.textContent = richContextReady
      ? (observationMessage ?? observationStatusCopy(observationStatus, writable))
      : "Screenshot sending and automatic watch are not connected to this runtime.";
    const configuring = ["selecting", "uploading", "inferencing", "stopping", "failed"].includes(
      state,
    );
    elements.observationInstruction.disabled = !writable || observationPending || configuring;
    elements.observationTrigger.disabled = elements.observationInstruction.disabled;
    elements.startObservation.disabled =
      !writable ||
      observationPending ||
      configuring ||
      captureState?.state !== "observing" ||
      !elements.observationInstruction.value.trim();
    elements.stopObservation.disabled =
      !writable ||
      observationPending ||
      (!observationStatus?.watchEnabled && !configuring && state !== "failed");
    elements.includeCurrentView.disabled =
      !writable ||
      chat.active ||
      attachmentPending ||
      captureState?.state !== "observing" ||
      captureFrame === null ||
      attachments.length > 3;
    elements.screenContextStatus.textContent = observationStatus?.watchEnabled
      ? "Automatic watch preview · delivery is not connected"
      : captureState?.state === "observing"
        ? elements.includeCurrentView.checked
          ? "Included with next message · latest eligible frame"
          : "Local preview only · screenshot not included"
        : captureStatusCopy(captureState, selected !== null);
    renderObservationFrame(
      elements.observationSelected,
      elements.observationSelectedPreview,
      elements.observationSelectedFacts,
      observationStatus?.selectedFrame ?? null,
      "Selected",
    );
    renderObservationFrame(
      elements.observationSent,
      elements.observationSentPreview,
      elements.observationSentFacts,
      observationStatus?.sentFrame ?? null,
      "Sent",
    );
    const counters = observationStatus?.counters;
    const rates = observationStatus?.rates;
    elements.observationCounters.textContent =
      counters && rates
        ? `Capture ${counters.captureFrames} frames / ${formatBytes(counters.captureBytes)} · ${rates.capturedFrames}/min · Inference ${counters.inferencesStarted} started, ${counters.inferencesCompleted} completed · ${rates.inferencesStarted}/min`
        : "No observation activity yet.";
    const usage = observationStatus?.usage;
    elements.observationUsage.textContent = usage?.usageAvailable
      ? `${usage.inputTokens} input + ${usage.outputTokens} output tokens · ${usage.llmCalls} model call${usage.llmCalls === 1 ? "" : "s"} · ${usage.durationMs} ms · Cost unavailable`
      : "Inference usage unavailable.";
    renderGuidance();
  };

  const regionInput = (): CaptureRegionV1 | null =>
    captureRegionFromPercentages([
      elements.captureRegionX.value,
      elements.captureRegionY.value,
      elements.captureRegionWidth.value,
      elements.captureRegionHeight.value,
    ]);

  const renderCapture = () => {
    const writable = Boolean(selected && selected.status !== "closed" && captureApi);
    const state = captureState?.state ?? "idle";
    elements.captureState.textContent = state[0]!.toUpperCase() + state.slice(1);
    elements.captureStatus.textContent =
      captureMessage ?? captureStatusCopy(captureState, writable);
    elements.captureSourceKind.disabled =
      !writable || capturePending || state === "observing" || state === "paused";
    const sourceKind = elements.captureSourceKind.value as CaptureSourceKind;
    elements.captureEntireScreen.disabled = elements.captureSourceKind.disabled;
    elements.captureWindow.disabled = elements.captureSourceKind.disabled;
    elements.captureEntireScreen.className = `source-toggle-button${sourceKind === "display" ? " selected" : ""}`;
    elements.captureWindow.className = `source-toggle-button${sourceKind === "window" ? " selected" : ""}`;
    elements.captureEntireScreen.setAttribute(
      "aria-pressed",
      sourceKind === "display" ? "true" : "false",
    );
    elements.captureWindow.setAttribute("aria-pressed", sourceKind === "window" ? "true" : "false");
    elements.observeComputer.disabled = elements.captureSourceKind.disabled;
    renderCaptureCandidates(
      root,
      elements.captureCandidates,
      captureCandidates,
      selectedCandidate?.candidateId ?? null,
      capturePending,
      (candidate) => {
        selectedCandidate = candidate;
        elements.captureRegionControls.hidden = false;
        elements.captureRegionImage.src = candidate.previewUrl;
        renderCapture();
      },
    );
    const region = elements.captureRegionEnabled.checked ? regionInput() : null;
    const regionValid = !elements.captureRegionEnabled.checked || region !== null;
    elements.startCapture.disabled =
      !writable || capturePending || !selectedCandidate || !regionValid;
    elements.captureRegionImage.src = selectedCandidate?.previewUrl ?? "";
    renderRegionOverlay(elements, region);
    const live =
      state === "observing" || state === "paused" || state === "starting" || state === "stopping";
    elements.captureCandidates.hidden = live;
    elements.captureRegionControls.hidden = live || selectedCandidate === null;
    elements.captureLive.hidden = !live;
    elements.screenContextSummary.hidden = !live;
    elements.screenContextName.textContent = captureState?.sourceLabel ?? "Screen context";
    elements.screenContextName.setAttribute("title", elements.screenContextName.textContent);
    const previewUrl = state === "observing" && captureFrame ? captureFrame.previewUrl : "";
    elements.capturePreview.src = previewUrl;
    elements.capturePreview.hidden = !previewUrl;
    elements.screenContextPreview.src = previewUrl;
    elements.screenContextPreview.hidden = !previewUrl;
    elements.pauseCapture.hidden = state !== "observing";
    elements.resumeCapture.hidden = state !== "paused";
    elements.pauseCapture.disabled = capturePending;
    elements.resumeCapture.disabled = capturePending;
    elements.changeCapture.disabled = capturePending;
    elements.stopCapture.disabled = capturePending;
    elements.captureFacts.textContent = captureFacts(captureState, captureFrame);
    renderObservation();
  };

  const resetCaptureSelection = () => {
    captureCandidates = [];
    selectedCandidate = null;
    captureFrame = null;
    elements.captureRegionControls.hidden = true;
    elements.captureRegionEnabled.checked = false;
  };

  const applyCaptureState = (state: CaptureStateV1) => {
    if (state.sessionId !== null && state.sessionId !== selected?.sessionId) return;
    captureMessage = null;
    captureState = state;
    if (state.state !== "observing") {
      captureFrame = null;
      elements.includeCurrentView.checked = false;
    }
    if (["idle", "blocked", "failed"].includes(state.state)) resetCaptureSelection();
    renderCapture();
  };

  const runCaptureAction = async (action: () => Promise<ClientResult<CaptureStateV1>>) => {
    if (!captureApi || capturePending) return false;
    const generation = captureGeneration;
    const sessionId = selected?.sessionId ?? null;
    capturePending = true;
    renderCapture();
    const result = await action();
    if (generation !== captureGeneration || selected?.sessionId !== sessionId) return false;
    capturePending = false;
    if (!result.ok) {
      if (["capture_source_expired", "capture_source_missing"].includes(result.error.code)) {
        resetCaptureSelection();
      }
      await refreshCaptureStatus();
      if (generation !== captureGeneration || selected?.sessionId !== sessionId) return false;
      captureMessage = result.error.message;
      renderCapture();
      return false;
    }
    applyCaptureState(result.value);
    return true;
  };

  const refreshCaptureStatus = async () => {
    if (!captureApi) {
      renderCapture();
      return;
    }
    const generation = captureGeneration;
    const sessionId = selected?.sessionId ?? null;
    const result = await captureApi.status();
    if (generation !== captureGeneration || selected?.sessionId !== sessionId) return;
    if (result.ok) applyCaptureState(result.value);
    else {
      captureState = null;
      captureMessage = result.error.message;
      renderCapture();
    }
  };

  const refreshObservationStatus = async () => {
    if (!observationApi) {
      observationStatus = null;
      renderObservation();
      return;
    }
    const generation = observationGeneration;
    const sessionId = selected?.sessionId ?? null;
    const result = await observationApi.status();
    if (generation !== observationGeneration || selected?.sessionId !== sessionId) return;
    if (result.ok && (result.value.sessionId === null || result.value.sessionId === sessionId)) {
      observationStatus = result.value;
      observationMessage = null;
    }
    renderObservation();
  };

  const observeComputer = async () => {
    if (!captureApi || !selected || selected.status === "closed" || capturePending) return;
    const generation = captureGeneration;
    const sessionId = selected.sessionId;
    capturePending = true;
    captureCandidates = [];
    selectedCandidate = null;
    captureFrame = null;
    captureState = captureState ? { ...captureState, state: "selecting" } : null;
    captureMessage = "Looking for available screens and windows…";
    renderCapture();
    const sourceKind = elements.captureSourceKind.value as CaptureSourceKind;
    const result = await captureApi.sources({ sessionId, sourceKind });
    if (generation !== captureGeneration || selected?.sessionId !== sessionId) return;
    capturePending = false;
    if (!result.ok) {
      await refreshCaptureStatus();
      if (generation !== captureGeneration || selected?.sessionId !== sessionId) return;
      captureMessage = result.error.message;
      renderCapture();
      return;
    }
    captureCandidates = result.value.candidates;
    captureMessage = captureCandidates.length
      ? "Choose a source. Labels and previews are sanitized locally."
      : "No matching sources are available.";
    renderCapture();
  };

  const renderFiles = () => {
    const writable = Boolean(
      richContextReady && selected && selected.status !== "closed" && api.files,
    );
    elements.chooseFile.disabled = !writable || chat.active || attachmentPending;
    elements.fileStatus.textContent = richContextReady
      ? fileLabel
      : "File import is not connected to this runtime.";
    renderFileGrants(
      root,
      elements.fileGrantList,
      fileGrants,
      attachmentPending || !writable,
      (grant, action) => {
        if (action === "release") void releaseGrant(grant);
        else void importGrant(grant);
      },
    );
  };

  const releaseGrant = async (grant: FileGrantV1) => {
    if (!api.files || attachmentPending) return;
    const generation = selectionGeneration;
    attachmentPending = true;
    renderFiles();
    const result = await api.files.release({
      sessionId: grant.sessionId,
      grantId: grant.grantId,
    });
    attachmentPending = false;
    if (generation !== selectionGeneration || selected?.sessionId !== grant.sessionId) {
      renderChat();
      return;
    }
    if (!result.ok) {
      fileLabel = result.error.message;
    } else {
      fileGrants = fileGrants.filter((item) => item.grantId !== grant.grantId);
      fileLabel = "File grant released.";
    }
    renderFiles();
    renderChat();
  };

  const importGrant = async (grant: FileGrantV1) => {
    if (!api.files || attachmentPending || attachments.length >= 4) return;
    const generation = selectionGeneration;
    attachmentPending = true;
    fileLabel = "Importing the selected file…";
    renderChat();
    const result = await api.files.import({
      sessionId: grant.sessionId,
      grantId: grant.grantId,
    });
    attachmentPending = false;
    if (generation !== selectionGeneration || selected?.sessionId !== grant.sessionId) {
      if (result.ok) releaseAttachments(api, [result.value.attachment]);
      renderChat();
      return;
    }
    if (!result.ok) {
      fileLabel = result.error.message;
      renderChat();
      return;
    }
    if (attachments.length + 1 > 4) {
      releaseAttachments(api, [result.value.attachment]);
      fileLabel = "Select no more than four attachments.";
      renderChat();
      return;
    }
    attachments = [...attachments, result.value.attachment];
    fileLabel = "File imported into the composer.";
    renderChat();
  };

  const pickFileGrant = async () => {
    if (!api.files || !selected || selected.status === "closed" || chat.active || attachmentPending)
      return;
    const generation = selectionGeneration;
    const sessionId = selected.sessionId;
    attachmentPending = true;
    fileLabel = "Waiting for local selection…";
    renderChat();
    const result = await api.files.pick({ sessionId, kind: "file" });
    attachmentPending = false;
    if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
      if (result.ok && result.value.grant)
        void api.files.release({
          sessionId,
          grantId: result.value.grant.grantId,
        });
      renderChat();
      return;
    }
    if (!result.ok) {
      fileLabel = result.error.message;
    } else if (!result.value.grant) {
      fileLabel = "No local file selected.";
    } else {
      fileGrants = [...fileGrants, result.value.grant];
      fileLabel = "Local file grant ready.";
    }
    renderChat();
  };

  const renderArtifacts = () => {
    const writable = Boolean(richContextReady && selected && selected.status !== "closed");
    elements.refreshArtifacts.disabled = !writable || artifactPending;
    elements.artifactStatus.textContent = richContextReady
      ? artifactLabel
      : "Artifact browsing is not connected to this runtime.";
    renderArtifactList(
      root,
      elements.artifactList,
      artifacts,
      artifactPending || !writable,
      async (item, action) => {
        if (
          !selected ||
          selected.status === "closed" ||
          artifactPending ||
          item.sessionId !== selected.sessionId
        ) {
          return;
        }
        const generation = selectionGeneration;
        artifactPending = true;
        artifactLabel =
          action === "read" ? "Loading artifact content…" : "Updating artifact state…";
        if (action === "read") {
          artifactView = null;
        }
        renderArtifacts();
        if (action === "read") {
          const result = await readArtifact(api, item);
          if (generation !== selectionGeneration) {
            return;
          }
          artifactPending = false;
          if ("code" in result) {
            artifactLabel = result.message;
          } else {
            artifactView = result;
            artifactLabel =
              result.contentKind === "unavailable"
                ? "Content unavailable."
                : "Artifact content loaded.";
          }
          renderArtifacts();
          return;
        }
        const result = await api.artifacts[action]({
          sessionId: item.sessionId,
          artifactId: item.artifactId,
        });
        if (generation !== selectionGeneration) {
          return;
        }
        artifactPending = false;
        if (!result.ok) {
          artifactLabel = result.error.message;
          renderArtifacts();
          return;
        }
        await loadArtifacts(selected.sessionId, generation);
      },
    );
    renderArtifactDetail(
      elements.artifactDetail,
      elements.artifactDetailTitle,
      elements.artifactContent,
      artifactView,
    );
  };

  const loadArtifacts = async (sessionId: string, generation = selectionGeneration) => {
    artifactPending = true;
    artifactLabel = "Loading artifacts…";
    artifactView = null;
    renderArtifacts();
    if (!api.artifacts) {
      if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
        return;
      }
      artifactPending = false;
      artifacts = [];
      artifactLabel = "Artifacts are unavailable in this desktop build.";
      renderArtifacts();
      return;
    }
    const result = await listArtifacts(api, sessionId);
    if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
      return;
    }
    artifactPending = false;
    if ("code" in result) {
      artifacts = [];
      artifactLabel = result.message;
    } else {
      artifacts = result;
      artifactLabel = result.length
        ? `${result.length} session output${result.length === 1 ? "" : "s"}.`
        : "No artifacts or tool outputs yet.";
    }
    renderArtifacts();
  };

  const hideCommandMenu = () => {
    commandsDismissed = true;
    elements.commandMenu.hidden = true;
    elements.showCommands.setAttribute("aria-expanded", "false");
    elements.composer.removeAttribute("aria-activedescendant");
    if (commandDraft !== null) {
      elements.composer.value = commandDraft;
      commandDraft = null;
      void saveDraft(selected?.sessionId ?? "", elements.composer.value);
    }
  };

  const renderCommandMenu = () => {
    const value = elements.composer.value.trim();
    const matches = commandMatches(value, customCommands);
    if (commandsDismissed || !value.startsWith("/") || !matches.length) {
      elements.commandMenu.hidden = true;
      elements.showCommands.setAttribute("aria-expanded", "false");
      elements.composer.removeAttribute("aria-activedescendant");
      return;
    }
    commandIndex = Math.min(commandIndex, matches.length - 1);
    elements.commandMenu.replaceChildren(
      ...matches.map((command, index) => {
        const button = root.createElement("button");
        button.id = `command-option-${index}`;
        button.type = "button";
        button.className = `command-option${index === commandIndex ? " active" : ""}`;
        button.setAttribute("role", "option");
        button.setAttribute("tabindex", "-1");
        button.setAttribute("aria-selected", String(index === commandIndex));
        const name = root.createElement("span");
        name.className = "command-name";
        name.textContent = command.name;
        const description = root.createElement("span");
        description.className = "command-description";
        description.textContent = command.description;
        button.append(name, description);
        if ("usage" in command) {
          const usage = root.createElement("span");
          usage.className = "command-usage";
          usage.textContent = command.usage;
          button.append(usage);
        }
        button.addEventListener(
          "click",
          () => void runCommand(value.replace(/^\S+/, command.name)),
        );
        return button;
      }),
    );
    elements.commandMenu.hidden = false;
    elements.showCommands.setAttribute("aria-expanded", "true");
    elements.composer.setAttribute("aria-activedescendant", `command-option-${commandIndex}`);
    elements.commandMenu.children[commandIndex]?.scrollIntoView({
      block: "nearest",
    });
  };

  let commandResultGeneration = 0;
  const hideCommandResult = () => {
    commandResultGeneration += 1;
    elements.commandPanel.hidden = true;
    renderJumpToLatest();
  };
  elements.closeCommand.addEventListener("click", () => {
    hideCommandResult();
    elements.composer.focus();
  });
  elements.commandPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideCommandResult();
      elements.composer.focus();
    }
  });
  const showCommandResult = (title: string, text: string) => {
    commandResultGeneration += 1;
    elements.commandTitle.textContent = title;
    const paragraph = root.createElement("p");
    paragraph.textContent = text;
    const copy = root.createElement("button");
    copy.type = "button";
    copy.className = "quiet-button";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy command result");
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      try {
        const result = await api.app.copyText(text);
        copy.textContent = result.ok ? "Copied" : "Copy failed";
      } catch {
        copy.textContent = "Copy failed";
      }
    });
    elements.commandResult.replaceChildren(paragraph, copy);
    elements.commandPanel.hidden = false;
    renderJumpToLatest();
    elements.commandPanel.scrollIntoView({ block: "start" });
  };

  const showSkills = async (skillId?: string) => {
    const title = skillId ? "Skill details" : "Skill catalog";
    const sessionId = selected?.sessionId;
    showCommandResult(title, "Loading from OpenMinion…");
    const request = commandResultGeneration;
    const result = await api.reports.read({
      kind: "skills",
      ...(skillId ? { skillId } : sessionId ? { sessionId } : {}),
    });
    if (
      request !== commandResultGeneration ||
      sessionId !== selected?.sessionId ||
      elements.commandPanel.hidden
    )
      return;
    if (!result.ok) showCommandResult(title, result.error.message);
    else if (result.value.kind === "skills") {
      const report = result.value;
      if ("text" in report) showCommandResult(title, report.text);
      else {
        const catalogTitle = report.agentId
          ? `Stored skills for ${report.agentId}`
          : "Global skill catalog";
        const text = report.skills.length
          ? `${catalogTitle}:\n${report.skills.join("\n")}`
          : report.agentId
            ? "No stored skills for this agent."
            : "No global skills have been added.";
        showCommandResult(catalogTitle, text);
        if (report.skills.length) {
          const catalog = elements.commandResult.children[0];
          catalog.className = "skill-catalog";
          catalog.replaceChildren(
            ...report.skills.map((id) => {
              const button = root.createElement("button");
              button.type = "button";
              button.className = "quiet-button";
              button.textContent = id;
              button.addEventListener("click", () => void showSkills(id));
              return button;
            }),
          );
        }
      }
    }
    if (skillId) {
      const back = root.createElement("button");
      back.type = "button";
      back.className = "quiet-button";
      back.textContent = "Back to catalog";
      back.addEventListener("click", () => void showSkills());
      elements.commandResult.append(back);
    }
  };

  let diagnosticsGeneration = 0;
  let diagnosticsTrigger = elements.showDaemonStatus;
  elements.closeDiagnostics.addEventListener("click", () => elements.diagnosticsDialog.close());
  elements.diagnosticsDialog.addEventListener("close", () => {
    if (elements.diagnosticsDialog.open) return;
    diagnosticsGeneration += 1;
    const focusTarget = diagnosticsTrigger.disabled
      ? elements.settingsRuntimeButton
      : diagnosticsTrigger;
    focusTarget.focus();
  });
  const inspectDaemon = async (kind: "status" | "logs") => {
    if (elements.showDaemonStatus.disabled) return;
    elements.showDaemonStatus.disabled = true;
    elements.showDaemonLogs.disabled = true;
    const title = kind === "logs" ? "Daemon logs" : "Daemon status";
    diagnosticsTrigger = kind === "logs" ? elements.showDaemonLogs : elements.showDaemonStatus;
    elements.diagnosticsTitle.textContent = title;
    const summary = root.createElement("p");
    summary.setAttribute("role", "status");
    summary.textContent = "Reading from OpenMinion…";
    elements.diagnosticsResult.replaceChildren(summary);
    if (!elements.diagnosticsDialog.open) elements.diagnosticsDialog.showModal();
    const generation = ++diagnosticsGeneration;
    try {
      const result = await api.daemon.inspect(kind);
      if (generation !== diagnosticsGeneration || !elements.diagnosticsDialog.open) return;
      summary.textContent = result.ok
        ? kind === "logs"
          ? "Latest 200 lines. Refresh to read newer entries."
          : "Current status from OpenMinion."
        : result.error.message;
      const actions = root.createElement("div");
      actions.className = "diagnostic-actions";
      elements.diagnosticsResult.append(actions);
      const refresh = root.createElement("button");
      refresh.type = "button";
      refresh.className = "quiet-button diagnostic-control";
      refresh.textContent = "Refresh";
      refresh.addEventListener("click", () => void inspectDaemon(kind));
      actions.append(refresh);
      if (result.ok) {
        const output = root.createElement("pre");
        output.className = "diagnostic-output";
        output.textContent = result.value.text;
        const copy = root.createElement("button");
        copy.type = "button";
        copy.className = "quiet-button diagnostic-control";
        copy.textContent = "Copy";
        copy.addEventListener("click", async () => {
          const copied = await api.app.copyText(result.value.text);
          copy.textContent = copied.ok ? "Copied" : "Copy failed";
        });
        actions.append(copy);
        elements.diagnosticsResult.append(output);
      }
    } finally {
      elements.showDaemonStatus.disabled = false;
      elements.showDaemonLogs.disabled = false;
    }
  };
  elements.showDaemonStatus.addEventListener("click", () => void inspectDaemon("status"));
  elements.showDaemonLogs.addEventListener("click", () => void inspectDaemon("logs"));

  const runTasks = async (action: TaskAction, taskId?: string, schedule?: ScheduleInput) => {
    if (!selected || !api.tasks) {
      if (schedule) return "Choose a saved conversation first.";
      showCommandResult("Tasks", "Choose a saved conversation first.");
      return;
    }
    if (chat.active && !["list", "show"].includes(action)) {
      if (schedule) return "Finish or stop this turn before scheduling work.";
      showCommandResult("Turn in progress", "Finish or stop this turn before changing work.");
      return;
    }
    const sessionId = selected.sessionId;
    if (!schedule)
      showCommandResult(
        "Tasks",
        action === "list" || action === "show" ? "Loading work…" : "Applying change…",
      );
    const request = commandResultGeneration;
    const result = await api.tasks.control({
      sessionId,
      action,
      taskId,
      ...(schedule ? { schedule } : {}),
    });
    if (request !== commandResultGeneration || selected?.sessionId !== sessionId) return;
    // A dismissed result stays dismissed; completion must not reopen it over the chat.
    if (elements.commandPanel.hidden) return;
    if (!result.ok) {
      if (schedule && result.error.code === "schedule_refresh_failed") {
        showCommandResult("Schedule created", result.error.message);
        const refresh = root.createElement("button");
        refresh.type = "button";
        refresh.textContent = "Refresh work list";
        refresh.addEventListener("click", () => void runTasks("list"));
        elements.commandResult.append(refresh);
        return;
      }
      if (schedule) return result.error.message;
      showCommandResult("Tasks", result.error.message);
      return;
    }
    showCommandResult(
      "Tasks",
      [
        result.value.tasks.length
          ? "Tasks reported by OpenMinion for the current agent."
          : "No tasks found.",
        result.value.scheduler
          ? `Scheduler: ${result.value.scheduler.state}. ${
              result.value.scheduler.state === "ready"
                ? "Scheduled work is ready to run."
                : "Saved schedules remain manageable, but execution readiness is degraded."
            }`
          : "",
        result.value.pendingActions.length
          ? `${result.value.pendingActions.length} pending approvals. Resolve them in Focus.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    renderTasks(
      root,
      elements.commandResult,
      result.value,
      chat.active,
      (nextAction, id) => {
        if (selected?.sessionId === sessionId) void runTasks(nextAction, id);
      },
      (schedule) =>
        selected?.sessionId === sessionId
          ? runTasks("schedule", undefined, schedule)
          : Promise.resolve("Choose the original conversation before scheduling work."),
    );
  };

  const runDelegation = async (
    input: Omit<DelegationControlInput, "sessionId"> = { action: "list" },
  ): Promise<string | undefined> => {
    if (!selected) {
      showCommandResult("Delegation", "Choose a saved conversation first.");
      return "Choose a saved conversation first.";
    }
    const sessionId = selected.sessionId;
    showCommandResult(
      "Delegation",
      input.action === "sync" || input.action === "async"
        ? "Delegating work…"
        : input.action === "cancel" || input.action === "resume"
          ? "Applying delegation change…"
          : "Reading delegated work…",
    );
    const request = commandResultGeneration;
    const result = await api.delegation.control({ sessionId, ...input });
    if (request !== commandResultGeneration || selected?.sessionId !== sessionId) return;
    if (elements.commandPanel.hidden) return;
    if (!result.ok) {
      showCommandResult("Delegation", `${result.error.code}: ${result.error.message}`);
      return result.error.message;
    }
    showCommandResult(
      "Delegation",
      result.value.taskId
        ? `Delegation ${result.value.taskId} · ${result.value.status}`
        : `${result.value.tasks.length} delegated task${result.value.tasks.length === 1 ? "" : "s"}`,
    );
    renderDelegation(
      root,
      elements.commandResult,
      result.value,
      chat.active,
      runDelegation,
      async (childSessionId) => {
        await loadSessions();
        const child = sessions.find((session) => session.sessionId === childSessionId);
        if (!child) return "The child conversation is not available to this Desktop session.";
        await selectSession(child);
        hideCommandResult();
      },
    );
    return undefined;
  };

  const loadCustomCommands = async () => {
    const sessionId = selected?.sessionId;
    const generation = selectionGeneration;
    if (!sessionId) return;
    const result = await api.reports.read({ kind: "commands", sessionId });
    if (generation !== selectionGeneration) return;
    customCommands = result.ok && result.value.kind === "commands" ? result.value.commands : [];
    renderCommandMenu();
    return result;
  };

  const runCommand = async (text: string): Promise<boolean> => {
    const value = text.trim();
    if (!value.startsWith("/") || value.startsWith("//")) return false;
    const [name, ...args] = value.split(/\s+/);
    const command = DESKTOP_ALIASES[name] ?? name;
    if (args.length === 1 && ["--help", "?"].includes(args[0])) {
      return runCommand(`/help ${command}`);
    }
    const generation = selectionGeneration;
    const invocationDraft = elements.composer.value;
    if (!DESKTOP_COMMANDS.some((item) => item.name === command) && selected) {
      const discovered = await loadCustomCommands();
      if (generation !== selectionGeneration || elements.composer.value !== invocationDraft)
        return true;
      if (discovered && !discovered.ok) {
        showCommandResult("Custom commands unavailable", discovered.error.message);
        return true;
      }
    }
    if (
      !DESKTOP_COMMANDS.some((item) => item.name === command) &&
      customCommands.some((item) => item.name === command)
    ) {
      if (!selected || renderingCommand || savingSubmission) return true;
      if (chat.active || conversationLoading) {
        showCommandResult(
          "Custom command",
          "Wait for this conversation to finish loading or responding, then send your command.",
        );
        return true;
      }
      const sessionId = selected.sessionId;
      const draft = elements.composer.value;
      renderingCommand = true;
      const result = await api.reports.read({
        kind: "command",
        sessionId,
        commandName: command,
        arguments: value.slice(name.length).trimStart(),
      });
      renderingCommand = false;
      if (generation !== selectionGeneration || elements.composer.value !== draft || chat.active)
        return true;
      if (!result.ok) {
        showCommandResult("Custom command", result.error.message);
        return true;
      }
      if (result.value.kind !== "command") return true;
      commandDraft = null;
      hideCommandMenu();
      elements.composer.value = result.value.prompt;
      await submitTurn(false, true);
      return true;
    }
    if (!DESKTOP_COMMANDS.some((item) => item.name === command)) {
      hideCommandMenu();
      showCommandResult(
        "Command unavailable",
        `${name} is not available in Desktop. Type /help for supported commands. This text was not sent to the model.`,
      );
      return true;
    }
    if (
      args.length &&
      command !== "/tools" &&
      command !== "/graph" &&
      command !== "/tasks" &&
      command !== "/delegate" &&
      command !== "/agents" &&
      command !== "/skills" &&
      command !== "/learning" &&
      command !== "/identity" &&
      command !== "/details" &&
      command !== "/help" &&
      !(command === "/new" && args.join(" ") === "session")
    ) {
      hideCommandMenu();
      showCommandResult(
        "Command arguments",
        `${command} arguments are not connected in Desktop yet. Use Focus/CLI for this operation.`,
      );
      return true;
    }
    elements.composer.value = commandDraft ?? "";
    commandDraft = null;
    hideCommandMenu();
    void saveDraft(selected?.sessionId ?? "", elements.composer.value);
    elements.composer.focus();
    switch (command) {
      case "/skills":
        if (args.length > 1) showCommandResult("Skills", "Use /skills or /skills <skill-id>.");
        else await showSkills(args[0]);
        break;
      case "/agents":
      case "/tools":
      case "/tokens":
      case "/learning":
      case "/mcp":
      case "/graph": {
        if (["/agents", "/tools"].includes(command) && args.length && chat.active) {
          showCommandResult(
            "Turn in progress",
            "Finish or stop this turn before using these command arguments.",
          );
          break;
        }
        const kind = command.slice(1) as
          | "agents"
          | "tools"
          | "tokens"
          | "learning"
          | "mcp"
          | "graph";
        const titles = {
          agents: "Agents",
          tools: "Tools",
          tokens: "Token usage",
          learning: "Skill learning",
          mcp: "MCP",
          graph: args[0] === "status" ? "Graph status" : "Graph help",
        };
        if (kind === "tokens" && !selected) {
          showCommandResult(titles[kind], "No active session.");
          break;
        }
        if (kind === "tools" && ["activate", "deactivate"].includes(args[0])) {
          if (!selected || args.length > 2) {
            showCommandResult(
              "Tool access",
              "Choose a saved conversation and use /tools activate <profile> or /tools deactivate <profile>. Set options in the form.",
            );
            break;
          }
          const sessionId = selected.sessionId;
          showCommandResult("Tool access", "");
          renderToolProfile(
            root,
            elements.commandResult,
            {
              sessionId,
              action: args[0] as "activate" | "deactivate",
              profileId: args[1] ?? "",
            },
            (input) =>
              selected?.sessionId === sessionId && !chat.active
                ? api.tools.control(input)
                : Promise.resolve({
                    ok: false,
                    error: {
                      code: "session_changed",
                      message:
                        "Choose this conversation and finish its turn before changing tool access.",
                      retryable: false,
                      retryAfterMs: null,
                    },
                  }),
          );
          break;
        }
        if (
          kind === "tools" &&
          (args.length > 1 || (args.length === 1 && !["status", "list"].includes(args[0])))
        ) {
          showCommandResult(
            "Tool access",
            "Use /tools status, list, activate <profile>, or deactivate <profile>.",
          );
          break;
        }
        if (kind === "graph" && (args.length > 1 || (args.length === 1 && args[0] !== "status"))) {
          showCommandResult(
            "Graph commands",
            "Use /graph for help or /graph status to check readiness. Other graph operations are not connected in Desktop yet.",
          );
          break;
        }
        const sessionId = selected?.sessionId;
        showCommandResult(titles[kind], "Loading from OpenMinion…");
        const request = commandResultGeneration;
        const result = await api.reports.read({
          kind,
          ...(sessionId && !["learning", "graph"].includes(kind) ? { sessionId } : {}),
          ...(kind === "graph" && args[0] === "status" ? { graphView: "status" as const } : {}),
          ...(kind === "tools" ? { toolView: (args[0] ?? "status") as "status" | "list" } : {}),
          ...(kind === "agents" && args.length ? { agentFilter: args.join(" ") } : {}),
          ...(kind === "learning" && args.length ? { proposalId: args.join(" ") } : {}),
        });
        if (request !== commandResultGeneration || sessionId !== selected?.sessionId) break;
        if (elements.commandPanel.hidden) break;
        if (!result.ok) showCommandResult(titles[kind], result.error.message);
        else {
          const report = result.value;
          let text: string;
          if (report.kind === "agents")
            text =
              report.agents
                .map(
                  (agent) =>
                    `${agent.id === report.activeAgentId ? "● " : ""}${agent.id}${agent.label !== agent.id ? ` — ${agent.label}` : ""}`,
                )
                .join("\n") || "No matching agents.";
          else if (report.kind === "tools" && "tools" in report)
            text =
              report.tools
                .map((tool) => `${tool.name}${tool.enabled ? "" : " · disabled"}`)
                .join("\n") || "No tools.";
          else if ("text" in report) text = report.text;
          else return true;
          showCommandResult(titles[kind], text);
          if (kind === "graph" && !args.length) {
            const button = root.createElement("button");
            button.type = "button";
            button.className = "secondary-tool";
            button.textContent = "Check readiness";
            button.addEventListener("click", () => {
              commandDraft = elements.composer.value;
              void runCommand("/graph status");
            });
            elements.commandResult.append(button);
          }
          if (kind === "tools" && selected) {
            for (const action of ["activate", "deactivate"] as const) {
              const button = root.createElement("button");
              button.type = "button";
              button.className = "secondary-tool";
              button.textContent =
                action === "activate" ? "Activate profile…" : "Deactivate profile…";
              button.addEventListener("click", () => void runCommand(`/tools ${action}`));
              elements.commandResult.append(button);
            }
          }
        }
        break;
      }
      case "/export": {
        if (!selected) {
          showCommandResult("Export conversation", "Choose a saved conversation first.");
          break;
        }
        const sessionId = selected.sessionId;
        showCommandResult("Export conversation", "Preparing the saved conversation…");
        const request = commandResultGeneration;
        const result = await api.sessions.export({ sessionId });
        if (request !== commandResultGeneration || sessionId !== selected?.sessionId) break;
        showCommandResult(
          "Export conversation",
          result.ok
            ? result.value.cancelled
              ? "Export cancelled."
              : "Conversation saved."
            : result.error.message,
        );
        break;
      }
      case "/tasks": {
        if (!args.length) await runTasks("list");
        else if (["pause", "resume", "cancel"].includes(args[0].toLowerCase()) && args.length === 2)
          await runTasks(args[0].toLowerCase() as TaskAction, args[1]);
        else if (
          args.length === 1 &&
          !["pause", "resume", "cancel"].includes(args[0].toLowerCase())
        )
          await runTasks("show", args[0]);
        else
          showCommandResult(
            "Task command",
            "Use /tasks, /tasks <task-id>, or /tasks pause|resume|cancel <task-id>.",
          );
        break;
      }
      case "/delegate": {
        const action = args[0]?.toLowerCase();
        if (!action) await runDelegation();
        else if (action === "list" && args.length <= 2) {
          const limit = args[1] === undefined ? 20 : Number(args[1]);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            showCommandResult("Delegation command", "Use /delegate list [1-200].");
          else await runDelegation({ action: "list", limit });
        } else if (
          ["status", "resume", "result", "inspect", "cancel"].includes(action) &&
          args.length === 2
        )
          await runDelegation({
            action: action as "status" | "resume" | "result" | "inspect" | "cancel",
            taskId: args[1],
          });
        else {
          const explicitMode = action === "sync" || action === "async";
          const mode = explicitMode ? action : "sync";
          const targetAgentId = explicitMode ? args[1] : args[0];
          const instruction = (explicitMode ? args.slice(2) : args.slice(1)).join(" ");
          if (!targetAgentId || !instruction)
            showCommandResult(
              "Delegation command",
              "Use /delegate [sync|async] <agent> <instruction>, /delegate list, or /delegate status|resume|result|inspect|cancel <task-id>.",
            );
          else
            await runDelegation({
              action: mode,
              targetAgentId,
              instruction,
              timeoutSeconds: 120,
            });
        }
        break;
      }
      case "/identity": {
        const action = args[0]?.toLowerCase() ?? "show";
        if (args.length > 1 || !["show", "verify", "reload"].includes(action)) {
          showCommandResult(
            "Identity command",
            "Use /identity, /identity verify, or /identity reload.",
          );
          break;
        }
        if (!selected?.activeAgentId) {
          showCommandResult("Identity", "Choose a saved conversation with an active agent first.");
          break;
        }
        const sessionId = selected.sessionId;
        const agentId = selected.activeAgentId;
        showCommandResult(
          "Identity",
          action === "reload" ? "Reloading identity…" : "Reading identity…",
        );
        const request = commandResultGeneration;
        const result =
          action === "reload" ? await api.identity.reload() : await api.identity.read();
        if (request !== commandResultGeneration || selected?.sessionId !== sessionId) break;
        if (elements.commandPanel.hidden) break;
        if (!result.ok) {
          showCommandResult("Identity", result.error.message);
          break;
        }
        const profile = result.value.profiles.find((item) => item.agentId === agentId);
        if (!profile) {
          showCommandResult("Identity", `No identity profile is configured for ${agentId}.`);
          break;
        }
        showCommandResult(
          action === "reload"
            ? "Identity reloaded"
            : action === "verify"
              ? "Identity verification"
              : "Identity",
          [
            `${profile.displayName} (${profile.agentId})`,
            `Source: ${identitySourceLabel(profile.source)}`,
            `Profile version: ${profile.profileVersion}`,
            `Verification: ${profile.validationOk ? "valid" : "needs attention"}`,
            `Source status: ${identityStatusLabel(profile.sourceStatus)}`,
            `Generated file sync: ${identityStatusLabel(profile.generatedStatus)}`,
            `Purpose: ${profile.render.purpose}`,
            `Render budget: ${profile.render.budget.usedTokens}/${profile.render.budget.maxTokens} tokens`,
            `Render version: ${profile.render.renderVersion}`,
            `Included fields: ${profile.render.includedFields.join(", ") || "None"}`,
            `Omitted fields: ${profile.render.omittedFields.join(", ") || "None"}`,
            ...profile.validationWarnings.map((warning) => `Validation warning: ${warning}`),
            ...profile.render.warnings.map((warning) => `Render warning: ${warning}`),
            ...profile.verificationIssues.map((issue) => `Issue: ${issue}`),
            "",
            profile.render.text,
          ].join("\n"),
        );
        break;
      }
      case "/help": {
        if (args.length) {
          const target = args.join(" ");
          const requested = target.startsWith("/") ? target : `/${target}`;
          const canonical = DESKTOP_ALIASES[requested] ?? requested;
          const item = [...DESKTOP_COMMANDS, ...customCommands].find(
            (candidate) => candidate.name === canonical,
          );
          showCommandResult(
            "Command help",
            item
              ? `${item.name} — ${item.description}\n${"usage" in item ? item.usage : item.name}`
              : `${requested} is not connected in Desktop. Type /help for supported commands.`,
          );
          break;
        }
        showCommandResult(
          "Focus commands — partial integration",
          "Desktop presents OpenMinion Focus. Only the commands below are connected so far; model selection and other Focus operations still require integration. Type / and use ↑ / ↓. Enter runs a command; Tab completes its name. Escape dismisses the menu. Use // for a message beginning with /.",
        );
        for (const item of [...DESKTOP_COMMANDS, ...customCommands]) {
          const button = root.createElement("button");
          button.type = "button";
          button.className = "command-option";
          button.textContent = `${item.name}  ${item.description}`;
          button.addEventListener("click", () => {
            hideCommandResult();
            void runCommand(item.name);
          });
          elements.commandResult.append(button);
        }
        break;
      }
      case "/editor":
        showCommandResult(
          "Desktop composer",
          "Continue typing in the composer. Press Shift+Enter for a new line, Enter to send, and Escape to dismiss command results.",
        );
        break;
      case "/new": {
        const button = elements.newSession;
        if (!daemonReady || button.disabled)
          showCommandResult(
            "Conversation unavailable",
            "Connect OpenMinion and finish or cancel the active turn before changing this conversation.",
          );
        else button.click();
        break;
      }
      case "/close":
        if (elements.closeSession.disabled)
          showCommandResult(
            "Close conversation",
            "Choose an open conversation and finish or stop its active turn first.",
          );
        else elements.closeSession.click();
        break;
      case "/sessions": {
        showCommandResult("Choose a conversation", "Loading conversations…");
        const request = commandResultGeneration;
        const generation = selectionGeneration;
        const catalog = await listSessions(api);
        if (request !== commandResultGeneration || generation !== selectionGeneration) break;
        if (!Array.isArray(catalog)) {
          showCommandResult("Conversations unavailable", catalog.message);
          break;
        }
        showCommandResult(
          "Choose a conversation",
          catalog.length
            ? "Choose a saved conversation."
            : "No saved conversations. Create a new conversation to begin.",
        );
        for (const session of catalog) {
          const button = root.createElement("button");
          button.type = "button";
          button.className = "command-option session-option";
          if (session.sessionId === selected?.sessionId)
            button.setAttribute("aria-current", "true");
          const title = root.createElement("strong");
          title.textContent = taskName(session);
          const id = root.createElement("span");
          id.textContent = session.sessionId;
          const facts = root.createElement("small");
          facts.textContent = [
            session.status,
            `Agent: ${session.activeAgentId ?? "Not reported"}`,
            `Channel: ${session.channel ?? "Not reported"}`,
            `Messages: ${session.messageCount ?? "Not reported"}`,
            `Updated: ${session.updatedLabel ?? "Not reported"}`,
          ].join(" · ");
          button.append(title, id, facts);
          button.addEventListener("click", () => {
            hideCommandResult();
            void selectSession(session);
          });
          elements.commandResult.append(button);
        }
        break;
      }
      case "/status": {
        const sessionId = selected?.sessionId;
        if (!sessionId) {
          showCommandResult("Conversation status", "No conversation selected.");
          break;
        }
        showCommandResult("Conversation status", "Reading conversation status…");
        const request = commandResultGeneration;
        const result = await api.reports.read({ kind: "status", sessionId });
        if (request !== commandResultGeneration || sessionId !== selected?.sessionId) break;
        if (!result.ok) showCommandResult("Conversation status", result.error.message);
        else if (result.value.kind === "status") {
          const session = result.value.session;
          showCommandResult(
            "Conversation status",
            [
              elements.connectionLabel.textContent,
              `Conversation: ${taskName(session)}`,
              `Session: ${session.sessionId}`,
              `State: ${session.status}`,
              `Agent: ${session.activeAgentId ?? "Not reported"}`,
              `Channel: ${session.channel ?? "Not reported"}`,
              `Messages: ${session.messageCount ?? "Not reported"}`,
              `Updated: ${session.updatedAt || "Not reported"}`,
              `Provider: ${session.model.provider ?? "Not reported"}`,
              `Model: ${session.model.modelId ?? "Not reported"}`,
              chat.label,
            ].join("\n"),
          );
        }
        break;
      }
      case "/model":
        showCommandResult(
          "Configured model",
          [
            elements.connectionLabel.textContent,
            `Conversation: ${selected ? taskName(selected) : "No conversation selected"}`,
            `Session: ${selected?.sessionId ?? "None"}`,
            `Agent: ${selected?.activeAgentId ?? "Not reported"}`,
            `Provider: ${selected?.model.provider ?? "Not reported"}`,
            `Model: ${selected?.model.modelId ?? "Not reported"}`,
            chat.label,
            "Model selection through Focus is not connected in Desktop yet.",
          ].join("\n"),
        );
        break;
      case "/copy": {
        const reply = messages
          .slice(hiddenMessageCount)
          .findLast((item) => item.role === "assistant");
        let text = latestCopyText ?? (reply ? assistantBody(reply.body, reply.profileName) : null);
        if (latestCopyText === null) {
          let latestAt = reply ? Date.parse(reply.createdAt) : -Infinity;
          for (const item of activity) {
            if (item.kind !== "tool" || item.phase !== "completed" || !item.content) continue;
            const createdAt = Date.parse(item.createdAt);
            if (createdAt > latestAt) {
              text = item.content;
              latestAt = createdAt;
            }
          }
        }
        if (!text) showCommandResult("Copy", "There is no reply or tool output to copy yet.");
        else {
          try {
            const result = await api.app.copyText(text);
            showCommandResult("Copy", result.ok ? "Copied to clipboard." : result.error.message);
          } catch {
            showCommandResult("Copy", "Copy failed");
          }
        }
        break;
      }
      case "/clear":
        if (chat.active)
          showCommandResult(
            "Turn in progress",
            "Finish or cancel this turn before clearing the visible chat.",
          );
        else {
          hiddenMessageCount = messages.length;
          latestCopyText = null;
          activity = [];
          showCommandResult(
            "Chat cleared",
            "Saved history is unchanged. Select the conversation again to restore it.",
          );
        }
        break;
      case "/quiet":
      case "/normal":
      case "/verbose":
      case "/details": {
        let next = command.slice(1) as ToolDisplay;
        if (command === "/details") {
          const option = args.join(" ").toLowerCase();
          if (option === "" || option === "toggle")
            next = toolDisplay === "verbose" ? "normal" : "verbose";
          else if (["on", "verbose", "full", "details"].includes(option)) next = "verbose";
          else if (["off", "normal", "concise"].includes(option)) next = "normal";
          else if (option === "quiet") next = "quiet";
          else {
            showCommandResult("Tool display", "Use /details [on|off|quiet|toggle].");
            break;
          }
        }
        const result = await saveDisplay(next);
        if (result && !result.ok) showCommandResult("Display preference", result.error.message);
        break;
      }
    }
    renderChat();
    return true;
  };

  elements.timeline.addEventListener("click", (event) => {
    const link = (event.target as Element).closest("a[href]");
    if (!link) return;
    event.preventDefault();
    void api.app.openLink(link.getAttribute("href")!).then((result) => {
      if (!result.ok) showCommandResult("Open link", result.error.message);
    });
  });

  const renderJumpToLatest = () => {
    const { scrollHeight, clientHeight, scrollTop } = elements.conversation;
    elements.jumpLatest.hidden =
      scrollHeight - clientHeight - scrollTop <= 48 ||
      !elements.commandMenu.hidden ||
      !elements.commandPanel.hidden;
  };
  elements.conversation.addEventListener("scroll", renderJumpToLatest);
  window.addEventListener("resize", renderJumpToLatest);
  elements.jumpLatest.addEventListener("click", () => {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
    renderJumpToLatest();
    elements.composer.focus();
  });

  const refreshQueue = async (sessionId: string, generation = selectionGeneration) => {
    const result = await api.turns.listQueue({ sessionId });
    if (generation !== selectionGeneration || selected?.sessionId !== sessionId) return;
    if (result.ok) {
      queuedInputs = result.value;
      queueMessage = "";
    } else {
      queueMessage = result.error.message;
    }
    renderChat();
  };

  const renderQueue = () => {
    elements.turnQueue.hidden = !queuedInputs.length && !queueMessage;
    elements.turnQueueStatus.textContent = queueMessage;
    elements.turnQueueStatus.hidden = !queueMessage;
    elements.runNext.hidden = !chat.active || queuedInputs.length === 0;
    elements.runNext.disabled = queuePending || !chat.traceId || !selected?.activeAgentId;
    elements.turnQueueList.replaceChildren(
      ...queuedInputs.map((entry, index) => {
        const item = root.createElement("li");
        const text = root.createElement("span");
        text.className = "turn-queue-text";
        text.textContent = entry.text;
        text.title = entry.text;
        const actions = root.createElement("span");
        actions.className = "turn-queue-actions";
        const controls = [
          {
            label: "Move up",
            disabled: index === 0,
            run: () =>
              api.turns.move({
                sessionId: entry.sessionId,
                queueId: entry.queueId,
                statusVersion: entry.statusVersion,
                beforeQueueId: queuedInputs[index - 1]!.queueId,
              }),
          },
          {
            label: "Move down",
            disabled: index === queuedInputs.length - 1,
            run: () =>
              api.turns.move({
                sessionId: entry.sessionId,
                queueId: entry.queueId,
                statusVersion: entry.statusVersion,
                afterQueueId: queuedInputs[index + 1]!.queueId,
              }),
          },
          {
            label: "Remove",
            disabled: false,
            run: () =>
              api.turns.drop({
                sessionId: entry.sessionId,
                queueId: entry.queueId,
                statusVersion: entry.statusVersion,
              }),
          },
        ];
        for (const control of controls) {
          const button = root.createElement("button");
          button.type = "button";
          button.className = "quiet-button";
          button.textContent =
            control.label === "Move up" ? "↑" : control.label === "Move down" ? "↓" : "×";
          button.title = control.label;
          button.setAttribute("aria-label", `${control.label}: ${entry.text}`);
          button.disabled = queuePending || control.disabled;
          button.addEventListener("click", async () => {
            const generation = selectionGeneration;
            queuePending = true;
            queueMessage = "";
            renderChat();
            const result = await control.run();
            queuePending = false;
            if (generation !== selectionGeneration || selected?.sessionId !== entry.sessionId) {
              renderChat();
              return;
            }
            if (result.ok) await refreshQueue(entry.sessionId);
            else {
              queueMessage = result.error.message;
              renderChat();
            }
          });
          actions.append(button);
        }
        item.append(text, actions);
        return item;
      }),
    );
  };

  const renderWaitTime = () => {
    elements.chatElapsed.textContent =
      chat.active && chat.startedAt !== null ? waitingTime(chat.startedAt, Date.now()) : "";
    const sinceUpdate = chat.lastUpdateAt === null ? 0 : Date.now() - chat.lastUpdateAt;
    elements.chatUpdate.textContent =
      chat.active && sinceUpdate >= 15_000
        ? `Last update ${waitingTime(chat.lastUpdateAt!, Date.now())} ago`
        : "";
    elements.chatUpdate.hidden = !elements.chatUpdate.textContent;
  };

  const renderChat = () => {
    const writable = Boolean(selected && selected.status !== "closed");
    const attachmentsValid = turnAttachmentsAreValid();
    elements.chatStatus.textContent =
      connecting && !selected
        ? ""
        : conversationLoading && !chat.active && !chat.label
          ? "Finishing…"
          : chat.label;
    elements.reconnectTurn.hidden = !chat.active || !chat.disconnected;
    elements.reconnectTurn.disabled = reconnectingTurns.has(chat.sessionId ?? "");
    elements.reconnectTurn.textContent = reconnectingTurns.has(chat.sessionId ?? "")
      ? "Checking response…"
      : chat.error?.retryable
        ? "Reconnect response"
        : "Check response status";
    elements.chatDetail.textContent = chat.detail;
    elements.chatDetail.hidden = !chat.detail;
    elements.chatProgress.hidden = !elements.chatStatus.textContent && !chat.detail;
    elements.timeline.setAttribute("aria-busy", String(conversationLoading));
    elements.chatStatus.className = `chat-status${(chat.active || conversationLoading) && !chat.error ? " working" : ""}${chat.error ? " error" : ""}`;
    renderWaitTime();
    if (chat.active && waitTimer === null) waitTimer = setInterval(renderWaitTime, 1000);
    if (!chat.active && waitTimer !== null) {
      clearInterval(waitTimer);
      waitTimer = null;
    }
    elements.newSession.disabled = connecting || creatingTask || chat.active;
    const isCommand =
      elements.composer.value.trimStart().startsWith("/") &&
      !elements.composer.value.trimStart().startsWith("//");
    elements.send.disabled =
      creatingTask ||
      savingSubmission ||
      (isCommand
        ? connecting && !isTaskCommand(elements.composer.value)
        : connecting ||
          !daemonReady ||
          selected?.status === "closed" ||
          conversationLoading ||
          (chat.active && (!selected?.activeAgentId || attachments.length > 0)) ||
          attachmentPending ||
          !elements.composer.value.trim() ||
          !attachmentsValid);
    const restoreFocusAfterStop = !chat.active && root.activeElement === elements.cancel;
    elements.cancel.hidden = !chat.active;
    elements.cancel.disabled = !chat.active || !chat.traceId || chat.stopRequested;
    elements.cancel.title = chat.stopRequested ? "Waiting for OpenMinion to stop" : "Stop response";
    elements.send.hidden =
      chat.active &&
      !isCommand &&
      (chat.stopRequested || attachments.length > 0 || !selected?.activeAgentId);
    elements.composerHint.textContent = connecting
      ? "Keep drafting while OpenMinion starts"
      : chat.active
        ? "Enter to queue next · Shift+Enter for new line"
        : "Enter to send · Shift+Enter for new line";
    if (restoreFocusAfterStop) elements.composer.focus();
    elements.send.title = isCommand
      ? "Run command"
      : !daemonReady
        ? "Connect OpenMinion to send this draft"
        : selected?.status === "closed"
          ? "Create or choose an open conversation to send"
          : conversationLoading
            ? "Waiting for conversation history"
            : chat.active
              ? "Queue message (Enter)"
              : "Send message (Enter)";
    elements.composer.disabled = false;
    elements.composer.placeholder = connecting
      ? "Write a message while OpenMinion starts…"
      : "Message OpenMinion…";
    elements.closeSession.disabled =
      !writable || conversationLoading || chat.active || attachmentPending;
    elements.attachImage.disabled =
      !richContextReady || !writable || chat.active || attachmentPending || attachments.length >= 4;
    elements.attachFile.disabled = elements.attachImage.disabled;
    elements.renameSession.disabled = !selected;
    elements.currentTitle.textContent = selected ? taskName(selected) : "New conversation";
    elements.currentTitle.disabled = !selected;
    elements.currentTitle.title = selected ? `Rename conversation: ${taskName(selected)}` : "";
    elements.currentTitle.setAttribute(
      "aria-label",
      selected ? `Rename conversation: ${taskName(selected)}` : "New conversation",
    );
    renderAttachments(root, elements.attachments, attachments, (mediaId) => {
      const attachment = attachments.find((item) => item.mediaId === mediaId);
      if (!attachment) {
        return;
      }
      attachments = attachments.filter((item) => item.mediaId !== mediaId);
      void api.media.release({
        sessionId: attachment.sessionId,
        mediaId: attachment.mediaId,
      });
      renderChat();
    });
    renderQueue();
    renderFiles();
    renderTimeline(
      root,
      elements.timeline,
      elements.conversation,
      elements.chatProgress,
      conversationLoading,
      [
        ...messages.slice(hiddenMessageCount),
        ...(submittedText === null ? [] : [{ role: "user" as const, body: submittedText }]),
        ...(responseText
          ? [
              {
                role: "assistant" as const,
                body: responseText,
                profileName: selected?.activeAgentId,
                usage: responseUsage,
              },
            ]
          : []),
      ],
      selected?.turnUsageDisplay ?? "total",
      (text) => api.app.copyText(text),
      automaticObservation,
      toolDisplay === "quiet" ? activity.filter((item) => item.kind === "approval") : activity,
      toolDisplay,
      deciding,
      approvalErrors,
      chat.stopRequested,
      approvalFocus,
      announcedApprovals,
      (approval, decision) => {
        if (deciding.has(approval.approvalId) || chat.stopRequested) {
          return;
        }
        deciding.add(approval.approvalId);
        approvalErrors.delete(approval.approvalId);
        approvalFocus.add(approval.approvalId);
        renderChat();
        void (async () => {
          let result: ClientResult<ApprovalDecisionV1>;
          try {
            result = await api.approvals.decide({
              sessionId: approval.sessionId,
              traceId: approval.traceId,
              approvalId: approval.approvalId,
              decision,
            });
          } catch {
            result = {
              ok: false,
              error: {
                code: "approval_transport_failed",
                message: "Could not send the decision. Try again.",
                retryable: true,
                retryAfterMs: null,
              },
            };
          } finally {
            deciding.delete(approval.approvalId);
          }
          const live = liveTurns.get(approval.sessionId);
          const currentActivity = live?.activity ?? activityBySession.get(approval.sessionId) ?? [];
          const currentApproval = currentActivity.find(
            (item): item is ApprovalEventV1 =>
              item.kind === "approval" && item.approvalId === approval.approvalId,
          );
          if (currentApproval?.outcome !== "pending") {
            approvalErrors.delete(approval.approvalId);
            renderSessionList();
            if (selected?.sessionId === approval.sessionId) {
              approvalFocus.add(approval.approvalId);
              renderChat();
            }
            return;
          }
          if (result.ok) {
            approvalErrors.delete(approval.approvalId);
            const resolved = resolvedApproval(approval, result.value);
            const sessionActivity = applyActivityEvent(
              live?.activity ?? activityBySession.get(approval.sessionId) ?? [approval],
              resolved,
            );
            activityBySession.set(approval.sessionId, sessionActivity);
            if (live) live.activity = sessionActivity;
          } else {
            approvalErrors.set(approval.approvalId, result.error);
          }
          approvalFocus.add(approval.approvalId);
          renderSessionList();
          if (selected?.sessionId !== approval.sessionId) {
            return;
          }
          if (!result.ok) {
            renderChat();
            return;
          }
          activity = applyActivityEvent(activity, resolvedApproval(approval, result.value));
          activityBySession.set(approval.sessionId, activity);
          renderSessionList();
          renderChat();
        })();
      },
    );
    renderObservation();
    renderCommandMenu();
    renderJumpToLatest();
  };

  const showError = (error: ErrorV1) => {
    chat = { ...chat, label: error.message, error };
    renderChat();
  };

  const sessionSpinners = new Map<string, HTMLElement>();
  const updateSessionActivity = () => {
    for (const [sessionId, spinner] of sessionSpinners) {
      const active = liveTurns.get(sessionId)?.state.active === true;
      spinner.hidden = !active;
      spinner.parentElement?.setAttribute(
        "aria-label",
        `${spinner.parentElement.title}${active ? " · Working" : ""}`,
      );
    }
  };
  const renderSessionList = () => {
    elements.sessionContextMenu.hidePopover();
    const query = elements.sessionSearch.value.trim().toLowerCase();
    const visible = query
      ? sessions.filter(
          (session) =>
            taskName(session).toLowerCase().includes(query) ||
            session.sessionId.toLowerCase().includes(query),
        )
      : sessions;
    elements.clearSessionSearch.hidden = elements.sessionSearch.value.length === 0;
    elements.sessionSearchCount.hidden = !query;
    elements.sessionSearchCount.textContent = query
      ? `${visible.length} of ${sessions.length} conversations`
      : "";
    sessionSpinners.clear();
    const needsApproval = new Set<string>();
    for (const session of visible) {
      const sessionActivity =
        session.sessionId === selected?.sessionId
          ? activity
          : (liveTurns.get(session.sessionId)?.activity ??
            activityBySession.get(session.sessionId) ??
            []);
      if (
        sessionActivity.some(
          (item) =>
            item.kind === "approval" &&
            item.outcome === "pending" &&
            approvalErrors.get(item.approvalId)?.retryable !== false,
        )
      ) {
        needsApproval.add(session.sessionId);
      }
    }
    renderSessions(
      root,
      elements.sessionList,
      visible,
      selected?.sessionId ?? null,
      taskName,
      sessionSpinners,
      needsApproval,
      (id) => {
        const next = sessions.find((item) => item.sessionId === id);
        if (next) void selectSession(next);
      },
      (session, button) => {
        if (contextAnchor) contextAnchor.style.anchorName = "";
        contextSession = session;
        contextAnchor = button;
        button.style.anchorName = "--session-context-trigger";
        elements.sessionContextMenu.showPopover();
        elements.sessionContextRename.focus();
      },
      sessions.length && query
        ? "No matching conversations. Try another name or session ID."
        : "Your conversations will appear here.",
    );

    updateSessionActivity();
  };

  const clearSessionSearch = () => {
    elements.sessionSearch.value = "";
    renderSessionList();
    elements.sessionSearch.focus();
  };
  elements.sessionSearch.addEventListener("input", renderSessionList);
  elements.clearSessionSearch.addEventListener("click", clearSessionSearch);
  elements.sessionSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSessionSearch();
    }
  });

  const selectSession = async (
    session: SessionSummaryV1,
    terminalTraceId: string | null = null,
    preserveGuidance = false,
    preserveStatus = false,
  ) => {
    const refreshing = selected?.sessionId === session.sessionId;
    const terminalState =
      refreshing &&
      (preserveStatus || (terminalTraceId !== null && chat.terminalTraceId === terminalTraceId))
        ? chat
        : null;
    if (!refreshing) hideCommandResult();
    const terminalGuidance =
      preserveGuidance &&
      terminalTraceId !== null &&
      (guidancePending?.traceId === terminalTraceId || guidanceView?.traceId === terminalTraceId);
    if (!terminalGuidance) clearGuidance();
    if (selected && selected.sessionId !== session.sessionId) {
      hideCommandMenu();
      drafts.set(selected.sessionId, elements.composer.value);
      elements.composer.value = drafts.get(session.sessionId) ?? "";
      captureGeneration += 1;
      observationGeneration += 1;
      observationPending = false;
      observationStatus = null;
      observationMessage = null;
      automaticObservation = null;
      elements.observationInstruction.value = "";
      elements.observationTrigger.value = "changes";
      elements.includeCurrentView.checked = false;
      capturePending = false;
      captureMessage = null;
      captureState = null;
      resetCaptureSelection();
      if (attachments.length) releaseAttachments(api, attachments);
      releaseFileGrants(api, fileGrants);
      attachments = [];
      fileGrants = [];
    }
    const generation = ++selectionGeneration;
    submissionGeneration += 1;
    if (!selected) elements.composer.value = drafts.get(session.sessionId) ?? "";
    selected = session;
    if (!refreshing) {
      queuedInputs = [];
      queueMessage = "";
    }
    if (!refreshing) customCommands = [];
    showDraftStatus();
    conversationLoading = true;
    if (!refreshing) {
      const live = liveTurns.get(session.sessionId);
      messages = live?.messages ?? [];
      submittedText = live?.submittedText ?? null;
      responseText = live?.responseText ?? "";
      latestCopyText = live?.latestCopyText ?? null;
      responseUsage = live?.responseUsage;
      hiddenMessageCount = 0;
      capturePending = Boolean(captureApi);
      artifacts = [];
      artifactView = null;
      artifactLabel = "Loading artifacts…";
      fileLabel = "Choose a local file to import.";
      activity = live?.activity ?? activityBySession.get(session.sessionId) ?? [];
      chat = live?.state ?? {
        ...initialChatState(),
        sessionId: session.sessionId,
        terminalTraceId,
        label: "Loading conversation…",
      };
    }
    renderSessionList();
    renderChat();
    renderArtifacts();
    renderFiles();
    renderCapture();
    const artifactsLoading = richContextReady
      ? loadArtifacts(session.sessionId, generation)
      : Promise.resolve();
    const recovered = await recoverSession(api, session.sessionId);
    if (generation !== selectionGeneration || selected?.sessionId !== session.sessionId) {
      return;
    }
    await Promise.all([
      artifactsLoading,
      refreshCaptureStatus(),
      refreshObservationStatus(),
      refreshQueue(session.sessionId, generation),
    ]);
    if (generation !== selectionGeneration || selected?.sessionId !== session.sessionId) {
      return;
    }
    capturePending = false;
    conversationLoading = false;
    renderCapture();
    if ("code" in recovered) {
      showError(recovered);
      return;
    }
    selected = recovered.session;
    const index = sessions.findIndex((item) => item.sessionId === recovered.session.sessionId);
    if (index === -1) sessions.push(recovered.session);
    else sessions[index] = recovered.session;
    messages = recovered.messages;
    submittedText = null;
    responseText = "";
    latestCopyText = null;
    responseUsage = undefined;
    hiddenMessageCount = 0;
    automaticObservation = null;
    activity = (activityBySession.get(recovered.session.sessionId) ?? []).reduce(
      (items, item) => applyActivityEvent(items, item),
      recoverActivity(recovered.session.sessionId, recovered.events),
    );
    activityBySession.set(recovered.session.sessionId, activity);
    const pendingApproval = terminalState
      ? undefined
      : activity.find(
          (item): item is ApprovalEventV1 => item.kind === "approval" && item.outcome === "pending",
        );
    chat = {
      ...initialChatState(),
      sessionId: recovered.session.sessionId,
      traceId: pendingApproval?.traceId ?? null,
      terminalTraceId,
      active: Boolean(pendingApproval),
      startedAt: pendingApproval?.requestedAt ? Date.parse(pendingApproval.requestedAt) : null,
      label: recovered.session.isDraft
        ? "Send a message to start this conversation."
        : pendingApproval
          ? "Needs approval."
          : terminalLabel(recovered.events),
      ...(terminalState ? { label: terminalState.label, error: terminalState.error } : {}),
    };
    const live = liveTurns.get(session.sessionId);
    if (live) {
      chat = live.state;
      // The CLI may not persist the accepted request until the turn finishes.
      messages = live.messages;
      submittedText = live.submittedText;
      responseText = live.responseText;
      latestCopyText = live.latestCopyText;
      responseUsage = live.responseUsage;
      for (const item of live.activity) activity = applyActivityEvent(activity, item);
      activityBySession.set(session.sessionId, activity);
    }
    renderSessionList();
    renderChat();
  };

  let sessionsGeneration = 0;
  const loadSessions = async () => {
    const generation = ++sessionsGeneration;
    const result = await listSessions(api);
    if (generation !== sessionsGeneration) return;
    if ("code" in result) {
      showError(result);
      return;
    }
    sessions = result;
    renderSessionList();
    if (!selected && sessions[0] && !elements.composer.value) {
      await selectSession(sessions[0]);
    } else if (!sessions.length) {
      renderChat();
    }
  };

  const renderRuntimeUpdate = (status: RuntimeUpdateStatus) => {
    const copy: Record<RuntimeUpdateStatus["phase"], string> = {
      unchecked: "Runtime updates have not been checked.",
      checking: "Checking for a compatible runtime…",
      current: "No compatible runtime update is available.",
      incompatible:
        "The installed runtime is incompatible with this Desktop version. Check for a compatible update before connecting.",
      available: `Runtime ${status.availableVersion} is available. Your current runtime stays in use.`,
      staging: "Preparing the update without interrupting your work…",
      pending: `Runtime ${status.availableVersion} is prepared for a later eligible startup. Pause and pin controls still apply; an external daemon must be stopped separately.`,
      check_failed: "Could not check for updates. Your installed runtime is unchanged.",
      recovery_required:
        "A runtime update was interrupted after launch began. Recovery needs review; Desktop will not downgrade your data automatically.",
      unmanaged: "Runtime is managed outside Desktop. Updates are not applied here.",
    };
    elements.installedRuntimeVersion.textContent = status.installedVersion ?? "Not detected";
    const installed = status.installedVersion
      ? `Installed: OpenMinion ${status.installedVersion} (${status.source}). `
      : "";
    const policy = `Update source: ${status.selectedSource === "binary" ? "native runtime" : "Python package"}. ${status.paused ? "Upgrades are paused, including prepared updates. " : ""}${status.pinnedVersion ? `Pinned to ${status.pinnedVersion}. ` : ""}`;
    elements.runtimeUpdateStatus.textContent = installed + policy + copy[status.phase];
    elements.checkRuntimeUpdate.disabled = [
      "checking",
      "staging",
      "pending",
      "recovery_required",
      "unmanaged",
    ].includes(status.phase);
    elements.stageRuntimeUpdate.hidden = status.phase !== "available";
    elements.stageRuntimeUpdate.disabled = status.phase !== "available" || status.paused;
    const busy = ["checking", "staging", "recovery_required", "unmanaged"].includes(status.phase);
    elements.runtimeUpdateSource.value = status.selectedSource;
    elements.runtimeUpdateSource.disabled = busy || status.phase === "pending";
    elements.pauseRuntimeUpdate.textContent = status.paused ? "Resume upgrades" : "Pause upgrades";
    elements.pauseRuntimeUpdate.dataset.action = status.paused ? "resume" : "pause";
    elements.pauseRuntimeUpdate.disabled = ["recovery_required", "unmanaged"].includes(
      status.phase,
    );
    elements.discardRuntimeUpdate.hidden = !["pending", "staging"].includes(status.phase);
    elements.discardRuntimeUpdate.disabled = ["recovery_required", "unmanaged"].includes(
      status.phase,
    );
    elements.pinInstalledRuntime.disabled = busy || !status.installedVersion;
    elements.pinRuntimeVersion.disabled = busy || !status.installedVersion;
    elements.unpinRuntime.hidden = !status.pinnedVersion;
    elements.unpinRuntime.disabled = busy;
  };
  elements.checkRuntimeUpdate.addEventListener("click", async () => {
    elements.checkRuntimeUpdate.disabled = true;
    elements.runtimeUpdateStatus.textContent = "Checking for a compatible runtime…";
    renderRuntimeUpdate(await api.runtime.check());
  });
  elements.stageRuntimeUpdate.addEventListener("click", async () => {
    elements.stageRuntimeUpdate.disabled = true;
    elements.runtimeUpdateStatus.textContent = "Preparing the update…";
    const result = await api.runtime.stage();
    renderRuntimeUpdate(result.ok ? result.value : await api.runtime.status());
    if (!result.ok) elements.runtimeUpdateStatus.textContent = result.error.message;
  });
  const controlRuntime = async (input: Parameters<NativeApi["runtime"]["control"]>[0]) => {
    const result = await api.runtime.control(input);
    renderRuntimeUpdate(result.ok ? result.value : await api.runtime.status());
    if (!result.ok) elements.runtimeUpdateStatus.textContent = result.error.message;
  };
  elements.runtimeUpdateSource.addEventListener("change", () => {
    const source = elements.runtimeUpdateSource.value;
    if (source === "pypi" || source === "binary") void controlRuntime({ action: "source", source });
  });
  elements.pauseRuntimeUpdate.addEventListener(
    "click",
    () =>
      void controlRuntime({
        action: elements.pauseRuntimeUpdate.dataset.action === "resume" ? "resume" : "pause",
      }),
  );
  elements.discardRuntimeUpdate.addEventListener(
    "click",
    () => void controlRuntime({ action: "discard" }),
  );
  elements.pinInstalledRuntime.addEventListener(
    "click",
    () => void controlRuntime({ action: "pin-installed" }),
  );
  elements.unpinRuntime.addEventListener("click", () => void controlRuntime({ action: "unpin" }));
  elements.pinRuntimeVersion.addEventListener(
    "click",
    () =>
      void controlRuntime({
        action: "pin",
        version: elements.runtimePinVersion.value.trim(),
      }),
  );
  let runtimeStatusTimer: ReturnType<typeof setInterval> | null = null;
  let runtimeStatusLoading = false;
  const refreshRuntimeStatus = async () => {
    if (runtimeStatusLoading) return;
    runtimeStatusLoading = true;
    try {
      renderRuntimeUpdate(await api.runtime.status());
    } finally {
      runtimeStatusLoading = false;
    }
  };
  elements.connectionDetails.addEventListener("toggle", () => {
    if (runtimeStatusTimer !== null) clearInterval(runtimeStatusTimer);
    runtimeStatusTimer = null;
    if (elements.connectionDetails.open) {
      void refreshRuntimeStatus();
      // Project automatic check completion only while connection details are visible.
      runtimeStatusTimer = setInterval(() => void refreshRuntimeStatus(), 2_000);
    }
  });

  const renderReadiness = (summary?: string) => {
    elements.recovery.hidden = daemonReady;
    elements.readinessTitle.textContent = connecting
      ? "Getting OpenMinion ready…"
      : "Chat isn’t connected yet";
    elements.readinessTitle.className = connecting ? "readiness-pending" : "";
    elements.readinessSummary.textContent = connecting
      ? "Starting your local runtime and connecting chat. First launch can take a little longer."
      : `${summary} Your draft stays here while you reconnect.`;
    elements.readinessActions.hidden = connecting;
  };

  const renderStatus = (status: DaemonStatus) => {
    const view = statusView(status);
    daemonReady = status.state === "ready" || status.capabilities.includes("turns.text");
    connecting = !daemonReady && !view.showRecovery;
    richContextReady = status.state === "ready" && status.protocol !== null;
    if (!selected) {
      chat = {
        ...chat,
        label: daemonReady ? "Send a message to start a new conversation." : "",
      };
    }
    elements.statusDot.className = `status-dot ${view.tone}`;
    elements.statusSummary.textContent = view.summary;
    elements.retry.hidden = !view.showRetry;
    renderReadiness(view.summary);
    elements.daemonVersion.textContent = status.daemonVersion ?? "Not reported";
    elements.protocolVersion.textContent = status.protocol?.toString() ?? "Not reported";
    elements.connectionLabel.textContent = view.label;
    renderChat();
  };

  const profiles = mountProfiles(api, root, (status) => {
    renderStatus(status);
    if (daemonReady) void loadSessions();
  });

  const refresh = async (): Promise<void> => {
    let status = await api.daemon.status();
    renderStatus(status);
    if (!["running", "ready", "degraded"].includes(status.state)) {
      status = await api.daemon.retry();
      renderStatus(status);
    }
    if (api.sessions) await loadSessions();
    await profiles?.checkSetup();
    renderRuntimeUpdate(await api.runtime.status());
  };

  const acceptGuidanceTurnEvent = (event: TurnEventV1) => {
    const pending = guidancePending;
    if (!pending || event.sessionId !== pending.sessionId) return;
    if (event.kind === "started") {
      if (
        (pending.requestId !== null && pending.requestId !== event.requestId) ||
        (pending.traceId !== null && pending.traceId !== event.traceId)
      ) {
        clearGuidance();
        return;
      }
      pending.requestId = event.requestId;
      pending.traceId = event.traceId;
      pending.started = true;
      if (observationStatus) acceptGuidanceObservation(observationStatus);
      return;
    }
    if (event.traceId !== pending.traceId) return;
    if (event.kind === "response") {
      pending.responseText =
        event.errors.length === 0 && event.finalText.trim() ? event.finalText : null;
      return;
    }
    if (event.kind === "done") {
      if (event.outcome !== "complete" || !pending.responseText) {
        clearGuidance();
        return;
      }
      pending.completed = true;
      settleGuidance();
    }
  };

  const unsubscribe = api.turns.subscribe((event) => {
    const matchesSelectedTurn =
      selected?.sessionId === event.sessionId && chat.traceId === event.traceId;
    if (event.kind === "started" && event.draftError) {
      draftErrors.set(event.sessionId, event.draftError);
      showDraftStatus();
    }
    let live = liveTurns.get(event.sessionId);
    if (
      event.kind === "started" &&
      pendingRunNext?.sessionId === event.sessionId &&
      live?.state.traceId !== event.traceId
    ) {
      live = {
        state: initialChatState(),
        messages: selected?.sessionId === event.sessionId ? messages : [],
        submittedText: pendingRunNext.text,
        responseText: "",
        latestCopyText: null,
        responseUsage: undefined,
        activity: [],
      };
      liveTurns.set(event.sessionId, live);
      pendingRunNext = null;
    }
    if (live) {
      const matchesTurn = live.state.traceId === event.traceId;
      if (matchesTurn && (event.kind === "tool" || event.kind === "approval"))
        live.activity = applyActivityEvent(live.activity, event);
      if (matchesTurn && event.kind === "progress" && event.progressKind === "text") {
        live.responseText += event.text;
        live.latestCopyText = assistantBody(
          live.responseText,
          sessions.find((session) => session.sessionId === event.sessionId)?.activeAgentId,
        );
      }
      if (matchesTurn && event.kind === "tool" && event.phase === "completed" && event.content)
        live.latestCopyText = event.content;
      if (matchesTurn && event.kind === "response") {
        live.responseText = event.finalText;
        if (event.finalText)
          live.latestCopyText = assistantBody(
            event.finalText,
            sessions.find((session) => session.sessionId === event.sessionId)?.activeAgentId,
          );
        live.responseUsage = event.usage;
      }
      live.state = applyTurnEvent(live.state, event);
      if (selected?.sessionId === event.sessionId) {
        responseText = live.responseText;
        latestCopyText = live.latestCopyText;
        responseUsage = live.responseUsage;
      }
      if (
        matchesTurn &&
        (event.kind === "done" || (event.kind === "connection" && event.state === "unavailable"))
      )
        liveTurns.delete(event.sessionId);
      updateSessionActivity();
    }
    acceptGuidanceTurnEvent(event);
    if (event.kind === "tool" || event.kind === "approval") {
      const sessionActivity = applyActivityEvent(
        selected?.sessionId === event.sessionId
          ? activity
          : (activityBySession.get(event.sessionId) ?? []),
        event,
      );
      activityBySession.set(event.sessionId, sessionActivity);
      if (selected?.sessionId === event.sessionId) activity = sessionActivity;
    }
    if (event.kind === "approval") {
      if (event.outcome !== "pending") {
        approvalErrors.delete(event.approvalId);
        announcedApprovals.delete(event.approvalId);
        const focusedApprovalId = (root.activeElement as HTMLElement | null)?.dataset.approvalId;
        if (
          selected?.sessionId === event.sessionId &&
          (deciding.has(event.approvalId) || focusedApprovalId === event.approvalId)
        ) {
          approvalFocus.add(event.approvalId);
        }
      } else if (selected?.sessionId !== event.sessionId) {
        const session = sessions.find((item) => item.sessionId === event.sessionId);
        elements.approvalNotice.textContent = `${session ? taskName(session) : "Another conversation"} needs approval for ${event.toolName}.`;
      }
      renderSessionList();
    }
    chat = applyTurnEvent(chat, event);
    renderChat();
    if (event.kind === "done" && live?.state.terminalTraceId === event.traceId) void loadSessions();
    if (event.kind === "done" && matchesSelectedTurn && selected) {
      void selectSession(selected, event.traceId, true);
    }
    if (
      event.kind === "connection" &&
      event.state === "unavailable" &&
      matchesSelectedTurn &&
      selected
    ) {
      void selectSession(selected, null, false, true);
    }
  });
  elements.reconnectTurn.addEventListener("click", async () => {
    if (
      !chat.active ||
      !chat.disconnected ||
      !chat.sessionId ||
      !chat.traceId ||
      reconnectingTurns.has(chat.sessionId)
    )
      return;
    const sessionId = chat.sessionId;
    const traceId = chat.traceId;
    reconnectingTurns.add(sessionId);
    renderChat();
    const result = await api.turns.reconnect({ sessionId, traceId });
    reconnectingTurns.delete(sessionId);
    if (!result.ok) {
      const live = liveTurns.get(sessionId);
      if (live?.state.traceId === traceId) {
        live.state = { ...live.state, label: result.error.message, error: result.error };
        if (selected?.sessionId === sessionId) chat = live.state;
      }
    }
    renderChat();
  });
  const unsubscribeCapture =
    captureApi?.subscribe((event: CaptureEventV1) => {
      if (event.kind === "state") {
        applyCaptureState(event.value);
        return;
      }
      if (
        captureState?.state === "observing" &&
        event.sessionId === selected?.sessionId &&
        event.captureId === captureState.captureId
      ) {
        captureFrame = event;
        renderCapture();
      }
    }) ?? (() => {});
  const unsubscribeObservation =
    observationApi?.subscribe((value) => {
      if (value.sessionId !== null && value.sessionId !== selected?.sessionId) return;
      observationStatus = value;
      observationMessage = null;
      acceptGuidanceObservation(value);
      if (value.currentReason !== "user_send" && value.sentFrame?.traceId) {
        automaticObservation = value.sentFrame;
      }
      renderChat();
    }) ?? (() => {});
  window.addEventListener(
    "pagehide",
    () => {
      selectionGeneration += 1;
      submissionGeneration += 1;
      captureGeneration += 1;
      observationGeneration += 1;
      clearGuidance();
      if (waitTimer !== null) clearInterval(waitTimer);
      if (runtimeStatusTimer !== null) clearInterval(runtimeStatusTimer);
      capturePending = false;
      captureMessage = null;
      unsubscribe();
      unsubscribeCapture();
      unsubscribeObservation();
      if (observationApi) void observationApi.stop();
      if (captureApi) void captureApi.stop();
      releaseAttachments(api, attachments);
      releaseFileGrants(api, fileGrants);
      attachments = [];
      fileGrants = [];
    },
    { once: true },
  );

  elements.showConnection.addEventListener("click", async () => {
    elements.connectionDetails.open = true;
    elements.retry.focus();
    renderStatus(await api.daemon.status());
  });
  elements.retry.addEventListener("click", async () => {
    elements.retry.disabled = true;
    connecting = true;
    daemonReady = false;
    renderReadiness();
    renderChat();
    const status = await api.daemon.retry();
    renderStatus(status);
    if (daemonReady) {
      await loadSessions();
    }
    elements.retry.disabled = false;
  });
  elements.readinessRetry.addEventListener("click", () => elements.retry.click());
  elements.readinessSettings.addEventListener("click", () =>
    required(root, "show-settings").click(),
  );
  const createTask = async () => {
    if (creatingTask || chat.active) return false;
    if (!daemonReady) {
      elements.composer.focus();
      return false;
    }
    creatingTask = true;
    renderChat();
    const result = await api.sessions.create({ title: "New conversation" });
    if (!result.ok) {
      creatingTask = false;
      showError(result.error);
      return false;
    }
    const unboundDraft = selected ? null : elements.composer.value;
    if (unboundDraft !== null) drafts.set(result.value.sessionId, unboundDraft);
    sessionsGeneration += 1;
    sessions = [result.value, ...sessions];
    const loading = selectSession(result.value);
    let transferred = true;
    if (unboundDraft !== null) {
      pendingDraftTransfer = result.value.sessionId;
      const saved = await saveDraft(result.value.sessionId, unboundDraft);
      transferred = saved.ok;
    }
    await loading;
    creatingTask = false;
    renderChat();
    elements.composer.focus();
    return transferred;
  };
  const openRename = (session: SessionSummaryV1, fromSidebar = false) => {
    renameGeneration += 1;
    renameFromSidebar = fromSidebar;
    renamingSession = session;
    elements.taskName.value = taskName(session);
    elements.renameSessionId.textContent = session.sessionId;
    elements.renameError.textContent = savedNames.ok ? "" : savedNames.error.message;
    elements.renameDialog.showModal();
    elements.taskName.focus();
    elements.taskName.select();
  };
  elements.renameSession.addEventListener("click", () => {
    if (selected) openRename(selected);
  });
  elements.currentTitle.addEventListener("click", () => {
    if (selected) openRename(selected);
  });
  elements.sessionContextRename.addEventListener("click", () => {
    elements.sessionContextMenu.hidePopover();
    if (contextSession) openRename(contextSession, true);
  });
  root.addEventListener("pointerdown", (event) => {
    if (!elements.sessionContextMenu.contains(event.target as Node))
      elements.sessionContextMenu.hidePopover();
  });
  elements.sessionContextMenu.addEventListener("focusout", (event) => {
    if (!elements.sessionContextMenu.contains(event.relatedTarget as Node | null))
      elements.sessionContextMenu.hidePopover();
  });
  elements.sessionContextMenu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    elements.sessionContextMenu.hidePopover();
    contextAnchor?.focus();
  });
  elements.renameCancel.addEventListener("click", () => elements.renameDialog.close());
  elements.renameDialog.addEventListener("close", () => {
    if (elements.renameDialog.open) return;
    renameGeneration += 1;
    const sessionId = renamingSession?.sessionId;
    renamingSession = null;
    const sidebarRow = sessionId ? sessionSpinners.get(sessionId)?.parentElement : null;
    (renameFromSidebar ? (sidebarRow ?? elements.sessionSearch) : elements.currentTitle).focus();
  });
  const saveTaskName = async (name: string | null) => {
    if (!renamingSession || savingName || !savedNames.ok) return;
    const session = renamingSession;
    const generation = renameGeneration;
    savingName = true;
    elements.renameError.textContent = "Saving…";
    const result = await api.chatNames.save({
      sessionId: session.sessionId,
      title: name,
    });
    savingName = false;
    if (result.ok) {
      if (name === null) names.delete(session.sessionId);
      else names.set(session.sessionId, name);
      renderSessionList();
      renderChat();
    }
    if (generation !== renameGeneration) return;
    if (!result.ok) {
      elements.renameError.textContent = result.error.message;
      return;
    }
    elements.renameDialog.close();
  };
  elements.renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = elements.taskName.value.trim();
    if (!name || name.length > 120) {
      elements.renameError.textContent = "Enter a name between 1 and 120 characters.";
      return;
    }
    void saveTaskName(name);
  });
  elements.renameReset.addEventListener("click", () => void saveTaskName(null));
  elements.newSession.addEventListener("click", () => void createTask());
  elements.closeSession.addEventListener("click", async () => {
    if (!selected || conversationLoading || chat.active) {
      return;
    }
    const generation = selectionGeneration;
    const sessionId = selected.sessionId;
    const result = await api.sessions.close({ sessionId });
    if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
      return;
    }
    if (!result.ok) {
      showError(result.error);
      return;
    }
    sessionsGeneration += 1;
    selectionGeneration += 1;
    captureGeneration += 1;
    observationGeneration += 1;
    capturePending = false;
    captureMessage = null;
    observationStatus = null;
    observationMessage = null;
    automaticObservation = null;
    clearGuidance();
    elements.observationInstruction.value = "";
    elements.observationTrigger.value = "changes";
    elements.includeCurrentView.checked = false;
    captureState = null;
    resetCaptureSelection();
    releaseAttachments(api, attachments);
    releaseFileGrants(api, fileGrants);
    attachments = [];
    fileGrants = [];
    sessions = sessions.map((item) =>
      item.sessionId === result.value.sessionId ? result.value : item,
    );
    selected = result.value;
    drafts.delete(result.value.sessionId);
    elements.composer.value = "";
    artifacts = [];
    artifactView = null;
    artifactLabel = "This session is closed.";
    fileLabel = "This session is closed.";
    renderSessionList();
    chat = {
      ...chat,
      label: "Conversation closed. Start a new conversation to continue.",
    };
    renderChat();
    renderArtifacts();
    renderFiles();
    renderCapture();
  });
  const submitTurn = async (asGuidance: boolean, renderedCommand = false) => {
    if (connecting && (asGuidance || !isTaskCommand(elements.composer.value))) return;
    if (!asGuidance && !renderedCommand && (await runCommand(elements.composer.value))) return;
    if (
      !daemonReady ||
      creatingTask ||
      savingSubmission ||
      conversationLoading ||
      selected?.status === "closed"
    ) {
      return;
    }
    const draft = elements.composer.value;
    const message = renderedCommand ? draft : draft.trim().replace(/^\/\//, "/");
    if (!message) {
      return;
    }
    if (!selected && (asGuidance || !(await createTask()))) return;
    if (!selected) return;
    const sessionId = selected.sessionId;
    if (chat.active) {
      if (asGuidance || attachments.length || !selected.activeAgentId) return;
      const generation = selectionGeneration;
      savingSubmission = true;
      renderChat();
      const saved = await saveDraft(sessionId, elements.composer.value);
      if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
        savingSubmission = false;
        renderChat();
        return;
      }
      if (!saved.ok) {
        savingSubmission = false;
        renderChat();
        return;
      }
      const result = await api.turns.enqueue({
        sessionId,
        agentId: selected.activeAgentId,
        text: message,
      });
      savingSubmission = false;
      if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
        if (result.ok) await saveDraft(sessionId, "");
        renderChat();
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      queuedInputs.push(result.value);
      if (elements.composer.value === draft) elements.composer.value = "";
      await saveDraft(sessionId, elements.composer.value);
      queueMessage = "";
      renderChat();
      return;
    }
    const pending = asGuidance
      ? guidanceSnapshot(selected.sessionId, captureState, captureFrame)
      : null;
    if (
      asGuidance &&
      (!pending || attachmentPending || attachments.length > 3 || !turnAttachmentsAreValid())
    ) {
      guidanceMessage = "A current frame and compatible attachments are required.";
      renderGuidance();
      return;
    }
    savingSubmission = true;
    renderChat();
    const consumesDraft = elements.composer.value === draft;
    const saved = await saveDraft(sessionId, elements.composer.value);
    savingSubmission = false;
    renderChat();
    if (!saved.ok || selected?.sessionId !== sessionId || chat.active) return;
    if (pending) {
      clearGuidanceTimer();
      guidancePending = pending;
      guidanceView = null;
      guidanceMessage = "Submitting guidance request…";
    }
    chat = {
      ...chat,
      active: true,
      startedAt: Date.now(),
      stopRequested: false,
      label: "Sending…",
      error: null,
      detail: "",
      lastUpdateAt: Date.now(),
    };
    submittedText = message;
    responseText = "";
    latestCopyText = null;
    responseUsage = undefined;
    if (elements.composer.value === draft) elements.composer.value = "";
    drafts.set(sessionId, elements.composer.value);
    elements.composer.focus();
    liveTurns.set(sessionId, {
      state: chat,
      messages,
      submittedText: message,
      responseText: "",
      latestCopyText: null,
      responseUsage: undefined,
      activity: [],
    });
    updateSessionActivity();
    releaseFileGrants(api, fileGrants);
    fileGrants = [];
    fileLabel = "File grants released for this turn.";
    renderChat();
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
    const generation = ++submissionGeneration;
    const includeCurrentView = asGuidance || elements.includeCurrentView.checked;
    const result = await api.turns.submit({
      sessionId: selected.sessionId,
      message,
      ...(consumesDraft ? { draftRevision: saved.value } : {}),
      ...(attachments.length
        ? { attachmentIds: attachments.map((attachment) => attachment.mediaId) }
        : {}),
      ...(includeCurrentView ? { observation: { includeCurrentView: true as const } } : {}),
    });
    const live = liveTurns.get(sessionId);
    if (live && result.ok) live.state = applySubmitResult(live.state, result.value);
    if (!result.ok) {
      liveTurns.delete(sessionId);
      updateSessionActivity();
      if (selected?.sessionId === sessionId) {
        if (!elements.composer.value) elements.composer.value = draft;
      } else if (!drafts.get(sessionId)) drafts.set(sessionId, draft);
    }
    if (generation !== submissionGeneration) {
      if (selected?.sessionId === sessionId) {
        void selectSession(selected);
      }
      return;
    }
    if (!result.ok) {
      chat = { ...chat, active: false };
      submittedText = null;
      if (asGuidance) clearGuidance();
      if (result.error.code === "submission_ambiguous") {
        attachments = [];
        elements.includeCurrentView.checked = false;
      }
      showError(result.error);
      return;
    }
    if (asGuidance && guidancePending) {
      if (
        guidancePending.sessionId !== result.value.sessionId ||
        (guidancePending.requestId !== null &&
          guidancePending.requestId !== result.value.requestId) ||
        (guidancePending.traceId !== null && guidancePending.traceId !== result.value.traceId)
      )
        clearGuidance();
      else {
        guidancePending.requestId = result.value.requestId;
        guidancePending.traceId = result.value.traceId;
        guidancePending.resultReceived = true;
        if (observationStatus) acceptGuidanceObservation(observationStatus);
      }
    }
    elements.includeCurrentView.checked = false;
    attachments = [];
    chat = applySubmitResult(chat, result.value);
    renderChat();
  };
  elements.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitTurn(false);
  });
  elements.askGuidance.addEventListener("click", () => void submitTurn(true));
  elements.runNext.addEventListener("click", async () => {
    const next = queuedInputs[0];
    if (!next || !selected?.activeAgentId || !chat.traceId || queuePending) return;
    const generation = selectionGeneration;
    queuePending = true;
    queueMessage = "Stopping the current response and starting the next prompt…";
    pendingRunNext = { sessionId: next.sessionId, text: next.text };
    renderChat();
    const result = await api.turns.cancelAndRunNext({
      sessionId: selected.sessionId,
      traceId: chat.traceId,
      agentId: selected.activeAgentId,
      expectedQueueId: next.queueId,
    });
    queuePending = false;
    if (generation !== selectionGeneration || selected?.sessionId !== next.sessionId) {
      if (!result.ok) pendingRunNext = null;
      renderChat();
      return;
    }
    if (result.ok) await refreshQueue(next.sessionId, generation);
    else {
      pendingRunNext = null;
      queueMessage = result.error.message;
      renderChat();
    }
  });
  elements.composer.addEventListener("input", () => {
    const draft = elements.composer.value.trimStart();
    if (draft === "/") void loadCustomCommands();
    if (!draft.startsWith("/") || draft.startsWith("//")) commandDraft = null;
    commandIndex = 0;
    commandsDismissed = false;
    void saveDraft(selected?.sessionId ?? "", elements.composer.value);
    renderChat();
  });
  const openCommands = () => {
    if (!elements.composer.value.startsWith("/")) commandDraft = elements.composer.value;
    elements.composer.value = "/";
    void loadCustomCommands();
    commandsDismissed = false;
    commandIndex = 0;
    elements.composer.focus();
    renderChat();
  };
  elements.showCommands.addEventListener("click", openCommands);
  root.addEventListener("keydown", (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "k" &&
      !root.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      openCommands();
    }
  });
  elements.composer.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const matches = commandMatches(elements.composer.value, customCommands);
    if (event.key === "Escape" && elements.commandMenu.hidden && !elements.commandPanel.hidden) {
      event.preventDefault();
      hideCommandResult();
      return;
    }
    if (!elements.commandMenu.hidden) {
      if (event.key === "Tab" && event.shiftKey) {
        commandDraft = null;
        hideCommandMenu();
        renderChat();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideCommandMenu();
        renderChat();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        commandIndex =
          (commandIndex + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        renderCommandMenu();
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const command = matches[commandIndex];
        if (command && event.key === "Tab") {
          const value = elements.composer.value.trim();
          elements.composer.value = /\s/.test(value)
            ? value.replace(/^\S+/, command.name)
            : `${command.name} `;
          commandsDismissed = true;
          void saveDraft(selected?.sessionId ?? "", elements.composer.value);
          renderChat();
        } else if (command)
          void runCommand(elements.composer.value.trim().replace(/^\S+/, command.name));
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      elements.composer.value.startsWith("/") &&
      !elements.composer.value.startsWith("//")
    ) {
      event.preventDefault();
      void runCommand(elements.composer.value);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!elements.send.disabled) void submitTurn(false);
    }
  });
  const pickMedia = async (kind: "image" | "file") => {
    if (!selected || chat.active || attachmentPending || attachments.length >= 4) {
      return;
    }
    const sessionId = selected.sessionId;
    const generation = selectionGeneration;
    attachmentPending = true;
    renderChat();
    const result = await api.media.pick({ sessionId, kind });
    attachmentPending = false;
    if (generation !== selectionGeneration || selected?.sessionId !== sessionId) {
      if (result.ok) {
        releaseAttachments(api, result.value.attachments);
      }
      renderChat();
      return;
    }
    if (!result.ok) {
      showError(result.error);
      return;
    }
    if (attachments.length + result.value.attachments.length > 4) {
      releaseAttachments(api, result.value.attachments);
      showError({
        code: "invalid_request",
        message: "Select no more than four attachments.",
        retryable: false,
        retryAfterMs: null,
      });
      return;
    }
    attachments = [...attachments, ...result.value.attachments];
    renderChat();
  };
  elements.attachImage.addEventListener("click", () => void pickMedia("image"));
  elements.attachFile.addEventListener("click", () => void pickMedia("file"));
  elements.chooseFile.addEventListener("click", () => void pickFileGrant());
  elements.captureEntireScreen.addEventListener("click", () => {
    elements.captureSourceKind.value = "display";
    renderCapture();
  });
  elements.captureWindow.addEventListener("click", () => {
    elements.captureSourceKind.value = "window";
    renderCapture();
  });
  elements.observeComputer.addEventListener("click", () => void observeComputer());
  elements.startCapture.addEventListener("click", () => {
    if (!captureApi || !selectedCandidate || !selected) return;
    const sessionId = selected.sessionId;
    const candidateId = selectedCandidate.candidateId;
    const region = elements.captureRegionEnabled.checked ? regionInput() : null;
    if (elements.captureRegionEnabled.checked && !region) return;
    void runCaptureAction(() =>
      captureApi.start({
        sessionId,
        candidateId,
        region,
      }),
    );
  });
  elements.pauseCapture.addEventListener("click", () => {
    if (captureApi) void runCaptureAction(() => captureApi.pause());
  });
  elements.resumeCapture.addEventListener("click", () => {
    if (captureApi) void runCaptureAction(() => captureApi.resume());
  });
  elements.stopCapture.addEventListener("click", () => {
    if (captureApi) void runCaptureAction(() => captureApi.stop());
  });
  elements.changeCapture.addEventListener("click", async () => {
    if (!captureApi || capturePending) return;
    if (await runCaptureAction(() => captureApi.stop())) await observeComputer();
  });
  elements.startObservation.addEventListener("click", async () => {
    if (!observationApi || !selected || observationPending) return;
    const generation = observationGeneration;
    const sessionId = selected.sessionId;
    observationPending = true;
    renderObservation();
    const result = await observationApi.configure({
      sessionId,
      instruction: elements.observationInstruction.value,
      trigger: elements.observationTrigger.value as "changes" | "interval",
    });
    if (generation !== observationGeneration || selected?.sessionId !== sessionId) return;
    observationPending = false;
    if (result.ok) {
      observationStatus = result.value;
      observationMessage = null;
    } else observationMessage = result.error.message;
    renderObservation();
  });
  elements.stopObservation.addEventListener("click", async () => {
    if (!observationApi || observationPending) return;
    const generation = observationGeneration;
    const sessionId = selected?.sessionId ?? null;
    observationPending = true;
    renderObservation();
    const result = await observationApi.stop();
    if (generation !== observationGeneration || selected?.sessionId !== sessionId) return;
    observationPending = false;
    if (result.ok) {
      observationStatus = result.value;
      observationMessage = null;
    } else observationMessage = result.error.message;
    renderObservation();
  });
  elements.observationInstruction.addEventListener("input", renderObservation);
  elements.observationTrigger.addEventListener("change", renderObservation);
  elements.includeCurrentView.addEventListener("change", renderChat);
  elements.captureRegionEnabled.addEventListener("change", renderCapture);
  for (const input of [
    elements.captureRegionX,
    elements.captureRegionY,
    elements.captureRegionWidth,
    elements.captureRegionHeight,
  ])
    input.addEventListener("input", renderCapture);
  let dragStart: { x: number; y: number } | null = null;
  elements.captureRegionStage.addEventListener("pointerdown", (event) => {
    const point = percentagePoint(elements.captureRegionStage, event);
    if (point) dragStart = point;
  });
  elements.captureRegionStage.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const end = percentagePoint(elements.captureRegionStage, event);
    if (!end) return;
    setRegionInputs(elements, dragStart, end);
    dragStart = null;
    renderCapture();
  });
  elements.refreshArtifacts.addEventListener("click", () => {
    if (selected && selected.status !== "closed") {
      void loadArtifacts(selected.sessionId);
    }
  });
  elements.closeArtifact.addEventListener("click", () => {
    artifactView = null;
    renderArtifacts();
  });
  elements.cancel.addEventListener("click", async () => {
    if (!selected || !chat.traceId || chat.stopRequested) {
      return;
    }
    const sessionId = selected.sessionId;
    const traceId = chat.traceId;
    chat = {
      ...chat,
      stopRequested: true,
      label: "Requesting stop…",
      error: null,
    };
    const live = liveTurns.get(sessionId);
    if (live) live.state = chat;
    renderChat();
    const result = await api.turns.cancel({ sessionId, traceId });
    const current = liveTurns.get(sessionId);
    if (!current?.state.active || current.state.traceId !== traceId) return;
    current.state = result.ok
      ? {
          ...current.state,
          active: !result.value.terminal,
          stopRequested: !result.value.terminal,
          label: !result.value.terminal
            ? "Stop requested…"
            : result.value.state === "completed"
              ? ""
              : result.value.state === "cancelled"
                ? "Stopped."
                : "Something went wrong. Check the reply before trying again.",
        }
      : {
          ...current.state,
          stopRequested: false,
          label: result.error.message,
          error: result.error,
        };
    if (result.ok && result.value.terminal) liveTurns.delete(sessionId);
    updateSessionActivity();
    if (selected?.sessionId === sessionId && chat.traceId === traceId) {
      chat = current.state;
      renderChat();
    }
  });

  renderChat();
  renderArtifacts();
  renderFiles();
  renderCapture();
  await refresh();
}

function cursorError(kind: "session" | "message" | "event" | "artifact"): ErrorV1 {
  return {
    code: "cursor_stalled",
    message: `The daemon ${kind} cursor did not advance.`,
    retryable: false,
    retryAfterMs: null,
  };
}

function invalidArtifactResponse(): ErrorV1 {
  return {
    code: "invalid_daemon_response",
    message: "The daemon artifact pages did not match.",
    retryable: false,
    retryAfterMs: null,
  };
}

function rendererElements(root: Document) {
  return {
    statusDot: required(root, "status-dot"),
    statusSummary: required(root, "status-summary"),
    retry: required(root, "retry") as HTMLButtonElement,
    showConnection: required(root, "show-connection"),
    diagnosticsDialog: required(root, "diagnostics-dialog") as HTMLDialogElement,
    diagnosticsTitle: required(root, "diagnostics-title"),
    diagnosticsResult: required(root, "diagnostics-result"),
    closeDiagnostics: required(root, "close-diagnostics"),
    settingsRuntimeButton: required(root, "settings-runtime-button") as HTMLButtonElement,
    showDaemonStatus: required(root, "show-daemon-status") as HTMLButtonElement,
    showDaemonLogs: required(root, "show-daemon-logs") as HTMLButtonElement,
    runtimeUpdateStatus: required(root, "runtime-update-status"),
    runtimeUpdateSource: required(root, "runtime-update-source") as HTMLSelectElement,
    checkRuntimeUpdate: required(root, "check-runtime-update") as HTMLButtonElement,
    stageRuntimeUpdate: required(root, "stage-runtime-update") as HTMLButtonElement,
    pauseRuntimeUpdate: required(root, "pause-runtime-update") as HTMLButtonElement,
    discardRuntimeUpdate: required(root, "discard-runtime-update") as HTMLButtonElement,
    pinInstalledRuntime: required(root, "pin-installed-runtime") as HTMLButtonElement,
    unpinRuntime: required(root, "unpin-runtime") as HTMLButtonElement,
    runtimePinVersion: required(root, "runtime-pin-version") as HTMLInputElement,
    pinRuntimeVersion: required(root, "pin-runtime-version") as HTMLButtonElement,
    connectionDetails: required(root, "connection-details") as HTMLDetailsElement,
    recovery: required(root, "recovery"),
    readinessTitle: required(root, "readiness-title"),
    readinessSummary: required(root, "readiness-summary"),
    readinessActions: required(root, "readiness-actions"),
    readinessRetry: required(root, "readiness-retry"),
    readinessSettings: required(root, "readiness-settings"),
    installedRuntimeVersion: required(root, "installed-runtime-version"),
    daemonVersion: required(root, "daemon-version"),
    protocolVersion: required(root, "protocol-version"),
    shellVersion: required(root, "shell-version"),
    connectionLabel: required(root, "connection-label"),
    screenContextSummary: required(root, "screen-context-summary"),
    screenContextName: required(root, "screen-context-name"),
    screenContextStatus: required(root, "screen-context-status"),
    screenContextPreview: required(root, "screen-context-preview") as HTMLImageElement,
    sessionList: required(root, "session-list"),
    approvalNotice: required(root, "approval-notice"),
    sessionSearch: required(root, "session-search") as HTMLInputElement,
    clearSessionSearch: required(root, "clear-session-search"),
    sessionSearchCount: required(root, "session-search-count"),
    newSession: required(root, "new-session") as HTMLButtonElement,
    closeSession: required(root, "close-session") as HTMLButtonElement,
    currentTitle: required(root, "current-title") as HTMLButtonElement,
    sessionContextMenu: required(root, "session-context-menu"),
    sessionContextRename: required(root, "session-context-rename") as HTMLButtonElement,
    renameSession: required(root, "rename-session") as HTMLButtonElement,
    renameDialog: required(root, "rename-dialog") as HTMLDialogElement,
    renameForm: required(root, "rename-form") as HTMLFormElement,
    taskName: required(root, "task-name") as HTMLInputElement,
    renameSessionId: required(root, "rename-session-id"),
    renameError: required(root, "rename-error"),
    renameCancel: required(root, "rename-cancel"),
    renameReset: required(root, "rename-reset"),
    timeline: required(root, "timeline"),
    conversation: required(root, "conversation"),
    jumpLatest: required(root, "jump-latest"),
    chatProgress: required(root, "chat-progress"),
    chatStatus: required(root, "chat-status"),
    reconnectTurn: required(root, "reconnect-turn") as HTMLButtonElement,
    chatDetail: required(root, "chat-detail"),
    chatUpdate: required(root, "chat-update"),
    chatElapsed: required(root, "chat-elapsed"),
    turnQueue: required(root, "turn-queue"),
    turnQueueStatus: required(root, "turn-queue-status"),
    turnQueueList: required(root, "turn-queue-list"),
    runNext: required(root, "run-next") as HTMLButtonElement,
    composerHint: required(root, "composer-hint"),
    composerForm: required(root, "composer-form") as HTMLFormElement,
    composer: required(root, "composer") as HTMLTextAreaElement,
    showCommands: required(root, "show-commands"),
    commandMenu: required(root, "command-menu"),
    commandPanel: required(root, "command-panel"),
    closeCommand: required(root, "close-command"),
    commandTitle: required(root, "command-title"),
    commandResult: required(root, "command-result"),
    contextPanel: required(root, "context-panel"),
    screenPanel: required(root, "screen-panel"),
    send: required(root, "send") as HTMLButtonElement,
    cancel: required(root, "cancel") as HTMLButtonElement,
    askGuidance: required(root, "ask-guidance") as HTMLButtonElement,
    watchSettings: required(root, "watch-settings"),
    guidanceCard: required(root, "guidance-card"),
    guidanceState: required(root, "guidance-state"),
    guidancePreview: required(root, "guidance-preview") as HTMLImageElement,
    guidanceFacts: required(root, "guidance-facts"),
    guidanceText: required(root, "guidance-text"),
    guidanceStatus: required(root, "guidance-status"),
    includeCurrentView: required(root, "include-current-view") as HTMLInputElement,
    includeScreenshotControl: required(root, "include-screenshot-control"),
    attachments: required(root, "attachments"),
    attachImage: required(root, "attach-image") as HTMLButtonElement,
    attachFile: required(root, "attach-file") as HTMLButtonElement,
    refreshArtifacts: required(root, "refresh-artifacts") as HTMLButtonElement,
    artifactStatus: required(root, "artifact-status"),
    artifactList: required(root, "artifact-list"),
    artifactDetail: required(root, "artifact-detail"),
    artifactDetailTitle: required(root, "artifact-detail-title"),
    artifactContent: required(root, "artifact-content"),
    closeArtifact: required(root, "close-artifact") as HTMLButtonElement,
    chooseFile: required(root, "choose-file") as HTMLButtonElement,
    fileStatus: required(root, "file-status"),
    fileGrantList: required(root, "file-grant-list"),
    captureState: required(root, "capture-state"),
    captureStatus: required(root, "capture-status"),
    captureSourceKind: required(root, "capture-source-kind") as HTMLSelectElement,
    captureEntireScreen: required(root, "capture-entire-screen") as HTMLButtonElement,
    captureWindow: required(root, "capture-window") as HTMLButtonElement,
    observeComputer: required(root, "observe-computer") as HTMLButtonElement,
    captureCandidates: required(root, "capture-candidates"),
    captureRegionControls: required(root, "capture-region-controls"),
    captureRegionEnabled: required(root, "capture-region-enabled") as HTMLInputElement,
    captureRegionX: required(root, "capture-region-x") as HTMLInputElement,
    captureRegionY: required(root, "capture-region-y") as HTMLInputElement,
    captureRegionWidth: required(root, "capture-region-width") as HTMLInputElement,
    captureRegionHeight: required(root, "capture-region-height") as HTMLInputElement,
    captureRegionStage: required(root, "capture-region-stage"),
    captureRegionImage: required(root, "capture-region-image") as HTMLImageElement,
    captureRegionOverlay: required(root, "capture-region-overlay"),
    startCapture: required(root, "start-capture") as HTMLButtonElement,
    captureLive: required(root, "capture-live"),
    capturePreview: required(root, "capture-preview") as HTMLImageElement,
    captureFacts: required(root, "capture-facts"),
    pauseCapture: required(root, "pause-capture") as HTMLButtonElement,
    resumeCapture: required(root, "resume-capture") as HTMLButtonElement,
    changeCapture: required(root, "change-capture") as HTMLButtonElement,
    stopCapture: required(root, "stop-capture") as HTMLButtonElement,
    observationState: required(root, "observation-state"),
    observationInstruction: required(root, "observation-instruction") as HTMLTextAreaElement,
    observationTrigger: required(root, "observation-trigger") as HTMLSelectElement,
    startObservation: required(root, "start-observation") as HTMLButtonElement,
    stopObservation: required(root, "stop-observation") as HTMLButtonElement,
    observationStatus: required(root, "observation-status"),
    observationSelected: required(root, "observation-selected"),
    observationSelectedPreview: required(root, "observation-selected-preview") as HTMLImageElement,
    observationSelectedFacts: required(root, "observation-selected-facts"),
    observationSent: required(root, "observation-sent"),
    observationSentPreview: required(root, "observation-sent-preview") as HTMLImageElement,
    observationSentFacts: required(root, "observation-sent-facts"),
    observationCounters: required(root, "observation-counters"),
    observationUsage: required(root, "observation-usage"),
  };
}

type RendererElements = ReturnType<typeof rendererElements>;

function renderCaptureCandidates(
  root: Document,
  list: HTMLElement,
  candidates: CaptureCandidateV1[],
  selectedId: string | null,
  pending: boolean,
  select: (candidate: CaptureCandidateV1) => void,
): void {
  list.replaceChildren(
    ...candidates.map((candidate) => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = `capture-candidate${candidate.candidateId === selectedId ? " selected" : ""}`;
      button.disabled = pending;
      button.setAttribute("aria-pressed", candidate.candidateId === selectedId ? "true" : "false");
      const preview = root.createElement("img");
      preview.src = candidate.previewUrl;
      preview.alt = "";
      const label = root.createElement("span");
      label.textContent = candidate.label;
      button.append(preview, label);
      button.addEventListener("click", () => select(candidate));
      return button;
    }),
  );
}

function renderRegionOverlay(elements: RendererElements, region: CaptureRegionV1 | null): void {
  const visible = elements.captureRegionEnabled.checked && region !== null;
  elements.captureRegionOverlay.hidden = !visible;
  if (!visible || !region) return;
  elements.captureRegionOverlay.style.left = `${region.xBps / 100}%`;
  elements.captureRegionOverlay.style.top = `${region.yBps / 100}%`;
  elements.captureRegionOverlay.style.width = `${region.widthBps / 100}%`;
  elements.captureRegionOverlay.style.height = `${region.heightBps / 100}%`;
}

function captureFacts(state: CaptureStateV1 | null, frame: CaptureFrameV1 | null): string {
  if (!state) return "";
  const source = state.sourceLabel ?? "No source";
  const kind = state.sourceKind ?? "idle";
  const latest = frame
    ? `${frame.width} × ${frame.height}, ${relativeAge(frame.capturedAt)}`
    : "No retained preview";
  return `${source} · ${kind} · ${latest} · ${state.capturedFrames} frames · ${formatBytes(state.retainedBytes)} retained`;
}

function relativeAge(capturedAt: string): string {
  const age = Math.max(0, Date.now() - Date.parse(capturedAt));
  return age < 1_000 ? "just now" : `${Math.ceil(age / 1_000)}s ago`;
}

function expiryCopy(expiresAt: string): string {
  const remaining = Date.parse(expiresAt) - Date.now();
  return remaining <= 0 ? "preview expired" : `preview expires in ${Math.ceil(remaining / 1_000)}s`;
}

function guidanceSnapshot(
  sessionId: string,
  state: CaptureStateV1 | null,
  frame: CaptureFrameV1 | null,
): GuidancePending | null {
  if (
    state?.state !== "observing" ||
    state.sessionId !== sessionId ||
    !state.captureId ||
    !state.sourceKind ||
    !state.sourceLabel ||
    !frame ||
    frame.sessionId !== sessionId ||
    frame.captureId !== state.captureId ||
    frame.sourceKind !== state.sourceKind ||
    Date.parse(frame.expiresAt) <= Date.now()
  )
    return null;
  return {
    sessionId,
    requestId: null,
    traceId: null,
    started: false,
    resultReceived: false,
    frame: { ...frame },
    captureId: state.captureId,
    sourceKind: state.sourceKind,
    sourceLabel: state.sourceLabel,
    selectedFrame: null,
    sentFrame: null,
    responseText: null,
    completed: false,
  };
}

function matchesGuidanceFrame(
  value: ObservationFrameFactV1 | null,
  pending: GuidancePending,
  requireSent: boolean,
): value is ObservationFrameFactV1 {
  return Boolean(
    value &&
      value.frameId === pending.frame.frameId &&
      value.contentHash === pending.frame.contentHash &&
      value.width === pending.frame.width &&
      value.height === pending.frame.height &&
      value.capturedAt === pending.frame.capturedAt &&
      value.expiresAt === pending.frame.expiresAt &&
      value.previewUrl === pending.frame.previewUrl &&
      value.reason === "user_send" &&
      (!requireSent ||
        (value.sentAt !== null && pending.traceId !== null && value.traceId === pending.traceId)),
  );
}

function percentagePoint(
  element: HTMLElement,
  event: PointerEvent,
): { x: number; y: number } | null {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - bounds.top) / bounds.height) * 100)),
  };
}

function setRegionInputs(
  elements: RendererElements,
  start: { x: number; y: number },
  end: { x: number; y: number },
): void {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  elements.captureRegionEnabled.checked = true;
  elements.captureRegionX.value = x.toFixed(2);
  elements.captureRegionY.value = y.toFixed(2);
  elements.captureRegionWidth.value = Math.abs(end.x - start.x).toFixed(2);
  elements.captureRegionHeight.value = Math.abs(end.y - start.y).toFixed(2);
}

function renderFileGrants(
  root: Document,
  list: HTMLElement,
  grants: FileGrantV1[],
  pending: boolean,
  act: (grant: FileGrantV1, action: "import" | "release") => void,
): void {
  list.replaceChildren(
    ...grants.map((grant) => {
      const card = root.createElement("article");
      card.className = "file-grant-card";
      const name = root.createElement("p");
      name.className = "artifact-name";
      name.textContent = grant.displayName;
      const meta = root.createElement("p");
      meta.className = "artifact-meta";
      meta.textContent = "Local file grant";
      const actions = root.createElement("div");
      actions.className = "file-grant-actions";
      if (grant.canImport)
        actions.append(fileButton(root, "Import", pending, () => act(grant, "import")));
      actions.append(fileButton(root, "Release", pending, () => act(grant, "release")));
      card.append(name, meta, actions);
      return card;
    }),
  );
}

function fileButton(
  root: Document,
  label: string,
  disabled: boolean,
  click: () => void,
): HTMLButtonElement {
  const button = root.createElement("button");
  button.type = "button";
  button.className = "quiet-button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", click);
  return button;
}

function renderArtifactList(
  root: Document,
  list: HTMLElement,
  artifacts: ArtifactCatalogItemV1[],
  pending: boolean,
  act: (item: ArtifactCatalogItemV1, action: "read" | "detach" | "restore") => void,
): void {
  const cards = artifacts.map((item) => {
    const card = root.createElement("article");
    card.className = "artifact-card";
    const name = root.createElement("p");
    name.className = "artifact-name";
    name.textContent = item.displayName;
    const meta = root.createElement("p");
    meta.className = "artifact-meta";
    const kind = item.kind === "tool_output" ? "Tool output" : "Attachment";
    const size = item.sizeBytes === null ? "Size unavailable" : formatBytes(item.sizeBytes);
    meta.textContent = `${kind} · ${item.state} · ${size}`;
    card.append(name, meta);
    if (item.summary !== null) {
      const summary = root.createElement("p");
      summary.className = "artifact-summary";
      summary.textContent = item.summary;
      card.append(summary);
    }
    if (item.actions.length) {
      const actions = root.createElement("div");
      actions.className = "artifact-actions";
      item.actions.forEach((action) => {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "quiet-button";
        button.disabled = pending;
        button.textContent =
          action === "read" ? "View" : action === "detach" ? "Detach" : "Restore";
        button.addEventListener("click", () => act(item, action));
        actions.append(button);
      });
      card.append(actions);
    } else if (item.contentKind === "unavailable") {
      const unavailable = root.createElement("p");
      unavailable.className = "artifact-summary";
      unavailable.textContent = "Content unavailable";
      card.append(unavailable);
    }
    return card;
  });
  list.replaceChildren(...cards);
}

function renderArtifactDetail(
  detail: HTMLElement,
  title: HTMLElement,
  content: HTMLElement,
  view: ArtifactView | null,
): void {
  detail.hidden = view === null;
  title.textContent = view?.item.displayName ?? "";
  content.className = `artifact-content${view?.contentKind === "diff" ? " diff" : ""}`;
  content.textContent = view?.text ?? "Content unavailable";
}

function renderAttachments(
  root: Document,
  list: HTMLElement,
  attachments: MediaAttachmentV1[],
  remove: (mediaId: string) => void,
): void {
  list.replaceChildren(
    ...attachments.map((attachment) => {
      const chip = root.createElement("div");
      chip.className = `attachment-chip${attachment.turnCompatible ? "" : " unsupported"}`;
      const name = root.createElement("span");
      name.className = "attachment-name";
      name.textContent = `${attachment.name} · ${formatBytes(attachment.sizeBytes)} · ${attachment.mimeType}`;
      name.title = name.textContent;
      chip.append(name);
      if (!attachment.turnCompatible) {
        const state = root.createElement("span");
        state.className = "attachment-state";
        state.textContent = "Not supported in chat yet";
        chip.append(state);
      }
      const button = root.createElement("button");
      button.type = "button";
      button.className = "quiet-button attachment-remove";
      button.textContent = "Remove";
      button.setAttribute("aria-label", `Remove ${attachment.name}`);
      button.addEventListener("click", () => remove(attachment.mediaId));
      chip.append(button);
      return chip;
    }),
  );
}

function releaseAttachments(api: NativeApi, attachments: MediaAttachmentV1[]): void {
  for (const attachment of attachments) {
    void api.media.release({
      sessionId: attachment.sessionId,
      mediaId: attachment.mediaId,
    });
  }
}

function releaseFileGrants(api: NativeApi, grants: FileGrantV1[]): void {
  if (!api.files) return;
  for (const grant of grants) {
    void api.files.release({
      sessionId: grant.sessionId,
      grantId: grant.grantId,
    });
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;
}

function renderSessions(
  root: Document,
  list: HTMLElement,
  sessions: SessionSummaryV1[],
  selectedId: string | null,
  taskName: (session: SessionSummaryV1) => string,
  spinners: Map<string, HTMLElement>,
  needsApproval: ReadonlySet<string>,
  select: (sessionId: string) => void,
  showContext: (session: SessionSummaryV1, button: HTMLButtonElement) => void,
  emptyMessage: string,
): void {
  const items: HTMLElement[] = sessions.map((session) => {
    const button = root.createElement("button");
    button.type = "button";
    button.className = `session-item${session.sessionId === selectedId ? " selected" : ""}`;
    const label = `${taskName(session)}${session.status === "closed" ? " · Closed" : ""}`;
    const approvalNeeded = needsApproval.has(session.sessionId);
    button.dataset.sessionId = session.sessionId;
    button.textContent = label;
    button.title = `${label}${approvalNeeded ? " · Needs approval" : ""}`;
    button.setAttribute("aria-label", button.title);
    if (approvalNeeded) {
      const marker = root.createElement("span");
      marker.className = "session-approval-marker";
      marker.textContent = "Needs approval";
      marker.setAttribute("aria-hidden", "true");
      button.append(marker);
    }
    const spinner = root.createElement("span");
    spinner.className = "session-spinner";
    spinner.hidden = true;
    spinner.setAttribute("aria-hidden", "true");
    button.append(spinner);
    spinners.set(session.sessionId, spinner);
    button.setAttribute("aria-current", session.sessionId === selectedId ? "true" : "false");
    button.addEventListener("click", () => select(session.sessionId));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContext(session, button);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        showContext(session, button);
      }
    });
    return button;
  });
  if (!items.length) {
    const empty = root.createElement("p");
    empty.className = "empty-note";
    empty.textContent = emptyMessage;
    items.push(empty);
  }
  const focusedSessionId = (root.activeElement as HTMLElement | null)?.dataset.sessionId;
  list.replaceChildren(...items);
  if (focusedSessionId) {
    items.find((item) => item.dataset.sessionId === focusedSessionId)?.focus();
  }
}

type TimelineMessage = {
  key: string;
  node: HTMLElement;
  profile: HTMLElement | null;
  usage: HTMLElement | null;
  timestamp: HTMLTimeElement;
};
const timelineMessages = new WeakMap<
  HTMLElement,
  {
    messages: TimelineMessage[];
    tools: Map<ToolProgressV1, HTMLElement>;
  }
>();

export function messageTime(createdAt?: string): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

function createMessageCopyButton(
  root: Document,
  text: string,
  copyText: NativeApi["app"]["copyText"],
  label: "Copy message" | "Copy code",
): HTMLButtonElement {
  const copy = root.createElement("button");
  copy.type = "button";
  copy.className = "quiet-button message-copy";
  copy.textContent = "Copy";
  copy.title = label;
  copy.setAttribute("aria-label", label);
  copy.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      const result = await copyText(text);
      copy.textContent = result.ok ? "Copied" : "Copy failed";
    } catch {
      copy.textContent = "Copy failed";
    }
    copy.dataset.copyState = copy.textContent === "Copied" ? "copied" : "error";
    copy.title = copy.textContent;
    copy.setAttribute("aria-label", copy.textContent);
    setTimeout(() => {
      copy.textContent = "Copy";
      copy.dataset.copyState = "";
      copy.title = label;
      copy.setAttribute("aria-label", label);
      copy.disabled = false;
    }, 1500);
  });
  return copy;
}

function renderTimeline(
  root: Document,
  timeline: HTMLElement,
  conversation: HTMLElement,
  progress: HTMLElement,
  loading: boolean,
  messages: ReadonlyArray<
    Pick<MessageV1, "role" | "body" | "profileName" | "usage"> &
      Partial<Pick<MessageV1, "createdAt">>
  >,
  turnUsageDisplay: TurnUsageDisplay,
  copyText: NativeApi["app"]["copyText"],
  automaticObservation: ObservationFrameFactV1 | null,
  activity: ActivityItem[],
  toolDisplay: ToolDisplay,
  deciding: Set<string>,
  approvalErrors: ReadonlyMap<string, ErrorV1>,
  approvalBlocked: boolean,
  approvalFocus: Set<string>,
  announcedApprovals: Set<string>,
  decide: (approval: ApprovalEventV1, decision: ApprovalDecision) => void,
): void {
  const scrollTop = conversation.scrollTop;
  const followLatest = conversation.scrollHeight - conversation.clientHeight - scrollTop <= 1;
  const cachedTimeline = timelineMessages.get(timeline);
  const previous = cachedTimeline?.messages ?? [];
  const toolCards = new Map<ToolProgressV1, HTMLElement>();
  const next: TimelineMessage[] = [];
  const items: HTMLElement[] = messages.map((message, index) => {
    const bodyText =
      message.role === "assistant"
        ? assistantBody(message.body, message.profileName)
        : message.body;
    const usageText =
      message.role === "assistant" ? formatDesktopTurnUsage(message.usage, turnUsageDisplay) : "";
    const key = JSON.stringify([message.role, bodyText]);
    const cached = previous[index];
    if (cached?.key === key) {
      if (cached.profile) {
        if (cached.profile.textContent !== (message.profileName ?? ""))
          cached.profile.textContent = message.profileName ?? "";
        cached.profile.hidden = !message.profileName;
      }
      if (cached.usage) {
        if (cached.usage.textContent !== usageText) cached.usage.textContent = usageText;
        cached.usage.hidden = !usageText;
      }
      cached.timestamp.textContent = messageTime(message.createdAt);
      cached.timestamp.dateTime = message.createdAt ?? "";
      cached.timestamp.title = message.createdAt
        ? new Date(message.createdAt).toLocaleString()
        : "";
      cached.timestamp.hidden = !cached.timestamp.textContent;
      next.push(cached);
      return cached.node;
    }
    const article = root.createElement("article");
    article.className = `message ${message.role}`;
    const role = root.createElement("p");
    role.className = message.role === "user" ? "message-role sr-only" : "message-role";
    role.textContent = message.role === "user" ? "You" : "OpenMinion";
    const profile = message.role === "assistant" ? root.createElement("span") : null;
    if (profile) {
      profile.className = "message-profile";
      profile.textContent = message.profileName ?? "";
      profile.hidden = !message.profileName;
      role.append(profile);
    }
    const body = root.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") {
      body.className += " markdown";
      renderMarkdown(root, body, bodyText, (code) =>
        createMessageCopyButton(root, code, copyText, "Copy code"),
      );
    } else body.textContent = bodyText;
    if (message.role === "user") {
      const bubble = root.createElement("div");
      bubble.className = "message-bubble";
      bubble.append(role, body);
      article.append(bubble);
    } else article.append(role, body);
    const usage = message.role === "assistant" ? root.createElement("p") : null;
    if (usage) {
      usage.className = "message-usage";
      usage.textContent = usageText;
      usage.hidden = !usageText;
      article.append(usage);
    }
    const actions = root.createElement("div");
    actions.className = "message-actions";
    const copy = createMessageCopyButton(root, bodyText, copyText, "Copy message");
    const timestamp = root.createElement("time");
    timestamp.className = "message-time";
    timestamp.textContent = messageTime(message.createdAt);
    timestamp.dateTime = message.createdAt ?? "";
    timestamp.title = message.createdAt ? new Date(message.createdAt).toLocaleString() : "";
    timestamp.hidden = !timestamp.textContent;
    actions.append(copy, timestamp);
    article.append(actions);
    next.push({ key, node: article, profile, usage, timestamp });
    return article;
  });
  if (automaticObservation) {
    const article = root.createElement("article");
    article.className = "message user observation-message";
    const role = root.createElement("p");
    role.className = "message-role";
    role.textContent = "You · Automatic observation";
    const body = root.createElement("p");
    body.className = "message-body";
    body.textContent = `Reason: ${automaticObservation.reason.replace("_", " ")}`;
    const preview = root.createElement("img");
    preview.className = "observation-message-preview";
    preview.alt = "Frame sent by automatic observation";
    preview.src = automaticObservation.previewUrl;
    const bubble = root.createElement("div");
    bubble.className = "message-bubble";
    bubble.append(role, body, preview);
    article.append(bubble);
    items.push(article);
  }
  const approvalFocusTargets = new Map<string, HTMLElement>();
  items.push(
    ...activity.map((item) => {
      if (item.kind === "tool") {
        const card = cachedTimeline?.tools.get(item) ?? renderToolCard(root, item, copyText);
        if (card.dataset.toolDisplay !== toolDisplay) {
          const output = card.querySelector("details");
          if (output) output.open = toolDisplay === "verbose";
          card.dataset.toolDisplay = toolDisplay;
        }
        toolCards.set(item, card);
        return card;
      }
      return renderApprovalCard(
        root,
        item,
        deciding.has(item.approvalId),
        approvalErrors.get(item.approvalId) ?? null,
        approvalBlocked,
        approvalFocus.has(item.approvalId),
        announcedApprovals,
        approvalFocusTargets,
        decide,
      );
    }),
  );
  if (!items.length && !loading) {
    const empty = root.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "What would you like to work on?";
    items.push(empty);
  }
  const requestIndex = messages.findLastIndex((message) => message.role === "user");
  if (requestIndex >= 0) items.splice(requestIndex + 1, 0, progress);
  else items.push(progress);
  timelineMessages.set(timeline, { messages: next, tools: toolCards });
  for (const [index, item] of items.entries()) {
    const current = timeline.children[index];
    if (current === item) continue;
    if (timeline.contains(item)) timeline.moveBefore(item, current ?? null);
    else timeline.insertBefore(item, current ?? null);
  }
  while (timeline.children.length > items.length) timeline.removeChild(timeline.lastElementChild!);
  for (const [approvalId, button] of approvalFocusTargets) {
    if (!loading && approvalFocus.delete(approvalId)) button.focus();
  }
  conversation.scrollTop = followLatest ? conversation.scrollHeight : scrollTop;
}

function renderToolCard(
  root: Document,
  item: ToolProgressV1,
  copyText: NativeApi["app"]["copyText"],
): HTMLElement {
  const card = root.createElement("article");
  card.className = "activity-card tool-card";
  const heading = root.createElement("p");
  heading.className = "activity-heading";
  heading.textContent = `${item.toolName} · ${item.phase}`;
  const details = root.createElement("p");
  details.className = "activity-details";
  const timing = item.durationMs === null ? "" : ` · ${item.durationMs} ms`;
  details.textContent = `${item.callId} · ${item.state}${timing}`;
  if (item.truncated) details.textContent += " · Output truncated";
  card.append(heading, details);
  if (item.phase === "completed" && item.content) {
    const preview = root.createElement("pre");
    preview.className = "tool-preview";
    preview.textContent = item.content.split("\n").slice(0, 6).join("\n");
    card.append(preview);
    const output = root.createElement("details");
    output.className = "tool-output";
    const summary = root.createElement("summary");
    summary.textContent = item.truncated ? "Show available output" : "Show output";
    const body = root.createElement("pre");
    body.textContent = item.content;
    output.append(summary, body);
    if (item.truncated) {
      const notice = root.createElement("p");
      notice.className = "activity-details";
      notice.textContent =
        "OpenMinion reported truncated output. Only the supplied text is available.";
      output.append(notice);
    }
    card.append(output);
    const copy = root.createElement("button");
    copy.type = "button";
    copy.className = "quiet-button";
    copy.textContent = "Copy output";
    copy.setAttribute("aria-label", `Copy output from ${item.toolName}`);
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      try {
        const result = await copyText(item.content!);
        copy.textContent = result.ok ? "Copied" : "Copy failed";
      } catch {
        copy.textContent = "Copy failed";
      }
      copy.disabled = false;
    });
    card.append(copy);
  } else if (item.phase === "completed") {
    const unavailable = root.createElement("p");
    unavailable.className = "activity-details";
    unavailable.textContent =
      item.content === "" ? "No output." : "Output is unavailable for this event.";
    card.append(unavailable);
  }
  return card;
}

function renderApprovalCard(
  root: Document,
  item: ApprovalEventV1,
  deciding: boolean,
  error: ErrorV1 | null,
  blocked: boolean,
  focusRequested: boolean,
  announcedApprovals: Set<string>,
  focusTargets: Map<string, HTMLElement>,
  decide: (approval: ApprovalEventV1, decision: ApprovalDecision) => void,
): HTMLElement {
  const card = root.createElement("article");
  card.className = "activity-card approval-card";
  card.dataset.approvalId = item.approvalId;
  card.setAttribute("aria-label", `Approval for ${item.toolName}`);
  const pending = item.outcome === "pending" && error?.retryable !== false;
  const heading = root.createElement("p");
  heading.className = "activity-heading";
  heading.textContent = `${pending ? "Needs approval" : error ? "Approval closed" : "Approval"} · ${item.toolName}`;
  const details = root.createElement("p");
  details.className = "activity-details";
  details.textContent = error
    ? error.retryable
      ? `Decision not sent · ${error.message}`
      : `Approval closed · ${error.message}`
    : deciding
      ? "Sending decision…"
      : blocked
        ? "Cancelling turn…"
        : item.outcome === "pending"
          ? "Waiting for your decision"
          : `Resolved · ${item.outcome.replaceAll("_", " ")}`;
  const preview = root.createElement("pre");
  preview.className = "approval-preview";
  preview.textContent = item.consentPreview || `${item.toolName}()`;
  card.append(heading, details, preview);
  if (pending && !announcedApprovals.has(item.approvalId)) {
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    announcedApprovals.add(item.approvalId);
  }
  if (focusRequested) {
    details.setAttribute("role", "status");
    details.setAttribute("aria-live", "polite");
    details.setAttribute("aria-atomic", "true");
    card.tabIndex = -1;
    focusTargets.set(item.approvalId, card);
  }
  if (pending) {
    const actions = root.createElement("div");
    actions.className = "approval-actions";
    const deny = root.createElement("button");
    deny.type = "button";
    deny.className = "quiet-button";
    deny.textContent = "Deny";
    deny.dataset.approvalId = item.approvalId;
    deny.disabled = deciding || blocked;
    deny.setAttribute("aria-label", `Deny ${item.toolName}`);
    deny.addEventListener("click", () => decide(item, "deny"));
    const allow = root.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow once";
    allow.dataset.approvalId = item.approvalId;
    allow.disabled = deciding || blocked;
    allow.setAttribute("aria-label", `Allow ${item.toolName} once`);
    allow.addEventListener("click", () => decide(item, "allow_once"));
    actions.append(deny, allow);
    card.append(actions);
    if (focusRequested && !deciding && !blocked) focusTargets.set(item.approvalId, deny);
  }
  return card;
}

function resolvedApproval(requested: ApprovalEventV1, result: ApprovalDecisionV1): ApprovalEventV1 {
  return {
    ...requested,
    phase: "resolved",
    decision: result.decision,
    outcome: result.outcome,
    resolvedAt: result.resolvedAt,
  };
}

function activityKey(item: ActivityItem): string {
  return item.kind === "approval"
    ? `approval:${item.approvalId}`
    : `tool:${item.traceId}:${item.callId}`;
}

function activityFromSessionEvent(sessionId: string, event: SessionEventV1): ActivityItem | null {
  const traceId = event.traceId;
  const toolName = stringFact(event, "tool_name");
  const callId = stringFact(event, "call_id") ?? stringFact(event, "command_id");
  if (!traceId || !toolName) {
    return null;
  }
  if (event.eventType === "tool.request" || event.eventType === "tool.completed") {
    if (!callId) return null;
    const completed = event.eventType === "tool.completed";
    return {
      schemaVersion: 1,
      kind: "tool",
      phase: completed ? "completed" : "started",
      sessionId,
      traceId,
      toolName,
      callId,
      state:
        event.state ?? stringFact(event, "summary_status") ?? (completed ? "completed" : "started"),
      createdAt: event.createdAt,
      ok: completed ? booleanFact(event, "ok") : null,
      durationMs: completed ? numberFact(event, "duration_ms") : null,
      exitCode: null,
    };
  }
  if (event.eventType !== "approval.requested" && event.eventType !== "approval.resolved") {
    return null;
  }
  const approvalId = stringFact(event, "approval_id");
  const outcome = stringFact(event, "outcome") as ApprovalEventV1["outcome"] | null;
  if (!approvalId || !outcome || !approvalOutcomes.has(outcome)) {
    return null;
  }
  const requested = event.eventType === "approval.requested";
  return {
    schemaVersion: 1,
    kind: "approval",
    phase: requested ? "requested" : "resolved",
    sessionId,
    traceId,
    approvalId,
    toolName,
    consentPreview: stringFact(event, "consent_preview") ?? `${toolName}()`,
    requestedAt: requested ? stringFact(event, "requested_at") : null,
    expiresAt: requested ? stringFact(event, "expires_at") : null,
    decision: decisionFact(event),
    outcome,
    resolvedAt: requested ? null : stringFact(event, "resolved_at"),
  };
}

const approvalOutcomes = new Set<ApprovalEventV1["outcome"]>([
  "pending",
  "applied",
  "denied",
  "expired",
  "cancelled",
]);

function stringFact(event: SessionEventV1, key: string): string | null {
  const value = event.facts[key];
  return typeof value === "string" ? value : null;
}

function numberFact(event: SessionEventV1, key: string): number | null {
  const value = event.facts[key];
  return typeof value === "number" ? value : null;
}

function booleanFact(event: SessionEventV1, key: string): boolean | null {
  const value = event.facts[key];
  return typeof value === "boolean" ? value : null;
}

function decisionFact(event: SessionEventV1): ApprovalDecision | null {
  const value = event.facts.decision;
  return value === "allow_once" || value === "deny" ? value : null;
}

export function assistantBody(body: string, profileName?: string | null): string {
  // PyPI responses include a speaker envelope; move only the reported speaker to the header.
  const prefix = profileName ? `${profileName}: ` : null;
  return prefix && body.startsWith(prefix) ? body.slice(prefix.length) : body;
}

export function formatDesktopTurnUsage(
  usage: InferenceUsageV1 | undefined,
  display: TurnUsageDisplay,
): string {
  if (!usage?.usageAvailable) return "";
  const parts = usage.durationMs === null ? [] : [formatDurationMs(usage.durationMs)];
  if (display === "total" && usage.totalTokens) {
    parts.push(`${formatTokenCount(usage.totalTokens)} tokens`);
  }
  if (display === "input_output" || display === "input_output_calls") {
    if (usage.inputTokens || usage.outputTokens) {
      parts.push(
        `${formatTokenCount(usage.inputTokens)} in`,
        `${formatTokenCount(usage.outputTokens)} out`,
      );
    }
    if (display === "input_output_calls" && usage.llmCalls) {
      parts.push(`${usage.llmCalls} ${usage.llmCalls === 1 ? "call" : "calls"}`);
    }
  }
  return parts.join(" · ");
}

function formatTokenCount(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return String(value);
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = value < 1_000_000 ? "k" : "m";
  return `${(value / divisor).toFixed(1).replace(".0", "")}${suffix}`;
}

function formatDurationMs(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function waitingTime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function terminalLabel(events: SessionEventV1[]): string {
  const last = events.at(-1);
  if (!last?.state) {
    return "";
  }
  if (last.state === "completed") return "";
  if (last.state === "cancelled") return "Stopped.";
  if (last.state === "failed") return "Something went wrong. Check the reply before trying again.";
  return "This conversation may still be running. Check its status before sending again.";
}

function required(root: Document, id: string): HTMLElement {
  const element = root.getElementById(id);
  if (!element) {
    throw new Error(`missing renderer element ${id}`);
  }
  return element;
}

if (typeof window !== "undefined" && window.openminion) {
  void mount(window.openminion);
}
