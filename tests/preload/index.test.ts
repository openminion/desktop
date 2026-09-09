import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../src/shared/contracts.js";

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe("preload surface", () => {
  beforeEach(() => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
    invoke.mockReset();
    on.mockReset();
    removeListener.mockReset();
  });

  it("exposes only the exact typed desktop methods", async () => {
    await import("../../src/preload/index.js");
    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, api] = exposeInMainWorld.mock.calls[0];
    expect(name).toBe("openminion");
    expect(Object.keys(api)).toEqual([
      "reports",
      "tasks",
      "profiles",
      "app",
      "daemon",
      "sessions",
      "turns",
      "approvals",
      "artifacts",
      "files",
      "media",
      "capture",
      "observation",
    ]);
    expect(Object.keys(api.reports)).toEqual(["read"]);
    await api.reports.read({ kind: "tools" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.reportsRead, { kind: "tools" });
    await api.sessions.export({ sessionId: "session-1" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.sessionsExport, { sessionId: "session-1" });
    invoke.mockClear();
    expect(Object.keys(api.tasks)).toEqual(["control"]);
    await api.tasks.control({ sessionId: "session-1", action: "list" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.tasksControl, {
      sessionId: "session-1",
      action: "list",
    });
    invoke.mockClear();
    expect(Object.keys(api.profiles)).toEqual(["presets", "setup", "read", "save", "import"]);
    expect(Object.keys(api.app)).toEqual(["copyText", "info"]);
    expect(Object.keys(api.daemon)).toEqual(["status", "retry"]);
    expect(Object.keys(api.sessions)).toEqual([
      "export",
      "list",
      "create",
      "load",
      "close",
      "events",
    ]);
    expect(Object.keys(api.turns)).toEqual(["submit", "cancel", "subscribe"]);
    expect(Object.keys(api.approvals)).toEqual(["decide"]);
    expect(Object.keys(api.artifacts)).toEqual(["list", "read", "detach", "restore"]);
    expect(Object.keys(api.files)).toEqual(["pick", "list", "import", "release"]);
    expect(Object.keys(api.media)).toEqual(["pick", "release"]);
    expect(Object.keys(api.capture)).toEqual([
      "status",
      "sources",
      "start",
      "pause",
      "resume",
      "stop",
      "subscribe",
    ]);
    expect(Object.keys(api.observation)).toEqual(["status", "configure", "stop", "subscribe"]);
    expect(api).not.toHaveProperty("request");
    expect(api).not.toHaveProperty("send");
    expect(api).not.toHaveProperty("invoke");

    await api.profiles.read();
    await api.profiles.presets();
    await api.profiles.setup({ presetId: "minimax" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.profilesPresets);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.profilesSetup, { presetId: "minimax" });
    await api.profiles.save({ agentId: "writer" });
    await api.profiles.import({ revision: "a".repeat(64) });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.profilesRead);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.profilesSave, { agentId: "writer" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.profilesImport, { revision: "a".repeat(64) });
    invoke.mockClear();
    invoke.mockResolvedValue({ state: "ready" });
    await api.app.copyText("Local reply");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.copyText, "Local reply");
    invoke.mockClear();
    await api.daemon.status();
    await api.daemon.retry();
    await api.sessions.list({ limit: 10 });
    await api.sessions.create({ title: "Chat" });
    await api.sessions.load({ sessionId: "session-1" });
    await api.sessions.close({ sessionId: "session-1" });
    await api.sessions.events({ sessionId: "session-1" });
    await api.turns.submit({ sessionId: "session-1", message: "Hello" });
    await api.turns.cancel({ sessionId: "session-1", traceId: "trace-1" });
    await api.approvals.decide({
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      decision: "allow_once",
    });
    await api.artifacts.list({ sessionId: "session-1", limit: 10 });
    await api.artifacts.read({
      sessionId: "session-1",
      artifactId: "a".repeat(48),
      limitBytes: 1024,
    });
    await api.artifacts.detach({ sessionId: "session-1", artifactId: "a".repeat(48) });
    await api.artifacts.restore({ sessionId: "session-1", artifactId: "a".repeat(48) });
    await api.files.pick({ sessionId: "session-1", kind: "directory" });
    await api.files.list({ sessionId: "session-1", grantId: "g".repeat(48) });
    await api.files.import({
      sessionId: "session-1",
      grantId: "g".repeat(48),
      entryId: "e".repeat(48),
    });
    await api.files.release({ sessionId: "session-1", grantId: "g".repeat(48) });
    await api.media.pick({ sessionId: "session-1", kind: "image" });
    await api.media.release({ sessionId: "session-1", mediaId: "a".repeat(48) });
    await api.capture.status();
    await api.capture.sources({ sessionId: "session-1", sourceKind: "display" });
    await api.capture.start({
      sessionId: "session-1",
      candidateId: "c".repeat(48),
      region: null,
    });
    await api.capture.pause();
    await api.capture.resume();
    await api.capture.stop();
    await api.observation.status();
    await api.observation.configure({
      sessionId: "session-1",
      instruction: "Watch for a completed build",
      trigger: "changes",
    });
    await api.observation.stop();
    expect(invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.daemonStatus);
    expect(invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.daemonRetry);
    expect(invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.sessionsList, {
      limit: 10,
    });
    expect(invoke).toHaveBeenNthCalledWith(8, IPC_CHANNELS.turnsSubmit, {
      sessionId: "session-1",
      message: "Hello",
    });
    expect(invoke).toHaveBeenNthCalledWith(9, IPC_CHANNELS.turnsCancel, {
      sessionId: "session-1",
      traceId: "trace-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(10, IPC_CHANNELS.approvalsDecide, {
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      decision: "allow_once",
    });
    expect(invoke).toHaveBeenNthCalledWith(11, IPC_CHANNELS.artifactsList, {
      sessionId: "session-1",
      limit: 10,
    });
    expect(invoke).toHaveBeenNthCalledWith(12, IPC_CHANNELS.artifactsRead, {
      sessionId: "session-1",
      artifactId: "a".repeat(48),
      limitBytes: 1024,
    });
    expect(invoke).toHaveBeenNthCalledWith(13, IPC_CHANNELS.artifactsDetach, {
      sessionId: "session-1",
      artifactId: "a".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(14, IPC_CHANNELS.artifactsRestore, {
      sessionId: "session-1",
      artifactId: "a".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(15, IPC_CHANNELS.filesPick, {
      sessionId: "session-1",
      kind: "directory",
    });
    expect(invoke).toHaveBeenNthCalledWith(16, IPC_CHANNELS.filesList, {
      sessionId: "session-1",
      grantId: "g".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(17, IPC_CHANNELS.filesImport, {
      sessionId: "session-1",
      grantId: "g".repeat(48),
      entryId: "e".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(18, IPC_CHANNELS.filesRelease, {
      sessionId: "session-1",
      grantId: "g".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(19, IPC_CHANNELS.mediaPick, {
      sessionId: "session-1",
      kind: "image",
    });
    expect(invoke).toHaveBeenNthCalledWith(20, IPC_CHANNELS.mediaRelease, {
      sessionId: "session-1",
      mediaId: "a".repeat(48),
    });
    expect(invoke).toHaveBeenNthCalledWith(21, IPC_CHANNELS.captureStatus);
    expect(invoke).toHaveBeenNthCalledWith(22, IPC_CHANNELS.captureSources, {
      sessionId: "session-1",
      sourceKind: "display",
    });
    expect(invoke).toHaveBeenNthCalledWith(23, IPC_CHANNELS.captureStart, {
      sessionId: "session-1",
      candidateId: "c".repeat(48),
      region: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(24, IPC_CHANNELS.capturePause);
    expect(invoke).toHaveBeenNthCalledWith(25, IPC_CHANNELS.captureResume);
    expect(invoke).toHaveBeenNthCalledWith(26, IPC_CHANNELS.captureStop);
    expect(invoke).toHaveBeenNthCalledWith(27, IPC_CHANNELS.observationStatus);
    expect(invoke).toHaveBeenNthCalledWith(28, IPC_CHANNELS.observationConfigure, {
      sessionId: "session-1",
      instruction: "Watch for a completed build",
      trigger: "changes",
    });
    expect(invoke).toHaveBeenNthCalledWith(29, IPC_CHANNELS.observationStop);

    const first = vi.fn();
    const firstUnsubscribe = api.turns.subscribe(first);
    const firstWrapped = on.mock.calls[0][1];
    const second = vi.fn();
    const secondUnsubscribe = api.turns.subscribe(second);
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.turnEvent, firstWrapped);
    const secondWrapped = on.mock.calls[1][1];
    secondWrapped(
      { sender: "must-not-cross" },
      {
        schemaVersion: 1,
        kind: "started",
        requestId: "request-1",
        traceId: "trace-1",
        sessionId: "session-1",
      },
    );
    expect(second).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "started",
      requestId: "request-1",
      traceId: "trace-1",
      sessionId: "session-1",
    });
    secondWrapped(null, {
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-1",
      finalText: "Done",
      errors: [],
      usage: {
        usageAvailable: true,
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        llmCalls: 1,
        durationMs: 20,
        costUsd: null,
        costSource: "unavailable",
      },
    });
    expect(second).toHaveBeenCalledTimes(2);
    secondWrapped(null, {
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-1",
      finalText: "No usage",
      errors: [],
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
    });
    expect(second).toHaveBeenCalledTimes(3);
    secondWrapped(null, {
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-1",
      finalText: "unsafe",
      errors: [],
      usage: {
        usageAvailable: true,
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 9,
        llmCalls: 1,
        durationMs: 20,
        costUsd: null,
        costSource: "unavailable",
      },
    });
    expect(second).toHaveBeenCalledTimes(3);
    secondWrapped(null, {
      schemaVersion: 1,
      kind: "approval",
      phase: "requested",
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      toolName: "workspace.search",
      callId: "call-1",
      argumentKeys: ["path", "query"],
      requestedAt: "2026-08-20T00:00:00Z",
      expiresAt: "2026-08-20T00:01:00Z",
      decision: null,
      outcome: "pending",
      resolvedAt: null,
    });
    expect(second).toHaveBeenCalledTimes(4);
    secondWrapped(null, {
      schemaVersion: 1,
      kind: "started",
      requestId: "request-1",
      traceId: "trace-1",
      sessionId: "session-1",
      token: "must-not-cross",
    });
    expect(second).toHaveBeenCalledTimes(4);
    firstUnsubscribe();
    secondUnsubscribe();
    secondUnsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.turnEvent, secondWrapped);

    const observationListener = vi.fn();
    const unsubscribeObservation = api.observation.subscribe(observationListener);
    const observationWrapped = on.mock.calls.at(-1)![1];
    const status = observationStatus();
    observationWrapped(null, status);
    expect(observationListener).toHaveBeenCalledWith(status);
    const waitingWithError = {
      ...status,
      lastError: {
        code: "observation_backpressure",
        message: "Observation is waiting for the active turn.",
        retryable: true,
        retryAfterMs: 1000,
      },
    };
    observationWrapped(null, waitingWithError);
    expect(observationListener).toHaveBeenLastCalledWith(waitingWithError);
    observationWrapped(null, {
      ...status,
      lastError: {
        code: "observation_backpressure",
        message: "token=must-not-cross",
        retryable: true,
        retryAfterMs: 1000,
      },
    });
    observationWrapped(null, { ...status, token: "must-not-cross" });
    observationWrapped(null, {
      ...status,
      state: "inferencing",
      sentFrame: null,
    });
    observationWrapped(null, {
      ...status,
      state: "selecting",
      selectedFrame: null,
    });
    observationWrapped(null, {
      ...status,
      state: "stopping",
      selectedFrame: observationFrame(),
    });
    observationWrapped(null, {
      ...status,
      state: "failed",
      lastError: {
        code: "observation_turn_failed",
        message: "Automatic observation turn failed.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    expect(observationListener).toHaveBeenCalledTimes(2);
    unsubscribeObservation();
    unsubscribeObservation();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.observationEvent, observationWrapped);
  });
});

function observationStatus() {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    watchEnabled: true,
    trigger: "changes",
    state: "waiting",
    currentReason: null,
    selectedFrame: null,
    sentFrame: null,
    counters: {
      schemaVersion: 1,
      captureFrames: 1,
      captureBytes: 128,
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
      windowMs: 60_000,
      capturedFrames: 1,
      inferencesStarted: 0,
      sampledAt: "2026-08-22T00:00:00Z",
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
    lastError: null,
    updatedAt: "2026-08-22T00:00:00Z",
  };
}

function observationFrame() {
  const frameId = "a".repeat(48);
  return {
    schemaVersion: 1,
    frameId,
    contentHash: "b".repeat(64),
    width: 1280,
    height: 720,
    capturedAt: "2026-08-22T00:00:00Z",
    expiresAt: "2026-08-22T00:00:05Z",
    previewUrl: `openminion://app/capture/frames/${frameId}`,
    reason: "user_send",
    selectedAt: "2026-08-22T00:00:00Z",
    sentAt: null,
    traceId: null,
  };
}
