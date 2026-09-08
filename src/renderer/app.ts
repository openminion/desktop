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
  CaptureStateV1,
  CaptureSourceKind,
  ClientResult,
  DaemonStatus,
  ErrorV1,
  FileGrantV1,
  MediaAttachmentV1,
  MessageV1,
  NativeApi,
  ObservationFrameFactV1,
  ObservationStatusV1,
  SessionEventV1,
  SessionSummaryV1,
  ToolProgressV1,
  TurnEventV1,
  TurnSubmitValue,
} from "../shared/contracts.js";

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
  label: string;
  error: ErrorV1 | null;
};

export type RecoveredSession = {
  session: SessionSummaryV1;
  messages: MessageV1[];
  events: SessionEventV1[];
};

export type ActivityItem = ToolProgressV1 | ApprovalEventV1;

export const DESKTOP_COMMANDS = [
  { name: "/help", description: "Show commands currently connected in Desktop" },
  { name: "/new", description: "Start a new session" },
  { name: "/sessions", description: "Pick a session" },
  { name: "/status", description: "Show connection, task, agent, and model" },
  { name: "/model", description: "Show reported model (selection not connected yet)" },
  { name: "/copy", description: "Copy the latest reply" },
  { name: "/clear", description: "Clear the visible chat; keep saved history" },
  { name: "/quiet", description: "Hide tool activity; keep approvals visible" },
  { name: "/normal", description: "Show tool activity" },
] as const;

