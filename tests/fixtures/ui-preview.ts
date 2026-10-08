import { mount } from "../../src/renderer/app.js";
import type {
  ArtifactCatalogItemV1,
  CaptureEventV1,
  CaptureFrameV1,
  CaptureStateV1,
  ClientResult,
  MediaAttachmentV1,
  MessageV1,
  NativeApi,
  ObservationStatusV1,
  SessionSummaryV1,
  TurnEventV1,
  TurnSubmitInput,
} from "../../src/shared/contracts.js";

// Explicit UI sample data. This fixture never calls a daemon, provider, or native capture API.
const now = () => new Date().toISOString();
const expires = () => new Date(Date.now() + 3600000).toISOString();
const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
let nextId = 0;
const id = () => `preview-${++nextId}`;
const createSession = (title: string): SessionSummaryV1 => ({
  schemaVersion: 1,
  sessionId: id(),
  title,
  status: "active",
  createdAt: now(),
  updatedAt: now(),
  activeAgentId: null,
  model: { provider: null, modelId: null },
  projectId: null,
  eventCursor: "0",
});
const sessions = [
  createSession("Try the desktop controls"),
  createSession("A longer sample task title to check how the sidebar handles limited space"),
];
const messages: MessageV1[] = [
  {
    schemaVersion: 1,
    id: id(),
    sessionId: sessions[0]!.sessionId,
    role: "assistant",
    createdAt: now(),
    body: "This is a UI preview. Nothing is sent to a model. Try attachments, screen/window selection, local preview, task outputs, and sending a message. Each sample turn pauses for an approval so you can try Allow once, Deny, or Stop. Changes disappear when this window closes.",
  },
];
let turnListener: (event: TurnEventV1) => void = () => {};
let captureListener: (event: CaptureEventV1) => void = () => {};
let observationListener: (value: ObservationStatusV1) => void = () => {};
let pending: { input: TurnSubmitInput; traceId: string } | null = null;
let replyTimer: ReturnType<typeof setTimeout> | null = null;
let capture: CaptureStateV1 = {
  schemaVersion: 1,
  state: "idle",
  reason: "ready",
  permission: "granted",
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
let frame: CaptureFrameV1 | null = null;
const observation: ObservationStatusV1 = {
  schemaVersion: 1,
  sessionId: null,
  state: "ready",
  watchEnabled: false,
  trigger: null,
  currentReason: null,
  selectedFrame: null,
  sentFrame: null,
  lastError: null,
  updatedAt: now(),
  counters: {
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
  },
  rates: {
    schemaVersion: 1,
    windowMs: 60000,
    capturedFrames: 0,
    inferencesStarted: 0,
    sampledAt: now(),
  },
  usage: {
    usageAvailable: false,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    llmCalls: null,
    durationMs: null,
    costUsd: null,
    costSource: "unavailable",
  },
};
const artifact: ArtifactCatalogItemV1 = {
  schemaVersion: 1,
  artifactId: "sample-output",
  sessionId: sessions[0]!.sessionId,
  kind: "artifact",
  displayName: "Sample task notes.txt",
  mimeType: "text/plain",
  sizeBytes: 90,
  createdAt: now(),
  source: "tool",
  state: "active",
  contentKind: "text",
  occurrenceCount: 1,
  toolName: null,
  toolStatus: null,
  summary: "Preview output. Open, detach, and restore this sample.",
  actions: ["read", "detach"],
};
const attachment = (sessionId: string, kind: "image" | "file"): MediaAttachmentV1 => ({
  schemaVersion: 1,
  mediaId: id(),
  sessionId,
  kind,
  name: kind === "image" ? "Sample image.png" : "Sample notes.txt",
  mimeType: kind === "image" ? "image/png" : "text/plain",
  sizeBytes: 1024,
  turnCompatible: true,
  expiresAt: expires(),
});
function publishCapture(): ClientResult<CaptureStateV1> {
  captureListener({ schemaVersion: 1, kind: "state", value: { ...capture } });
  if (capture.state === "observing" && frame) captureListener(frame);
  return ok({ ...capture });
}
function publishObservation(): ClientResult<ObservationStatusV1> {
  observation.updatedAt = now();
  observationListener({ ...observation });
  return ok({ ...observation });
}
function finish(body: string, outcome: "complete" | "cancelled" = "complete") {
  if (!pending) return;
  const { input, traceId } = pending;
  pending = null;
  if (replyTimer) clearTimeout(replyTimer);
  if (outcome === "complete") {
    messages.push({
      schemaVersion: 1,
      id: id(),
      sessionId: input.sessionId,
      role: "assistant",
      body,
      createdAt: now(),
    });
    turnListener({
      schemaVersion: 1,
      kind: "response",
      sessionId: input.sessionId,
      traceId,
      finalText: body,
      errors: [],
      usage: observation.usage,
    });
  }
  turnListener({ schemaVersion: 1, kind: "done", sessionId: input.sessionId, traceId, outcome });
}
const profileSettings = {
  setupRequired: false,
  revision: "a".repeat(64),
  defaultAgent: "sample",
  agents: [
    {
      id: "sample",
      name: "Sample agent",
      provider: "openai",
      model: "Sample model",
      baseUrl: "https://example.com/v1",
      keyConfigured: true,
    },
  ],
  credentials: [],
};
const previewNames = new Map<string, string>();
let previewQuietTools = false;
const api: NativeApi = {
  runtime: {
    control: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Runtime controls are unavailable in previews.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
    status: async () => ({
      source: "unmanaged",
      selectedSource: "pypi",
      installedVersion: null,
      availableVersion: null,
      phase: "unmanaged",
      paused: false,
      pinnedVersion: null,
    }),
    check: async () => ({
      source: "unmanaged",
      selectedSource: "pypi",
      installedVersion: null,
      availableVersion: null,
      phase: "unmanaged",
      paused: false,
      pinnedVersion: null,
    }),
    stage: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Runtime installation is unavailable in previews.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
  },
  drafts: {
    load: async () => ({ ok: true, value: [] }),
    save: async () => ({ ok: true, value: "preview-draft" }),
  },
  chatNames: {
    load: async () => ({
      ok: true,
      value: [...previewNames].map(([sessionId, title]) => ({ sessionId, title })),
    }),
    save: async ({ sessionId, title }) => {
      if (title === null) previewNames.delete(sessionId);
      else previewNames.set(sessionId, title);
      return { ok: true, value: null };
    },
  },
  presentation: {
    load: async () => ({ ok: true, value: { quietTools: previewQuietTools } }),
    save: async ({ quietTools }) => {
      previewQuietTools = quietTools;
      return { ok: true, value: null };
    },
  },
  reports: {
    read: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Reports require the connected application.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
  },
  tasks: {
    control: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Task controls require the connected application.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
  },
  delegation: {
    control: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Delegation requires the connected application.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
  },
  profiles: {
    presets: async () => ok([]),
    setup: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Setup requires OpenMinion.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
    read: async () => ok(profileSettings),
    save: async (input) => {
      Object.assign(profileSettings.agents[0], {
        model: input.model,
        baseUrl: input.baseUrl,
        keyConfigured: input.apiKey !== null,
      });
      return ok({ settings: profileSettings, daemon: await api.daemon.status() });
    },
    import: async () => ok(null),
  },
  identity: {
    read: async () =>
      ok({
        profiles: [
          {
            agentId: "openminion",
            displayName: "OpenMinion",
            source: "yaml",
            editable: true,
            readOnlyReason: null,
            authoredYaml: "agent_id: openminion\ndisplay_name: OpenMinion\n",
            profileRevision: 1,
            profileVersion: "sample-profile-version",
            sourceSha256: "sample-source-sha256",
            validationOk: true,
            sourceStatus: "clean",
            verificationIssues: [],
            generatedStatus: "clean",
            generatedFiles: ["AGENT.md", "SOUL.md", "README.md"],
            render: {
              text: "Mission: Help the operator.",
              purpose: "act",
              profileVersion: "sample-profile-version",
              renderVersion: "sample-render-version",
              includedFields: ["role.mission"],
              omittedFields: [],
            },
          },
        ],
      }),
    verify: async () =>
      ok({
        agentId: "openminion",
        validationOk: true,
        issues: [],
        render: {
          text: "Mission: Help the operator.",
          purpose: "act",
          profileVersion: "sample-profile-version",
          renderVersion: "sample-render-version",
          includedFields: ["role.mission"],
          omittedFields: [],
        },
      }),
    save: async () => {
      const result = await api.identity.read();
      return result.ok ? ok(result.value.profiles[0]) : result;
    },
    reload: async () => api.identity.read(),
  },
  app: {
    openLink: async () => ({ ok: true, value: null }),
    copyText: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Clipboard access is disabled in UI preview. Copy is available in the real app.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
    info: async () => ({ appName: "OpenMinion", shellVersion: "UI preview · simulated" }),
  },
  daemon: {
    inspect: async () => ok({ text: "Preview diagnostics · simulated" }),
    status: async () => ({
      state: "ready",
      reachable: true,
      daemonVersion: "sample",
      protocol: 1,
      configId: null,
      capabilities: [],
      errorCode: null,
    }),
    retry: async () => api.daemon.status(),
  },
  sessions: {
    export: async () => ({
      ok: false,
      error: {
        code: "preview_only",
        message: "Export requires the connected application.",
        retryable: false,
        retryAfterMs: null,
      },
    }),
    list: async () => ok({ sessions: [...sessions], nextCursor: null, hasMore: false }),
    create: async ({ title }) => {
      const session = createSession(title ?? "New task");
      sessions.unshift(session);
      return ok(session);
    },
    load: async ({ sessionId }) =>
      ok({
        session: sessions.find((s) => s.sessionId === sessionId)!,
        messages: messages.filter((m) => m.sessionId === sessionId),
        nextMessageCursor: "0",
        messagesHasMore: false,
      }),
    close: async ({ sessionId }) => {
      const session = sessions.find((s) => s.sessionId === sessionId)!;
      session.status = "closed";
      return ok({ ...session });
    },
    events: async () => ok({ events: [], nextCursor: "0", hasMore: false }),
  },
  turns: {
    reconnect: async ({ sessionId, traceId }) =>
      ok({ sessionId, traceId, requestId: "preview-request" }),
    subscribe: (listener) => {
      turnListener = listener;
      return () => {
        turnListener = () => {};
      };
    },
    submit: async (input) => {
      const traceId = id();
      const requestId = id();
      pending = { input, traceId };
      messages.push({
        schemaVersion: 1,
        id: id(),
        sessionId: input.sessionId,
        role: "user",
        body: input.message,
        createdAt: now(),
      });
      turnListener({
        schemaVersion: 1,
        kind: "started",
        sessionId: input.sessionId,
        traceId,
        requestId,
      });
      if (input.observation && frame) {
        observation.sessionId = input.sessionId;
        observation.currentReason = "user_send";
        observation.selectedFrame = {
          ...frame,
          reason: "user_send",
          selectedAt: now(),
          sentAt: null,
          traceId,
        };
        observation.sentFrame = { ...observation.selectedFrame, sentAt: now() };
        observation.selectedFrame = observation.sentFrame;
        publishObservation();
      }
      setTimeout(() => {
        if (pending?.traceId !== traceId) return;
        turnListener({
          schemaVersion: 1,
          kind: "approval",
          phase: "requested",
          sessionId: input.sessionId,
          traceId,
          approvalId: traceId,
          toolName: "Sample action (preview only)",
          consentPreview: 'sample="preview value"',
          requestedAt: now(),
          expiresAt: expires(),
          decision: null,
          outcome: "pending",
          resolvedAt: null,
        });
      }, 300);
      return ok({ sessionId: input.sessionId, traceId, requestId });
    },
    cancel: async ({ sessionId, traceId }) => {
      finish("", "cancelled");
      return ok({ sessionId, traceId, runId: null, state: "cancelled", terminal: true });
    },
  },
  approvals: {
    decide: async (input) => {
      const body =
        input.decision === "deny"
          ? "Sample action denied. No action was performed."
          : "Sample action allowed. This is a simulated response; no provider, file, or desktop was accessed.";
      replyTimer = setTimeout(() => finish(body), 700);
      return ok({
        schemaVersion: 1,
        ...input,
        callId: input.traceId,
        outcome: input.decision === "deny" ? "denied" : "applied",
        resolvedAt: now(),
      });
    },
  },
  media: {
    pick: async ({ sessionId, kind }) => ok({ attachments: [attachment(sessionId, kind)] }),
    release: async ({ mediaId }) => ok({ mediaId, released: true }),
  },
  files: {
    pick: async ({ sessionId }) =>
      ok({
        grant: {
          schemaVersion: 1,
          sessionId,
          grantId: id(),
          kind: "file",
          displayName: "Sample local notes.txt",
          expiresAt: expires(),
          canList: false,
          canImport: true,
        },
      }),
    list: async ({ grantId }) => ok({ grantId, entries: [], nextCursor: null, complete: true }),
    import: async ({ sessionId, grantId }) =>
      ok({ grantId, entryId: null, attachment: attachment(sessionId, "file") }),
    release: async ({ grantId }) => ok({ grantId, released: true }),
  },
  artifacts: {
    list: async ({ sessionId }) =>
      ok({ artifacts: [{ ...artifact, sessionId }], nextCursor: null, complete: true }),
    read: async ({ sessionId, artifactId }) =>
      ok({
        schemaVersion: 1,
        sessionId,
        artifactId,
        contentKind: "text",
        text: "Sample output for checking the Context viewer. No task was executed.",
        complete: true,
        nextCursor: null,
      }),
    detach: async (input) => {
      artifact.state = "detached";
      artifact.actions = ["read", "restore"];
      return ok({ ...input, state: "detached", outcome: "applied" });
    },
    restore: async (input) => {
      artifact.state = "active";
      artifact.actions = ["read", "detach"];
      return ok({ ...input, state: "active", outcome: "applied" });
    },
  },
  capture: {
    status: async () => ok({ ...capture }),
    subscribe: (listener) => {
      captureListener = listener;
      return () => {
        captureListener = () => {};
      };
    },
    sources: async ({ sessionId, sourceKind }) => {
      capture = { ...capture, state: "selecting", sessionId, parentSourceKind: sourceKind };
      return ok({
        schemaVersion: 1,
        permission: "granted",
        truncated: false,
        expiresAt: expires(),
        candidates: [
          {
            schemaVersion: 1,
            candidateId: sourceKind,
            sourceKind,
            label: sourceKind === "display" ? "Sample entire screen" : "Sample window",
            previewUrl: "/logo.png",
            previewWidth: 800,
            previewHeight: 500,
            scaleFactor: 1,
          },
        ],
      });
    },
    start: async ({ sessionId, candidateId, region }) => {
      const sourceKind = candidateId === "display" ? "display" : "window";
      capture = {
        ...capture,
        state: "observing",
        reason: "user_started",
        sessionId,
        captureId: id(),
        sourceKind: region ? "region" : sourceKind,
        parentSourceKind: sourceKind,
        sourceLabel: "Sample screenshot — no desktop captured",
        startedAt: now(),
        scaleFactor: 1,
      };
      frame = {
        schemaVersion: 1,
        kind: "frame",
        captureId: capture.captureId!,
        frameId: id(),
        sessionId,
        sourceKind: capture.sourceKind!,
        parentSourceKind: sourceKind,
        width: 800,
        height: 500,
        scaleFactor: 1,
        capturedAt: now(),
        expiresAt: expires(),
        contentHash: "a".repeat(64),
        encoding: "image/jpeg",
        sizeBytes: 1024,
        previewUrl: "/logo.png",
      };
      observation.sessionId = sessionId;
      setTimeout(publishCapture, 0);
      return ok({ ...capture });
    },
    pause: async () => {
      capture.state = "paused";
      capture.reason = "user_paused";
      capture.pausedAt = now();
      return publishCapture();
    },
    resume: async () => {
      capture.state = "observing";
      capture.reason = "user_resumed";
      return publishCapture();
    },
    stop: async () => {
      capture = {
        ...capture,
        state: "idle",
        reason: "user_stopped",
        captureId: null,
        sourceKind: null,
        sourceLabel: null,
      };
      frame = null;
      observation.watchEnabled = false;
      observation.selectedFrame = null;
      observation.sentFrame = null;
      publishObservation();
      return publishCapture();
    },
  },
  observation: {
    status: async () => ok({ ...observation }),
    subscribe: (listener) => {
      observationListener = listener;
      return () => {
        observationListener = () => {};
      };
    },
    configure: async ({ sessionId, trigger }) => {
      observation.sessionId = sessionId;
      observation.trigger = trigger;
      observation.watchEnabled = true;
      observation.state = "waiting";
      return publishObservation();
    },
    stop: async () => {
      observation.watchEnabled = false;
      observation.state = "ready";
      return publishObservation();
    },
  },
};
const notice = document.createElement("p");
notice.className = "empty-note";
notice.textContent = "UI preview · Sample data only. No daemon, model, files, or screen access.";
document.querySelector(".sidebar-brand")!.after(notice);
await mount(api);
document.querySelector("#connection-label")!.textContent = "UI preview";
document.querySelector("#status-summary")!.textContent =
  "Local sample data. No daemon is connected.";