export function commandMatches(text: string) {
  return DESKTOP_COMMANDS.filter((command) => command.name.startsWith(text.trim()));
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

export function statusView(status: DaemonStatus): StatusView {
  if (status.state === "ready") {
    return {
      label: "Connected",
      summary: "Ready for messages and screen context.",
      tone: "ready",
      showRetry: false,
      showRecovery: false,
    };
  }
  if (status.state === "degraded") {
    return {
      label: "Not connected",
      summary: "Reconnect to send messages and use screen context.",
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
    label: "Choose or create a task to begin.",
    error: null,
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
      sessionId: event.sessionId,
      traceId: event.traceId,
      terminalTraceId: null,
      active: true,
      label: "OpenMinion is working…",
      error: null,
    };
  }
  if (event.sessionId !== state.sessionId || event.traceId !== state.traceId) {
    return state;
  }
  if (event.kind === "progress") {
    return {
      ...state,
      label:
        event.progressKind === "status"
          ? (event.label ?? event.detailText ?? "OpenMinion is working…")
          : "Receiving response…",
    };
  }
  if (event.kind === "response") {
    return {
      ...state,
      label: event.errors.length ? "Turn completed with an error." : "Response received.",
      error: event.errors[0] ?? null,
    };
  }
  if (event.kind === "error") {
    return { ...state, label: event.error.message, error: event.error };
  }
  if (event.kind === "tool" || event.kind === "approval") {
    return state;
  }
  return {
    ...state,
    traceId: null,
    terminalTraceId: event.traceId,
    active: false,
    label:
      event.outcome === "complete"
        ? "Turn complete."
        : event.outcome === "cancelled"
          ? "Turn cancelled."
          : "Turn ended with an error.",
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
    label: "OpenMinion is working…",
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
          argumentKeys: event.argumentKeys.length ? event.argumentKeys : prior.argumentKeys,
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
        ? { sessionId: item.sessionId, artifactId: item.artifactId, limitBytes: 64 * 1024 }
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
      return { item, contentKind, text: contentKind === "unavailable" ? null : pages.join("") };
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
    const page = await api.sessions.events({ sessionId, after: eventCursor, limit: 200 });
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
  let daemonReady = false;
  let creatingTask = false;
  let messages: MessageV1[] = [];
  const drafts = new Map<string, string>();
  let submittedText: string | null = null;
  let responseText = "";
  const liveTurns = new Map<
    string,
    { state: ChatState; responseText: string; activity: ActivityItem[] }
  >();
  let hiddenMessageCount = 0;
  let quietTools = false;
  let commandIndex = 0;
  let commandDraft: string | null = null;
  let commandsDismissed = false;
  let activity: ActivityItem[] = [];
  let attachments: MediaAttachmentV1[] = [];
  let artifacts: ArtifactCatalogItemV1[] = [];
  let artifactView: ArtifactView | null = null;
  let artifactLabel = "Choose a session to view its artifacts.";
  let artifactPending = false;
  let fileGrants: FileGrantV1[] = [];
  let fileLabel = "Choose a session to import local files.";
  let attachmentPending = false;
  const deciding = new Set<string>();
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
    Boolean(
      selected &&
        attachments.every(
          (attachment) => attachment.sessionId === selected?.sessionId && attachment.turnCompatible,
        ),
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
      selected &&
        selected.status !== "closed" &&
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
    const writable = Boolean(selected && selected.status !== "closed" && observationApi);
    const state = observationStatus?.state ?? "idle";
    elements.observationState.textContent = state[0]!.toUpperCase() + state.slice(1);
    elements.observationStatus.textContent =
      observationMessage ?? observationStatusCopy(observationStatus, writable);
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
      ? "Automatic watch enabled · sends repeated screenshots"
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
    const writable = Boolean(selected && selected.status !== "closed" && api.files);
    elements.chooseFile.disabled = !writable || chat.active || attachmentPending;
    elements.fileStatus.textContent = fileLabel;
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
    const result = await api.files.release({ sessionId: grant.sessionId, grantId: grant.grantId });
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
        void api.files.release({ sessionId, grantId: result.value.grant.grantId });
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
    const writable = Boolean(selected && selected.status !== "closed");
    elements.refreshArtifacts.disabled = !writable || artifactPending;
    elements.artifactStatus.textContent = artifactLabel;
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
    }
  };

  const renderCommandMenu = () => {
    const value = elements.composer.value.trim();
    const matches = commandMatches(value);
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
        button.setAttribute("aria-selected", String(index === commandIndex));
        const name = root.createElement("span");
        name.className = "command-name";
        name.textContent = command.name;
        const description = root.createElement("span");
        description.className = "command-description";
        description.textContent = command.description;
        button.append(name, description);
        button.addEventListener("click", () => void runCommand(command.name));
        return button;
      }),
    );
    elements.commandMenu.hidden = false;
    elements.showCommands.setAttribute("aria-expanded", "true");
    elements.composer.setAttribute("aria-activedescendant", `command-option-${commandIndex}`);
    elements.commandMenu.children[commandIndex]?.scrollIntoView({ block: "nearest" });
  };

  const showCommandResult = (title: string, text: string) => {
    elements.commandTitle.textContent = title;
    const paragraph = root.createElement("p");
    paragraph.textContent = text;
    elements.commandResult.replaceChildren(paragraph);
    elements.commandPanel.showPopover();
  };

  const runCommand = async (text: string): Promise<boolean> => {
    const value = text.trim();
    if (!value.startsWith("/") || value.startsWith("//")) return false;
    const [name, ...args] = value.split(/\s+/);
    const aliases: Record<string, string> = {
      "/": "/help",
      "/session": "/sessions",
      "/cls": "/clear",
    };
    const command = aliases[name] ?? name;
    if (!DESKTOP_COMMANDS.some((item) => item.name === command)) {
      hideCommandMenu();
      showCommandResult(
        "Command unavailable",
        `${name} is not available in Desktop. Type /help for supported commands. This text was not sent to the model.`,
      );
      return true;
    }
    if (args.length && !(command === "/new" && args.join(" ") === "session")) {
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
    elements.composer.focus();
    switch (command) {
      case "/help":
        showCommandResult(
          "Focus commands — partial integration",
          "Desktop presents OpenMinion Focus. Only the commands below are connected so far; model selection and other Focus operations still require integration. Type / and use ↑ / ↓. Enter runs a command; Tab completes its name. Escape dismisses the menu. Use // for a message beginning with /.",
        );
        for (const item of DESKTOP_COMMANDS) {
          const button = root.createElement("button");
          button.type = "button";
          button.className = "command-option";
          button.textContent = `${item.name}  ${item.description}`;
          button.addEventListener("click", () => {
            elements.commandPanel.hidePopover();
            void runCommand(item.name);
          });
          elements.commandResult.append(button);
        }
        break;
      case "/new": {
        const button = elements.newSession;
        if (!daemonReady || button.disabled)
          showCommandResult(
            "Task unavailable",
            "Connect OpenMinion and finish or cancel the active turn before changing this task.",
          );
        else button.click();
        break;
      }
      case "/sessions":
        showCommandResult(
          "Choose a task",
          sessions.length
            ? "Resume a saved conversation."
            : "No saved tasks. Connect OpenMinion and create a new task.",
        );
        for (const session of sessions) {
          const button = root.createElement("button");
          button.type = "button";
          button.className = "command-option";
          button.textContent = `${session.title ?? "Untitled task"} · ${session.status}`;
          button.addEventListener("click", () => {
            elements.commandPanel.hidePopover();
            void selectSession(session);
          });
          elements.commandResult.append(button);
        }
        break;
      case "/status":
      case "/model":
        showCommandResult(
          command === "/model" ? "Configured model" : "Task status",
          [
            elements.connectionLabel.textContent,
            `Task: ${selected?.title ?? "No task selected"}`,
            `Agent: ${selected?.activeAgentId ?? "Not reported"}`,
            `Provider: ${selected?.model.provider ?? "Not reported"}`,
            `Model: ${selected?.model.modelId ?? "Not reported"}`,
            chat.label,
            "Model selection through Focus is not connected in Desktop yet.",
          ].join("\n"),
        );
        break;
      case "/copy": {
        const text =
          responseText ||
          messages.slice(hiddenMessageCount).findLast((item) => item.role === "assistant")?.body;
        if (!text) showCommandResult("Copy reply", "There is no reply to copy yet.");
        else {
          const result = await api.app.copyText(text);
          showCommandResult(
            "Copy reply",
            result.ok ? "Copied to clipboard." : result.error.message,
          );
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
          activity = [];
          showCommandResult(
            "Chat cleared",
            "Saved history is unchanged. Select the task again to restore it.",
          );
        }
        break;
      case "/quiet":
        quietTools = true;
        break;
      case "/normal":
        quietTools = false;
        break;
    }
    renderChat();
    return true;
  };

  const renderChat = () => {
    const writable = Boolean(selected && selected.status !== "closed");
    const attachmentsValid = turnAttachmentsAreValid();
    elements.chatStatus.textContent = chat.label;
    elements.newSession.disabled = creatingTask || chat.active;
    const isCommand =
      elements.composer.value.trimStart().startsWith("/") &&
      !elements.composer.value.trimStart().startsWith("//");
    elements.send.disabled =
      !isCommand &&
      (!daemonReady ||
        !writable ||
        chat.active ||
        attachmentPending ||
        !elements.composer.value.trim() ||
        !attachmentsValid);
    elements.cancel.hidden = !chat.active;
    elements.cancel.disabled = !chat.active || !chat.traceId;
    elements.send.title = isCommand
      ? "Run command"
      : !daemonReady
        ? "Connect OpenMinion to send this draft"
        : !writable
          ? "Create or choose a task to send"
          : "Send message (⌘ / Ctrl + Enter)";
    elements.composer.disabled = false;
    elements.closeSession.disabled = !writable || chat.active || attachmentPending;
    elements.attachImage.disabled =
      !writable || chat.active || attachmentPending || attachments.length >= 4;
    elements.attachFile.disabled = elements.attachImage.disabled;
    elements.currentTitle.textContent = selected?.title ?? "New task";
    elements.currentTitle.title = elements.currentTitle.textContent;
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
    renderFiles();
    renderTimeline(
      root,
      elements.timeline,
      [
        ...messages.slice(hiddenMessageCount),
        ...(submittedText === null ? [] : [{ role: "user" as const, body: submittedText }]),
        ...(responseText ? [{ role: "assistant" as const, body: responseText }] : []),
      ],
      automaticObservation,
      quietTools ? activity.filter((item) => item.kind === "approval") : activity,
      deciding,
      (approval, decision) => {
        if (deciding.has(approval.approvalId)) {
          return;
        }
        deciding.add(approval.approvalId);
        const generation = selectionGeneration;
        renderChat();
        void api.approvals
          .decide({
            sessionId: approval.sessionId,
            traceId: approval.traceId,
            approvalId: approval.approvalId,
            decision,
          })
          .then((result) => {
            deciding.delete(approval.approvalId);
            const live = liveTurns.get(approval.sessionId);
            if (result.ok && live)
              live.activity = applyActivityEvent(
                live.activity,
                resolvedApproval(approval, result.value),
              );
            if (generation !== selectionGeneration || selected?.sessionId !== approval.sessionId) {
              return;
            }
            if (!result.ok) {
              showError(result.error);
              return;
            }
            activity = applyActivityEvent(activity, resolvedApproval(approval, result.value));
            renderChat();
          });
      },
    );
    renderObservation();
    renderCommandMenu();
  };

  const showError = (error: ErrorV1) => {
    chat = { ...chat, label: error.message, error };
    renderChat();
  };

  const selectSession = async (
    session: SessionSummaryV1,
    terminalTraceId: string | null = null,
    preserveGuidance = false,
  ) => {
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
    selected = session;
    messages = [];
    submittedText = null;
    responseText = "";
    hiddenMessageCount = 0;
    capturePending = Boolean(captureApi);
    artifacts = [];
    artifactView = null;
    artifactLabel = "Loading artifacts…";
    fileLabel = "Choose a local file to import.";
    activity = [];
    deciding.clear();
    chat = {
      ...initialChatState(),
      sessionId: session.sessionId,
      terminalTraceId,
      label: "Loading conversation…",
    };
    renderSessions(root, elements.sessionList, sessions, session.sessionId, (id) => {
      const next = sessions.find((item) => item.sessionId === id);
      if (next) {
        void selectSession(next);
      }
    });
    renderChat();
    renderArtifacts();
    renderFiles();
    renderCapture();
    const artifactsLoading = loadArtifacts(session.sessionId, generation);
    const recovered = await recoverSession(api, session.sessionId);
    if (generation !== selectionGeneration || selected?.sessionId !== session.sessionId) {
      return;
    }
    await Promise.all([artifactsLoading, refreshCaptureStatus(), refreshObservationStatus()]);
    if (generation !== selectionGeneration || selected?.sessionId !== session.sessionId) {
      return;
    }
    capturePending = false;
    renderCapture();
    if ("code" in recovered) {
      showError(recovered);
      return;
    }
    selected = recovered.session;
    messages = recovered.messages;
    automaticObservation = null;
    activity = recoverActivity(recovered.session.sessionId, recovered.events);
    chat = {
      ...initialChatState(),
      sessionId: recovered.session.sessionId,
      terminalTraceId,
      label: terminalLabel(recovered.events),
    };
    const live = liveTurns.get(session.sessionId);
    if (live) {
      chat = live.state;
      // Accepted user text is already present in authoritative history after switching.
      submittedText = null;
      responseText = live.responseText;
      for (const item of live.activity) activity = applyActivityEvent(activity, item);
    }
    renderChat();
  };

  const loadSessions = async () => {
    const result = await listSessions(api);
    if ("code" in result) {
      showError(result);
      return;
    }
    sessions = result;
    renderSessions(root, elements.sessionList, sessions, selected?.sessionId ?? null, (id) => {
      const next = sessions.find((item) => item.sessionId === id);
      if (next) {
        void selectSession(next);
      }
    });
    if (!selected && sessions[0]) {
      await selectSession(sessions[0]);
    } else if (!sessions.length) {
      renderChat();
    }
  };

  const renderStatus = (status: DaemonStatus) => {
    const view = statusView(status);
    daemonReady = status.state === "ready";
    if (!selected) {
      chat = {
        ...chat,
        label: daemonReady
          ? "Write a draft, then create a task to send."
          : view.showRecovery
            ? ""
            : "Connecting to OpenMinion…",
      };
    }
    elements.statusDot.className = `status-dot ${view.tone}`;
    elements.statusSummary.textContent = view.summary;
    elements.retry.hidden = !view.showRetry;
    elements.recovery.hidden = !view.showRecovery;
    elements.daemonVersion.textContent = status.daemonVersion ?? "Unavailable";
    elements.protocolVersion.textContent = status.protocol?.toString() ?? "Unavailable";
    elements.connectionLabel.textContent = view.label;
    renderChat();
  };

  const refresh = async (): Promise<void> => {
    let status = await api.daemon.status();
    renderStatus(status);
    if (status.state !== "ready" && status.state !== "degraded") {
      status = await api.daemon.retry();
      renderStatus(status);
    }
    if (status.state === "ready") {
      await loadSessions();
    }
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
    const live = liveTurns.get(event.sessionId);
    if (live) {
      const matchesTurn = live.state.traceId === event.traceId;
      if (matchesTurn && (event.kind === "tool" || event.kind === "approval"))
        live.activity = applyActivityEvent(live.activity, event);
      if (matchesTurn && event.kind === "progress" && event.progressKind === "text")
        live.responseText += event.text;
      if (matchesTurn && event.kind === "response") live.responseText = event.finalText;
      live.state = applyTurnEvent(live.state, event);
      if (selected?.sessionId === event.sessionId) responseText = live.responseText;
      if (event.kind === "done" && matchesTurn) liveTurns.delete(event.sessionId);
    }
    acceptGuidanceTurnEvent(event);
    if (
      (event.kind === "tool" || event.kind === "approval") &&
      selected?.sessionId === event.sessionId
    ) {
      activity = applyActivityEvent(activity, event);
    }
    chat = applyTurnEvent(chat, event);
    renderChat();
    if (event.kind === "done" && selected?.sessionId === event.sessionId) {
      void selectSession(selected, event.traceId, true);
    }
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

  elements.showConnection.addEventListener("click", () => {
    elements.connectionDetails.open = true;
    elements.retry.focus();
  });
  elements.retry.addEventListener("click", async () => {
    elements.retry.disabled = true;
    const status = await api.daemon.retry();
    renderStatus(status);
    if (status.state === "ready") {
      await loadSessions();
    }
    elements.retry.disabled = false;
  });
  elements.newSession.addEventListener("click", async () => {
    if (creatingTask || chat.active) return;
    if (!daemonReady) {
      elements.composer.focus();
      return;
    }
    creatingTask = true;
    renderChat();
    const result = await api.sessions.create({ title: "New task" });
    creatingTask = false;
    if (!result.ok) {
      showError(result.error);
      return;
    }
    sessions = [result.value, ...sessions];
    await selectSession(result.value);
    elements.composer.focus();
  });
  elements.closeSession.addEventListener("click", async () => {
    if (!selected || chat.active) {
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
    artifacts = [];
    artifactView = null;
    artifactLabel = "This session is closed.";
    fileLabel = "This session is closed.";
    renderSessions(root, elements.sessionList, sessions, selected.sessionId, (id) => {
      const next = sessions.find((item) => item.sessionId === id);
      if (next) {
        void selectSession(next);
      }
    });
    chat = { ...chat, label: "Session closed." };
    renderChat();
    renderArtifacts();
    renderFiles();
    renderCapture();
  });
  const submitTurn = async (asGuidance: boolean) => {
    if (!asGuidance && (await runCommand(elements.composer.value))) return;
    if (!selected || !daemonReady || chat.active) {
      return;
    }
    const draft = elements.composer.value;
    const message = draft.trim().replace(/^\/\//, "/");
    if (!message) {
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
    if (pending) {
      clearGuidanceTimer();
      guidancePending = pending;
      guidanceView = null;
      guidanceMessage = "Submitting guidance request…";
    }
    chat = { ...chat, active: true, label: "Submitting turn…", error: null };
    submittedText = message;
    responseText = "";
    const sessionId = selected.sessionId;
    liveTurns.set(sessionId, { state: chat, responseText: "", activity: [] });
    releaseFileGrants(api, fileGrants);
    fileGrants = [];
    fileLabel = "File grants released for this turn.";
    renderChat();
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
    const generation = ++submissionGeneration;
    const includeCurrentView = asGuidance || elements.includeCurrentView.checked;
    const result = await api.turns.submit({
      sessionId: selected.sessionId,
      message,
      ...(attachments.length
        ? { attachmentIds: attachments.map((attachment) => attachment.mediaId) }
        : {}),
      ...(includeCurrentView ? { observation: { includeCurrentView: true as const } } : {}),
    });
    const live = liveTurns.get(sessionId);
    if (live && result.ok) live.state = applySubmitResult(live.state, result.value);
    if (!result.ok) liveTurns.delete(sessionId);
    if (generation !== submissionGeneration) {
      if (result.ok && drafts.get(sessionId) === draft) drafts.delete(sessionId);
      if (selected?.sessionId === sessionId) {
        if (result.ok && elements.composer.value === draft) elements.composer.value = "";
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
    if (elements.composer.value === draft) elements.composer.value = "";
    drafts.delete(selected.sessionId);
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
  elements.composer.addEventListener("input", () => {
    commandIndex = 0;
    commandsDismissed = false;
    renderChat();
  });
  const openCommands = () => {
    if (!elements.composer.value.startsWith("/")) commandDraft = elements.composer.value;
    elements.composer.value = "/";
    commandsDismissed = false;
    commandIndex = 0;
    elements.composer.focus();
    renderChat();
  };
  elements.showCommands.addEventListener("click", openCommands);
  root.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openCommands();
    }
  });
  elements.composer.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const matches = commandMatches(elements.composer.value);
    if (!elements.commandMenu.hidden) {
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
          elements.composer.value = `${command.name} `;
          commandsDismissed = true;
          renderChat();
        } else if (command) void runCommand(command.name);
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
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
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
    if (!selected || !chat.traceId) {
      return;
    }
    elements.cancel.disabled = true;
    const result = await api.turns.cancel({
      sessionId: selected.sessionId,
      traceId: chat.traceId,
    });
    if (!result.ok) {
      showError(result.error);
      return;
    }
    chat = {
      ...chat,
      active: !result.value.terminal,
      label: result.value.terminal ? `Turn ${result.value.state}.` : "Cancellation requested…",
    };
    if (result.value.terminal) liveTurns.delete(selected.sessionId);
    renderChat();
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
    connectionDetails: required(root, "connection-details") as HTMLDetailsElement,
    recovery: required(root, "recovery"),
    daemonVersion: required(root, "daemon-version"),
    protocolVersion: required(root, "protocol-version"),
    shellVersion: required(root, "shell-version"),
    connectionLabel: required(root, "connection-label"),
    screenContextSummary: required(root, "screen-context-summary"),
    screenContextName: required(root, "screen-context-name"),
    screenContextStatus: required(root, "screen-context-status"),
    screenContextPreview: required(root, "screen-context-preview") as HTMLImageElement,
    sessionList: required(root, "session-list"),
    newSession: required(root, "new-session") as HTMLButtonElement,
    closeSession: required(root, "close-session") as HTMLButtonElement,
    currentTitle: required(root, "current-title"),
    timeline: required(root, "timeline"),
    chatStatus: required(root, "chat-status"),
    composerForm: required(root, "composer-form") as HTMLFormElement,
    composer: required(root, "composer") as HTMLTextAreaElement,
    showCommands: required(root, "show-commands"),
    commandMenu: required(root, "command-menu"),
    commandPanel: required(root, "command-panel"),
    commandTitle: required(root, "command-title"),
    commandResult: required(root, "command-result"),
    contextPanel: required(root, "context-panel"),
    screenPanel: required(root, "screen-panel"),
    send: required(root, "send") as HTMLButtonElement,
    cancel: required(root, "cancel") as HTMLButtonElement,
    askGuidance: required(root, "ask-guidance") as HTMLButtonElement,
    guidanceCard: required(root, "guidance-card"),
    guidanceState: required(root, "guidance-state"),
    guidancePreview: required(root, "guidance-preview") as HTMLImageElement,
    guidanceFacts: required(root, "guidance-facts"),
    guidanceText: required(root, "guidance-text"),
    guidanceStatus: required(root, "guidance-status"),
    includeCurrentView: required(root, "include-current-view") as HTMLInputElement,
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
    void api.files.release({ sessionId: grant.sessionId, grantId: grant.grantId });
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
  select: (sessionId: string) => void,
): void {
  const items: HTMLElement[] = sessions.map((session) => {
    const button = root.createElement("button");
    button.type = "button";
    button.className = `session-item${session.sessionId === selectedId ? " selected" : ""}`;
    button.textContent = `${session.title ?? "Untitled task"}${session.status === "closed" ? " · Closed" : ""}`;
    button.title = button.textContent;
    button.setAttribute("aria-current", session.sessionId === selectedId ? "true" : "false");
    button.addEventListener("click", () => select(session.sessionId));
    return button;
  });
  if (!items.length) {
    const empty = root.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "Your tasks will appear here.";
    items.push(empty);
  }
  list.replaceChildren(...items);
}

function renderTimeline(
  root: Document,
  timeline: HTMLElement,
  messages: ReadonlyArray<Pick<MessageV1, "role" | "body">>,
  automaticObservation: ObservationFrameFactV1 | null,
  activity: ActivityItem[],
  deciding: Set<string>,
  decide: (approval: ApprovalEventV1, decision: ApprovalDecision) => void,
): void {
  const scrollTop = timeline.scrollTop;
  const followLatest = timeline.scrollHeight - timeline.clientHeight - scrollTop <= 1;
  const items: HTMLElement[] = messages.map((message) => {
    const article = root.createElement("article");
    article.className = `message ${message.role}`;
    const role = root.createElement("p");
    role.className = "message-role";
    role.textContent = message.role === "user" ? "You" : "OpenMinion";
    const body = root.createElement("p");
    body.className = "message-body";
    body.textContent = message.body;
    article.append(role, body);
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
    article.append(role, body, preview);
    items.push(article);
  }
  items.push(
    ...activity.map((item) =>
      item.kind === "tool"
        ? renderToolCard(root, item)
        : renderApprovalCard(root, item, deciding.has(item.approvalId), decide),
    ),
  );
  if (!items.length) {
    const empty = root.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "What would you like to work on?";
    items.push(empty);
  }
  timeline.replaceChildren(...items);
  timeline.scrollTop = followLatest ? timeline.scrollHeight : scrollTop;
}

function renderToolCard(root: Document, item: ToolProgressV1): HTMLElement {
  const card = root.createElement("article");
  card.className = "activity-card tool-card";
  const heading = root.createElement("p");
  heading.className = "activity-heading";
  heading.textContent = `${item.toolName} · ${item.phase}`;
  const details = root.createElement("p");
  details.className = "activity-details";
  const timing = item.durationMs === null ? "" : ` · ${item.durationMs} ms`;
  details.textContent = `${item.callId} · ${item.state}${timing}`;
  card.append(heading, details);
  return card;
}

function renderApprovalCard(
  root: Document,
  item: ApprovalEventV1,
  deciding: boolean,
  decide: (approval: ApprovalEventV1, decision: ApprovalDecision) => void,
): HTMLElement {
  const card = root.createElement("article");
  card.className = "activity-card approval-card";
  card.dataset.approvalId = item.approvalId;
  const heading = root.createElement("p");
  heading.className = "activity-heading";
  heading.textContent = `Approval · ${item.toolName}`;
  const details = root.createElement("p");
  details.className = "activity-details";
  details.textContent = `${item.callId} · ${item.outcome}`;
  const keys = root.createElement("p");
  keys.className = "argument-keys";
  keys.textContent = item.argumentKeys.length
    ? `Argument names: ${item.argumentKeys.join(", ")}`
    : "No argument names provided.";
  card.append(heading, details, keys);
  if (item.outcome === "pending") {
    const actions = root.createElement("div");
    actions.className = "approval-actions";
    const deny = root.createElement("button");
    deny.type = "button";
    deny.className = "quiet-button";
    deny.textContent = "Deny";
    deny.disabled = deciding;
    deny.addEventListener("click", () => decide(item, "deny"));
    const allow = root.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow once";
    allow.disabled = deciding;
    allow.addEventListener("click", () => decide(item, "allow_once"));
    actions.append(deny, allow);
    card.append(actions);
  }
  return card;
}

function resolvedApproval(requested: ApprovalEventV1, result: ApprovalDecisionV1): ApprovalEventV1 {
  return {
    ...requested,
    phase: "resolved",
    decision: result.decision,
    outcome: result.decision === "allow_once" ? "applied" : "denied",
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
  if (!traceId || !toolName || !callId) {
    return null;
  }
  if (event.eventType === "tool.request" || event.eventType === "tool.completed") {
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
  if (
    event.eventType !== "desktop.approval.requested" &&
    event.eventType !== "desktop.approval.resolved"
  ) {
    return null;
  }
  const approvalId = stringFact(event, "approval_id");
  const outcome = stringFact(event, "outcome") as ApprovalEventV1["outcome"] | null;
  if (!approvalId || !outcome || !approvalOutcomes.has(outcome)) {
    return null;
  }
  const requested = event.eventType === "desktop.approval.requested";
  const keys = event.facts.argument_keys;
  return {
    schemaVersion: 1,
    kind: "approval",
    phase: requested ? "requested" : "resolved",
    sessionId,
    traceId,
    approvalId,
    toolName,
    callId,
    argumentKeys: Array.isArray(keys) ? [...keys] : [],
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
  "interrupted",
  "event_failed",
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

function terminalLabel(events: SessionEventV1[]): string {
  const last = events.at(-1);
  if (!last?.state) {
    return "History loaded. Ready for a new turn.";
  }
  if (["completed", "failed", "cancelled"].includes(last.state)) {
    return `Last turn ${last.state}.`;
  }
  return "History loaded. A previous turn may still be active.";
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
