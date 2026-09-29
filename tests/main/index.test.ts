import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CaptureService, type CapturePlatform } from "../../src/main/capture.js";
import { mount } from "../../src/renderer/app.js";
import {
  CAPTURE_WORKER_CONFIG_CHANNEL,
  CAPTURE_WORKER_EVENT_CHANNEL,
} from "../../src/shared/capture-worker.js";
import { IPC_CHANNELS, type NativeApi, type TurnEventV1 } from "../../src/shared/contracts.js";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  ipcHandlers: new Map<string, (...args: any[]) => unknown>(),
  ipcListeners: new Map<string, (...args: any[]) => unknown>(),
  exposedApi: null as NativeApi | null,
  rendererListeners: new Map<string, (...args: any[]) => void>(),
  windows: [] as any[],
  permissionStatus: "granted" as string,
  desktopSources: [] as any[],
  displays: [] as any[],
  powerListeners: new Map<string, (...args: any[]) => unknown>(),
  screenListeners: new Map<string, (...args: any[]) => unknown>(),
  appSession: null as any,
  decodedSize: { width: 800, height: 600 },
  rendererEvents: [] as unknown[],
}));

vi.mock("electron", () => {
  const frame = {
    url: "openminion://app/",
    detached: false,
    send(channel: string, payload: unknown) {
      if (channel === "openminion:capture-event") mocks.rendererEvents.push(payload);
      mocks.rendererListeners.get(channel)?.({}, payload);
    },
  };
  class BrowserWindow {
    options: Record<string, unknown>;
    loadedUrl: string | null = null;
    destroyed = false;
    title = "OpenMinion";
    events = new Map<string, (...args: any[]) => unknown>();
    mainFrame = {
      url: "",
      detached: false,
      send: vi.fn(),
    };
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
        this.webEvents.set(name, listener);
      }),
      reload: vi.fn(),
      send: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(true),
      get mainFrame() {
        return (this as any).__owner.mainFrame;
      },
      __owner: this,
    };
    webEvents = new Map<string, (...args: any[]) => unknown>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.windows.push(this);
    }

    async loadURL(url: string) {
      this.loadedUrl = url;
      this.mainFrame.url = url;
    }

    on(name: string, listener: (...args: any[]) => unknown) {
      this.events.set(name, listener);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.events.get("closed")?.();
    }

    setTitle(value: string) {
      this.title = value;
    }
  }
  return {
    shell: { openExternal: mocks.openExternal },
    app: {
      whenReady: vi.fn(() => new Promise(() => {})),
      on: vi.fn(),
      quit: vi.fn(),
      dock: { setBadge: vi.fn(), setIcon: vi.fn() },
    },
    clipboard: { writeText: vi.fn() },
    BrowserWindow,
    desktopCapturer: {
      getSources: vi.fn(async () => mocks.desktopSources),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        mocks.ipcHandlers.set(channel, handler);
      }),
      on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
        mocks.ipcListeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
        if (mocks.ipcListeners.get(channel) === listener) mocks.ipcListeners.delete(channel);
      }),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, api: NativeApi) => {
        mocks.exposedApi = api;
      }),
    },
    ipcRenderer: {
      invoke(channel: string, input?: unknown) {
        return mocks.ipcHandlers.get(channel)?.(
          { senderFrame: frame, sender: { mainFrame: frame } },
          input,
        );
      },
      on(channel: string, listener: (...args: any[]) => void) {
        mocks.rendererListeners.set(channel, listener);
      },
      removeListener(channel: string, listener: (...args: any[]) => void) {
        if (mocks.rendererListeners.get(channel) === listener) {
          mocks.rendererListeners.delete(channel);
        }
      },
    },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    session: { fromPartition: vi.fn(() => mocks.appSession) },
    dialog: { showOpenDialog: vi.fn() },
    powerMonitor: {
      on: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
        mocks.powerListeners.set(name, listener);
      }),
      removeListener: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
        if (mocks.powerListeners.get(name) === listener) mocks.powerListeners.delete(name);
      }),
    },
    screen: {
      getAllDisplays: vi.fn(() => mocks.displays),
      on: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
        mocks.screenListeners.set(name, listener);
      }),
      removeListener: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
        if (mocks.screenListeners.get(name) === listener) mocks.screenListeners.delete(name);
      }),
    },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => mocks.permissionStatus),
    },
    nativeImage: {
      createFromBuffer: vi.fn(() => ({
        isEmpty: () => false,
        getSize: () => mocks.decodedSize,
      })),
    },
  };
});

let desktop: typeof import("../../src/main/index.js");

beforeAll(async () => {
  desktop = await import("../../src/main/index.js");
  await import("../../src/preload/index.js");
});

describe("desktop main boundary", () => {
  it("registers only the fixed desktop IPC handlers", async () => {
    const client = {
      controlTasks: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { tasks: [], pendingActions: 0 } }),
      list: vi.fn(),
      create: vi.fn(),
      load: vi.fn(),
      close: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
      decide: vi.fn(),
      listArtifacts: vi.fn(),
      readArtifact: vi.fn(),
      detachArtifact: vi.fn(),
      restoreArtifact: vi.fn(),
      validateSessionClose: vi.fn((input: any) =>
        input?.sessionId === "session-1" &&
        Object.keys(input).every((key) => key === "sessionId" || key === "reason")
          ? { ok: true, value: { sessionId: input.sessionId } }
          : {
              ok: false,
              error: {
                code: "invalid_request",
                message: "The close request is invalid.",
                retryable: false,
                retryAfterMs: null,
              },
            },
      ),
      validateTurnSubmission: vi.fn((input: any) =>
        input?.sessionId?.trim() === "session-1" && typeof input?.message === "string"
          ? {
              ok: true,
              value: {
                sessionId: "session-1",
                input: { ...input, sessionId: "session-1" },
              },
            }
          : {
              ok: false,
              error: {
                code: "invalid_request",
                message: "The turn request is invalid.",
                retryable: false,
                retryAfterMs: null,
              },
            },
      ),
      submit: vi.fn(),
    };
    const supervisor = {
      inspect: vi.fn().mockResolvedValue({ ok: true, value: { text: "daemon status" } }),
      status: vi.fn().mockResolvedValue({ state: "ready" }),
      retry: vi.fn().mockResolvedValue({ state: "probing" }),
      client,
    };
    const media = { pick: vi.fn(), release: vi.fn() };
    const files = {
      pick: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
      release: vi.fn(),
      activateSession: vi.fn(),
      fenceSession: vi.fn(),
    };
    let emitCapture: ((event: unknown) => unknown) | undefined;
    const capture = {
      status: vi.fn().mockReturnValue({ ok: true, value: { state: "idle" } }),
      sources: vi.fn(),
      start: vi.fn(async (_input, emit) => {
        emitCapture = emit;
        emit({ schemaVersion: 1, kind: "state", value: { state: "starting" } });
        return { ok: true, value: { state: "observing" } };
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn().mockResolvedValue({ ok: true, value: observationState() }),
      activateSession: vi.fn(),
      fenceSession: vi.fn(),
    };
    const observation = {
      activateSession: vi.fn(),
      fenceSession: vi.fn(),
      acceptCaptureEvent: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
      preemptAutomaticForManual: vi.fn().mockResolvedValue(true),
      beginManualTurn: vi.fn().mockReturnValue({
        admitted: true,
        token: Symbol("manual-turn"),
      }),
      endManualTurn: vi.fn(),
      prepareManualTurn: vi.fn(),
      acceptTurnEvent: vi.fn().mockReturnValue(true),
      settleSubmission: vi.fn(),
      validatePreparedTurn: vi.fn().mockReturnValue({ ok: true, value: { ready: true } }),
      connectTurnOwner: vi.fn(),
      validateManualTurn: vi.fn().mockReturnValue({ ok: true, value: { ready: true } }),
      setListener: vi.fn(),
      status: vi.fn().mockReturnValue({ ok: true, value: observationState() }),
      configure: vi.fn().mockReturnValue({ ok: true, value: observationState() }),
    };
    desktop.registerIpcHandlers(
      supervisor as never,
      media as never,
      files as never,
      capture as never,
      observation as never,
    );
    expect(observation.connectTurnOwner).toHaveBeenCalledOnce();
    expect([...mocks.ipcHandlers.keys()]).toEqual([
      IPC_CHANNELS.runtimeStatus,
      IPC_CHANNELS.runtimeCheck,
      IPC_CHANNELS.runtimeStage,
      IPC_CHANNELS.runtimeControl,
      IPC_CHANNELS.chatNamesLoad,
      IPC_CHANNELS.chatNamesSave,
      IPC_CHANNELS.presentationLoad,
      IPC_CHANNELS.presentationSave,
      IPC_CHANNELS.tasksControl,
      IPC_CHANNELS.reportsRead,
      IPC_CHANNELS.sessionsExport,
      IPC_CHANNELS.openLink,
      IPC_CHANNELS.copyText,
      IPC_CHANNELS.profilesRead,
      IPC_CHANNELS.profilesPresets,
      IPC_CHANNELS.profilesSetup,
      IPC_CHANNELS.profilesSave,
      IPC_CHANNELS.profilesImport,
      IPC_CHANNELS.daemonInspect,
      IPC_CHANNELS.daemonStatus,
      IPC_CHANNELS.daemonRetry,
      IPC_CHANNELS.sessionsList,
      IPC_CHANNELS.sessionsCreate,
      IPC_CHANNELS.sessionsLoad,
      IPC_CHANNELS.sessionsClose,
      IPC_CHANNELS.sessionsEvents,
      IPC_CHANNELS.turnsCancel,
      IPC_CHANNELS.approvalsDecide,
      IPC_CHANNELS.artifactsList,
      IPC_CHANNELS.artifactsRead,
      IPC_CHANNELS.artifactsDetach,
      IPC_CHANNELS.artifactsRestore,
      IPC_CHANNELS.filesPick,
      IPC_CHANNELS.filesList,
      IPC_CHANNELS.filesImport,
      IPC_CHANNELS.filesRelease,
      IPC_CHANNELS.mediaPick,
      IPC_CHANNELS.mediaRelease,
      IPC_CHANNELS.captureStatus,
      IPC_CHANNELS.captureSources,
      IPC_CHANNELS.captureStart,
      IPC_CHANNELS.capturePause,
      IPC_CHANNELS.captureResume,
      IPC_CHANNELS.captureStop,
      IPC_CHANNELS.observationStatus,
      IPC_CHANNELS.observationConfigure,
      IPC_CHANNELS.observationStop,
      IPC_CHANNELS.turnsSubmit,
    ]);
    await mocks.ipcHandlers.get(IPC_CHANNELS.daemonStatus)!();
    await mocks.ipcHandlers.get(IPC_CHANNELS.daemonRetry)!();
    expect(supervisor.status).toHaveBeenCalledOnce();
    expect(supervisor.retry).toHaveBeenCalledOnce();

    const mainFrame = {
      url: "openminion://app/",
      detached: false,
      send: vi.fn(),
    };
    const sender = {
      mainFrame,
    };
    const event = { senderFrame: mainFrame, sender };
    await mocks.ipcHandlers.get(IPC_CHANNELS.daemonInspect)!(event, "logs");
    expect(supervisor.inspect).toHaveBeenCalledExactlyOnceWith("logs");
    await mocks.ipcHandlers.get(IPC_CHANNELS.tasksControl)!(event, {
      sessionId: "session-1",
      action: "list",
    });
    expect(client.controlTasks).toHaveBeenCalledWith({ sessionId: "session-1", action: "list" });
    for (const channel of [
      IPC_CHANNELS.runtimeControl,
      IPC_CHANNELS.daemonInspect,
      IPC_CHANNELS.chatNamesLoad,
      IPC_CHANNELS.chatNamesSave,
      IPC_CHANNELS.presentationLoad,
      IPC_CHANNELS.presentationSave,
      IPC_CHANNELS.tasksControl,
      IPC_CHANNELS.reportsRead,
      IPC_CHANNELS.sessionsExport,
      IPC_CHANNELS.profilesRead,
      IPC_CHANNELS.profilesPresets,
      IPC_CHANNELS.profilesSetup,
      IPC_CHANNELS.profilesSave,
      IPC_CHANNELS.profilesImport,
    ]) {
      expect(
        await mocks.ipcHandlers.get(channel)!(
          { senderFrame: { url: "https://example.com" }, sender },
          {},
        ),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(
      await mocks.ipcHandlers.get(IPC_CHANNELS.profilesImport)!(event, { path: "/arbitrary" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const copyText = mocks.ipcHandlers.get(IPC_CHANNELS.copyText)!;
    const { clipboard } = await import("electron");
    expect(copyText(event, { text: "Wrong shape" })).toMatchObject({ ok: false });
    expect(copyText(event, "x".repeat(1024 * 1024 + 1))).toMatchObject({ ok: false });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(copyText(event, "Local reply")).toEqual({ ok: true, value: null });
    expect(clipboard.writeText).toHaveBeenCalledWith("Local reply");
    expect(copyText({ senderFrame: null }, "Denied")).toMatchObject({ ok: false });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    client.create.mockResolvedValue({ ok: true, value: { sessionId: "session-1" } });
    client.load.mockResolvedValue({
      ok: true,
      value: { session: { sessionId: "session-1" } },
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsCreate)!(event, {});
    await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsLoad)!(event, {
      sessionId: "session-1",
    });
    expect(capture.activateSession).toHaveBeenCalledTimes(2);
    expect(capture.activateSession).toHaveBeenLastCalledWith("session-1");
    expect(observation.activateSession).toHaveBeenCalledTimes(2);
    expect(observation.activateSession).toHaveBeenLastCalledWith("session-1");
    await mocks.ipcHandlers.get(IPC_CHANNELS.captureStatus)!(event);
    expect(capture.status).toHaveBeenCalledOnce();
    expect(await mocks.ipcHandlers.get(IPC_CHANNELS.captureStatus)!(event, {})).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(capture.status).toHaveBeenCalledOnce();
    await mocks.ipcHandlers.get(IPC_CHANNELS.captureSources)!(event, {
      sessionId: "session-1",
      sourceKind: "display",
    });
    expect(capture.sources).toHaveBeenCalledWith({
      sessionId: "session-1",
      sourceKind: "display",
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.captureStart)!(event, {
      sessionId: "session-1",
      candidateId: "a".repeat(48),
      region: null,
    });
    expect(mainFrame.send).toHaveBeenCalledWith(
      IPC_CHANNELS.captureEvent,
      expect.objectContaining({ kind: "state" }),
    );
    expect(observation.acceptCaptureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "state" }),
    );
    expect(observation.acceptCaptureEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mainFrame.send.mock.invocationCallOrder[0],
    );
    await mocks.ipcHandlers.get(IPC_CHANNELS.capturePause)!(event);
    expect(observation.stop).toHaveBeenCalledOnce();
    expect(observation.stop.mock.invocationCallOrder[0]).toBeLessThan(
      capture.pause.mock.invocationCallOrder[0],
    );
    await mocks.ipcHandlers.get(IPC_CHANNELS.captureStop)!(event);
    expect(observation.stop).toHaveBeenCalledTimes(2);
    expect(observation.stop.mock.invocationCallOrder[1]).toBeLessThan(
      capture.stop.mock.invocationCallOrder[0],
    );
    expect(await mocks.ipcHandlers.get(IPC_CHANNELS.observationStatus)!(event)).toMatchObject({
      ok: true,
      value: { state: "ready" },
    });
    expect(observation.setListener).toHaveBeenCalledOnce();
    const observationSink = observation.setListener.mock.calls[0][0];
    const observationTurnSink = observation.setListener.mock.calls[0][1];
    expect(observationSink(observationState())).toBe(true);
    expect(mainFrame.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.observationEvent,
      observationState(),
    );
    const automaticEvent = {
      schemaVersion: 1,
      kind: "started",
      requestId: "request-auto",
      traceId: "trace-auto",
      sessionId: "session-1",
    };
    expect(observationTurnSink(automaticEvent)).toBe(true);
    expect(mainFrame.send).toHaveBeenLastCalledWith(IPC_CHANNELS.turnEvent, automaticEvent);
    await mocks.ipcHandlers.get(IPC_CHANNELS.observationConfigure)!(event, {
      sessionId: "session-1",
      instruction: "Watch the build",
      trigger: "changes",
    });
    expect(observation.configure).toHaveBeenCalledWith({
      sessionId: "session-1",
      instruction: "Watch the build",
      trigger: "changes",
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.observationStop)!(event);
    expect(observation.stop).toHaveBeenCalledTimes(3);
    expect(await mocks.ipcHandlers.get(IPC_CHANNELS.observationStop)!(event, {})).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(observation.stop).toHaveBeenCalledTimes(3);
    await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsList)!(event, { limit: 5 });
    expect(client.list).toHaveBeenCalledWith({ limit: 5 });
    await mocks.ipcHandlers.get(IPC_CHANNELS.approvalsDecide)!(event, {
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      decision: "deny",
    });
    expect(client.decide).toHaveBeenCalledWith({
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      decision: "deny",
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.artifactsList)!(event, {
      sessionId: "session-1",
      limit: 25,
    });
    expect(client.listArtifacts).toHaveBeenCalledWith({
      sessionId: "session-1",
      limit: 25,
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.mediaPick)!(event, {
      sessionId: "session-1",
      kind: "image",
    });
    expect(media.pick).toHaveBeenCalledWith({
      sessionId: "session-1",
      kind: "image",
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.filesPick)!(event, {
      sessionId: "session-1",
      kind: "directory",
    });
    expect(files.pick).toHaveBeenCalledWith({
      sessionId: "session-1",
      kind: "directory",
    });

    const denied = await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsLoad)!(
      {
        senderFrame: { url: "https://example.com/" },
        sender,
      },
      { sessionId: "session-1" },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(client.load).toHaveBeenCalledOnce();
    await mocks.ipcHandlers.get(IPC_CHANNELS.mediaPick)!(
      {
        senderFrame: { url: "https://example.com/" },
        sender,
      },
      { sessionId: "session-1", kind: "image" },
    );
    expect(media.pick).toHaveBeenCalledOnce();
    const deniedCapture = await mocks.ipcHandlers.get(IPC_CHANNELS.captureStatus)!({
      senderFrame: { url: "https://example.com/" },
      sender,
    });
    expect(deniedCapture).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(capture.status).toHaveBeenCalledOnce();

    observation.validateManualTurn.mockReturnValueOnce({
      ok: false,
      error: {
        code: "observation_attachment_limit",
        message: "Remove an attachment before including the current view.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    expect(
      await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
        sessionId: "session-1",
        message: "too many",
        attachmentIds: ["a", "b", "c", "d"].map((value) => value.repeat(48)),
        observation: { includeCurrentView: true },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "observation_attachment_limit" },
    });
    expect(observation.preemptAutomaticForManual).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();

    let emitTurn: ((event: any) => void) | undefined;
    client.submit.mockImplementation(async (_input, emit) => {
      emitTurn = emit;
      emit({
        schemaVersion: 1,
        kind: "started",
        requestId: "request-1",
        traceId: "trace-1",
        sessionId: "session-1",
      });
      return { ok: true };
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
      sessionId: "session-1",
      message: "hello",
    });
    expect(observation.preemptAutomaticForManual).toHaveBeenLastCalledWith("session-1", false);
    expect(observation.beginManualTurn).toHaveBeenCalledWith("session-1");
    expect(observation.beginManualTurn.mock.invocationCallOrder[0]).toBeLessThan(
      files.fenceSession.mock.invocationCallOrder[0],
    );
    expect(observation.endManualTurn).not.toHaveBeenCalled();
    expect(files.fenceSession).toHaveBeenCalledWith("session-1", "session_turn_active");
    expect(mainFrame.send).toHaveBeenCalledWith(IPC_CHANNELS.turnEvent, {
      schemaVersion: 1,
      kind: "started",
      requestId: "request-1",
      traceId: "trace-1",
      sessionId: "session-1",
    });
    emitTurn?.({
      schemaVersion: 1,
      kind: "done",
      traceId: "trace-1",
      sessionId: "session-1",
      outcome: "complete",
    });
    expect(observation.endManualTurn).toHaveBeenCalledWith(
      observation.beginManualTurn.mock.results[0].value.token,
    );
    const submittedBeforeBusy = client.submit.mock.calls.length;
    observation.beginManualTurn.mockReturnValueOnce({ admitted: false, token: null });
    expect(
      await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
        sessionId: "session-1",
        message: "second manual turn",
      }),
    ).toMatchObject({ ok: false, error: { code: "session_turn_active" } });
    expect(client.submit).toHaveBeenCalledTimes(submittedBeforeBusy);
    const preparedTurn = {
      token: Symbol("observed"),
      input: {
        sessionId: "session-1",
        message: "with view",
        attachmentIds: ["a".repeat(48), "b".repeat(48)],
      },
    };
    observation.prepareManualTurn.mockResolvedValue({ ok: true, value: preparedTurn });
    observation.settleSubmission.mockImplementation(async (_prepared, result) => result);
    let emitObserved!: (event: TurnEventV1) => void;
    client.submit.mockImplementationOnce(async (_input, emit) => {
      emitObserved = emit;
      emit({
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
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
      sessionId: " session-1 ",
      message: "with view",
      attachmentIds: ["a".repeat(48)],
      observation: { includeCurrentView: true },
    });
    expect(observation.preemptAutomaticForManual).toHaveBeenLastCalledWith("session-1", true);
    expect(observation.prepareManualTurn).toHaveBeenCalledWith({
      sessionId: "session-1",
      message: "with view",
      attachmentIds: ["a".repeat(48)],
      observation: { includeCurrentView: true },
    });
    expect(client.submit).toHaveBeenLastCalledWith(preparedTurn.input, expect.any(Function));
    expect(observation.acceptTurnEvent).toHaveBeenCalledWith(
      preparedTurn,
      expect.objectContaining({ kind: "started", traceId: "trace-2" }),
    );
    expect(observation.settleSubmission).toHaveBeenCalledWith(
      preparedTurn,
      expect.objectContaining({ ok: true }),
    );
    observation.acceptTurnEvent.mockReturnValueOnce(false);
    emitObserved({
      schemaVersion: 1,
      kind: "done",
      traceId: "trace-2",
      sessionId: "session-1",
      outcome: "complete",
    });
    expect(mainFrame.send).toHaveBeenCalledTimes(6);
    const turnOwner = observation.connectTurnOwner.mock.calls[0][0];
    const automaticDelivery = vi.fn(() => false);
    client.submit.mockImplementationOnce(async (_input, emit) => {
      emit({
        schemaVersion: 1,
        kind: "started",
        requestId: "request-3",
        traceId: "trace-3",
        sessionId: "session-1",
      });
      emit({
        schemaVersion: 1,
        kind: "done",
        traceId: "trace-3",
        sessionId: "session-1",
        outcome: "complete",
      });
      return {
        ok: true,
        value: { requestId: "request-3", traceId: "trace-3", sessionId: "session-1" },
      };
    });
    await turnOwner.dispatch(preparedTurn, automaticDelivery);
    expect(automaticDelivery).toHaveBeenCalledOnce();
    expect(automaticDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "started", traceId: "trace-3" }),
    );
    expect(observation.close).toHaveBeenCalledOnce();
    mainFrame.send.mockImplementationOnce(() => {
      throw new Error("renderer send failed");
    });
    client.submit.mockImplementationOnce(async (_input, emit) => {
      emit({
        schemaVersion: 1,
        kind: "started",
        requestId: "request-4",
        traceId: "trace-4",
        sessionId: "session-1",
      });
      emit({
        schemaVersion: 1,
        kind: "done",
        traceId: "trace-4",
        sessionId: "session-1",
        outcome: "complete",
      });
      return {
        ok: true,
        value: { requestId: "request-4", traceId: "trace-4", sessionId: "session-1" },
      };
    });
    await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
      sessionId: "session-1",
      message: "delivery failure",
    });
    expect(mainFrame.send).toHaveBeenCalledTimes(7);
    expect(observation.close).toHaveBeenCalledTimes(2);
    mainFrame.detached = true;
    emitTurn!({
      schemaVersion: 1,
      kind: "done",
      traceId: "trace-1",
      sessionId: "session-1",
      outcome: "complete",
    });
    expect(mainFrame.send).toHaveBeenCalledTimes(7);
    expect(observation.close).toHaveBeenCalledTimes(3);
    emitTurn!({
      schemaVersion: 1,
      kind: "done",
      traceId: "trace-1",
      sessionId: "session-1",
      outcome: "complete",
    });
    expect(mainFrame.send).toHaveBeenCalledTimes(7);
    expect(observation.close).toHaveBeenCalledTimes(3);
    expect(emitCapture!({ schemaVersion: 1, kind: "state", value: { state: "idle" } })).toBe(false);
    expect(mainFrame.send).toHaveBeenCalledTimes(7);
    mainFrame.detached = false;
    mainFrame.send.mockImplementationOnce(() => {
      throw new Error("renderer send failed");
    });
    expect(emitCapture!({ schemaVersion: 1, kind: "state", value: { state: "idle" } })).toBe(false);
    expect(
      await mocks.ipcHandlers.get(IPC_CHANNELS.turnsSubmit)!(event, {
        sessionId: "session-1",
        extra: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(files.fenceSession).toHaveBeenCalledTimes(4);
    expect(client.submit).toHaveBeenCalledTimes(4);
    expect(
      await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsClose)!(event, {
        sessionId: "session-1",
        extra: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(files.fenceSession).toHaveBeenCalledTimes(4);
    expect(client.close).not.toHaveBeenCalled();
    client.close.mockResolvedValue({ ok: true, value: { sessionId: "session-1" } });
    await mocks.ipcHandlers.get(IPC_CHANNELS.sessionsClose)!(event, {
      sessionId: "session-1",
    });
    expect(capture.fenceSession).toHaveBeenCalledWith("session-1", "session_closed");
    expect(observation.fenceSession).toHaveBeenCalledWith("session-1");
    expect(files.fenceSession).toHaveBeenCalledTimes(5);
    const replacementFrame = {
      url: "openminion://app/",
      detached: false,
      send: vi.fn(),
    };
    const stopCalls = observation.stop.mock.calls.length;
    const listenerCalls = observation.setListener.mock.calls.length;
    await mocks.ipcHandlers.get(IPC_CHANNELS.observationStatus)!({
      senderFrame: replacementFrame,
      sender: { mainFrame: replacementFrame },
    });
    expect(observation.stop).toHaveBeenCalledTimes(stopCalls + 1);
    expect(observation.setListener).toHaveBeenCalledTimes(listenerCalls + 1);
    expect(JSON.stringify(mainFrame.send.mock.calls)).not.toMatch(
      /secret|credential|endpoint|v1\//i,
    );
  });

  it("closes local resources before stopping the daemon on application quit", async () => {
    let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const appInstance = {
      on: vi.fn((event: string, handler: typeof beforeQuit) => {
        if (event === "before-quit") {
          beforeQuit = handler;
        }
      }),
      quit: vi.fn(),
    };
    let finishStop: (() => void) | undefined;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const order: string[] = [];
    const supervisor = {
      stop: vi.fn(() => {
        order.push("daemon");
        return stopPending;
      }),
    };
    desktop.registerQuitLifecycle(
      appInstance as never,
      supervisor as never,
      vi.fn(async () => {
        order.push("observation");
      }),
      vi.fn(async () => {
        order.push("files");
      }),
      vi.fn(async () => {
        order.push("capture");
      }),
    );
    const event = { preventDefault: vi.fn() };
    beforeQuit!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(supervisor.stop).toHaveBeenCalledOnce());
    expect(order).toEqual(["observation", "files", "capture", "daemon"]);

    beforeQuit!(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(supervisor.stop).toHaveBeenCalledOnce();
    expect(appInstance.quit).not.toHaveBeenCalled();

    finishStop!();
    await vi.waitFor(() => expect(appInstance.quit).toHaveBeenCalledOnce());
    beforeQuit!(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });

  it("denies permissions, navigation, and new windows", () => {
    let permissionCheck: (() => boolean) | undefined;
    let permissionRequest:
      | ((
          _webContents: unknown,
          _permission: unknown,
          callback: (allowed: boolean) => void,
        ) => void)
      | undefined;
    let displayRequest:
      | ((_request: unknown, callback: (value: unknown) => void) => void)
      | undefined;
    let displayOptions: unknown;
    const appSession = {
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheck = handler;
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequest = handler;
      }),
      setDisplayMediaRequestHandler: vi.fn((handler, options) => {
        displayRequest = handler;
        displayOptions = options;
      }),
    };
    desktop.secureSession(appSession as never);
    expect(permissionCheck?.()).toBe(false);
    const callback = vi.fn();
    permissionRequest?.(null, null, callback);
    expect(callback).toHaveBeenCalledWith(false);
    const displayCallback = vi.fn();
    displayRequest?.({}, displayCallback);
    expect(displayCallback).toHaveBeenCalledWith({});
    expect(displayOptions).toEqual({ useSystemPicker: false });

    const window = {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
      },
    };
    desktop.secureWindow(window as never);
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(window.webContents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
  });

  it("opens only explicit web links from the application frame", async () => {
    const openLink = mocks.ipcHandlers.get(IPC_CHANNELS.openLink)!;
    const frame = { url: "openminion://app/" };
    const event = { senderFrame: frame, sender: { mainFrame: frame } };
    mocks.openExternal.mockClear();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,test",
      "openminion://app/",
      "https://user:secret@example.com/",
      "bad",
      {},
      "x".repeat(8193),
    ])
      expect(await openLink(event, url)).toMatchObject({ ok: false });
    expect(await openLink({ senderFrame: null }, "https://example.com/")).toMatchObject({
      ok: false,
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(await openLink(event, "https://example.com/docs")).toEqual({ ok: true, value: null });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    mocks.openExternal.mockRejectedValueOnce(new Error("browser unavailable"));
    expect(await openLink(event, "https://example.com/")).toMatchObject({
      ok: false,
      error: { code: "open_link_failed" },
    });
  });

  it("admits one exact worker permission and display grant", async () => {
    mocks.permissionStatus = "not-determined";
    mocks.desktopSources = [
      {
        id: "screen:7:0",
        name: "Synthetic display",
        display_id: "7",
        thumbnail: { isEmpty: () => false },
      },
    ];
    mocks.displays = [{ id: 7, scaleFactor: 2 }];
    const platform = new desktop.ElectronCapturePlatform({} as never, "darwin");
    expect(platform.permission()).toBe("not_determined");
    mocks.permissionStatus = "granted";
    expect(platform.permission()).toBe("granted");
    expect(await platform.sources("display", true)).toEqual([
      expect.objectContaining({
        nativeId: "screen:7:0",
        label: "Synthetic display",
        scaleFactor: 2,
        grantSource: { id: "screen:7:0", name: "Synthetic display" },
      }),
    ]);

    const events: unknown[] = [];
    const controller = await platform.createWorker(
      {
        captureId: "a".repeat(48),
        generation: 1,
        nativeSourceId: "screen:7:0",
        grantSource: { id: "screen:7:0", name: "Synthetic display" },
      },
      (event) => events.push(event),
    );
    const worker = mocks.windows.at(-1)!;
    expect(worker.options).toMatchObject({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    expect(worker.loadedUrl).toBe("openminion://app/capture-worker.html");

    const config = {
      schemaVersion: 1 as const,
      kind: "configure" as const,
      captureId: "a".repeat(48),
      generation: 1,
      region: null,
      cadenceMs: 2000 as const,
      maxWidth: 1920 as const,
      maxHeight: 1080 as const,
      jpegQuality: 0.8 as const,
      maxBytes: 2_097_152 as const,
    };
    controller.configure(config);
    expect(worker.webContents.send).toHaveBeenCalledWith(CAPTURE_WORKER_CONFIG_CHANNEL, config);

    expect(
      platform.permissionRequest({} as never, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(false);
    expect(
      platform.permissionRequest(worker.webContents, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/",
      } as never),
    ).toBe(false);
    expect(
      platform.permissionRequest(worker.webContents, "camera", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(false);
    expect(
      platform.permissionRequest(worker.webContents, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(false);
    await expect(controller.startWithGesture()).resolves.toBe(true);
    expect(worker.webContents.executeJavaScript).toHaveBeenCalledWith(
      "window.openminionCaptureWorker.start()",
      true,
    );
    expect(
      platform.permissionRequest(worker.webContents, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(true);
    expect(
      platform.permissionRequest(worker.webContents, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(false);
    expect(
      platform.displayRequest({
        frame: worker.mainFrame,
        securityOrigin: "openminion://app",
        videoRequested: true,
        audioRequested: true,
        userGesture: true,
      } as never),
    ).toEqual({});
    expect(
      platform.displayRequest({
        frame: worker.mainFrame,
        securityOrigin: "https://example.com",
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      } as never),
    ).toEqual({});
    expect(
      platform.displayRequest({
        frame: worker.mainFrame,
        securityOrigin: "openminion://app",
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      } as never),
    ).toEqual({ video: { id: "screen:7:0", name: "Synthetic display" } });
    expect(
      platform.displayRequest({
        frame: worker.mainFrame,
        securityOrigin: "openminion://app",
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      } as never),
    ).toEqual({});

    const privateListener = mocks.ipcListeners.get(CAPTURE_WORKER_EVENT_CHANNEL)!;
    privateListener(
      { sender: worker.webContents, senderFrame: worker.mainFrame },
      {
        schemaVersion: 1,
        kind: "stream_ready",
        captureId: "a".repeat(48),
        generation: 1,
        sourceWidth: 1920,
        sourceHeight: 1080,
      },
    );
    expect(events).toHaveLength(1);
    expect(
      platform.permissionRequest(worker.webContents, "display-capture", {
        isMainFrame: true,
        requestingUrl: "openminion://app/capture-worker.html",
      } as never),
    ).toBe(false);

    await controller.stop();
    expect(worker.destroyed).toBe(true);
    expect(mocks.ipcListeners.has(CAPTURE_WORKER_EVENT_CHANNEL)).toBe(false);
  });

  it("rejects private worker events from any other frame and overwrites bytes", async () => {
    const platform = new desktop.ElectronCapturePlatform({} as never, "darwin");
    const controller = await platform.createWorker(
      {
        captureId: "b".repeat(48),
        generation: 2,
        nativeSourceId: "window:1:0",
        grantSource: { id: "window:1:0", name: "Synthetic window" },
      },
      vi.fn(),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.ipcListeners.get(CAPTURE_WORKER_EVENT_CHANNEL)!(
      {
        sender: {},
        senderFrame: { url: "openminion://app/capture-worker.html" },
      },
      { bytes },
    );
    expect([...bytes]).toEqual([0, 0, 0]);
    await controller.stop();
  });

  it("keeps load and configure bounded separately from the armed media grant", async () => {
    vi.useFakeTimers();
    try {
      const platform = new desktop.ElectronCapturePlatform({} as never, "darwin");
      const controller = await platform.createWorker(
        {
          captureId: "d".repeat(48),
          generation: 3,
          nativeSourceId: "window:2:0",
          grantSource: { id: "window:2:0", name: "Delayed synthetic window" },
        },
        vi.fn(),
      );
      const worker = mocks.windows.at(-1)!;
      await vi.advanceTimersByTimeAsync(6_999);
      await expect(controller.startWithGesture()).resolves.toBe(true);
      expect(
        platform.displayRequest({
          frame: worker.mainFrame,
          securityOrigin: "openminion://app",
          videoRequested: true,
          audioRequested: false,
          userGesture: true,
        } as never),
      ).toEqual({
        video: { id: "window:2:0", name: "Delayed synthetic window" },
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(
        platform.permissionRequest(worker.webContents, "display-capture", {
          isMainFrame: true,
          requestingUrl: "openminion://app/capture-worker.html",
        } as never),
      ).toBe(true);
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes lock suspend display and renderer loss through the capture owner", async () => {
    mocks.powerListeners.clear();
    mocks.screenListeners.clear();
    mocks.appSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      protocol: { handle: vi.fn() },
    };
    const supervisor = {
      start: vi.fn().mockResolvedValue({ state: "ready" }),
      startUpdateChecks: vi.fn(),
      client: {},
    };
    const window = (await desktop.launchDesktop(supervisor as never)) as any;
    expect(mocks.powerListeners.has("lock-screen")).toBe(true);
    expect(mocks.powerListeners.has("suspend")).toBe(true);
    expect(mocks.screenListeners.has("display-removed")).toBe(true);
    expect(mocks.screenListeners.has("display-metrics-changed")).toBe(true);
    const invocation = {
      senderFrame: window.mainFrame,
      sender: { mainFrame: window.mainFrame },
    };
    const status = () => mocks.ipcHandlers.get(IPC_CHANNELS.captureStatus)!(invocation);

    mocks.powerListeners.get("lock-screen")!();
    await vi.waitFor(async () => {
      expect(await status()).toMatchObject({ ok: true, value: { reason: "screen_locked" } });
    });
    mocks.powerListeners.get("suspend")!();
    await vi.waitFor(async () => {
      expect(await status()).toMatchObject({ ok: true, value: { reason: "system_suspended" } });
    });
    mocks.screenListeners.get("display-removed")!();
    await vi.waitFor(async () => {
      expect(await status()).toMatchObject({ ok: true, value: { reason: "display_changed" } });
    });

    window.webEvents.get("render-process-gone")!();
    await vi.waitFor(async () => {
      expect(await status()).toMatchObject({ ok: true, value: { reason: "renderer_lost" } });
    });
    window.events.get("closed")!();
    expect(mocks.powerListeners.size).toBe(0);
    expect(mocks.screenListeners.size).toBe(0);
  });

  it("runs the deterministic region lifecycle through main preload and renderer", async () => {
    mocks.rendererEvents = [];
    mocks.rendererListeners.clear();
    mocks.decodedSize = { width: 480, height: 270 };
    const jpeg = new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
    const configs: Array<Record<string, unknown>> = [];
    let nextWorkerId = 0;
    const createdWorkers = new Set<number>();
    const activeWorkers = new Set<number>();
    const stoppedWorkers = new Set<number>();
    let maximumWorkers = 0;
    const thumbnail = {
      isEmpty: () => false,
      getSize: () => ({ width: 480, height: 270 }),
      resize: () => thumbnail,
      toJPEG: () => Buffer.from(jpeg),
    };
    const source = {
      nativeId: "synthetic:display:1",
      label: "Synthetic display",
      thumbnail: thumbnail as never,
      scaleFactor: 2,
      grantSource: { id: "synthetic:display:1", name: "Synthetic display" },
    };
    const platform: CapturePlatform = {
      platform: "darwin",
      permission: () => "granted",
      sources: async (_kind, includeThumbnail) => {
        if (includeThumbnail) mocks.decodedSize = { width: 480, height: 270 };
        return [source];
      },
      createWorker: async (input, emit) => {
        const workerId = ++nextWorkerId;
        createdWorkers.add(workerId);
        activeWorkers.add(workerId);
        maximumWorkers = Math.max(maximumWorkers, activeWorkers.size);
        queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
        return {
          configure(config) {
            configs.push(config as unknown as Record<string, unknown>);
            queueMicrotask(() =>
              emit({
                schemaVersion: 1,
                kind: "configured",
                captureId: input.captureId,
                generation: input.generation,
              }),
            );
          },
          async startWithGesture() {
            mocks.decodedSize = { width: 800, height: 600 };
            queueMicrotask(() => {
              emit({
                schemaVersion: 1,
                kind: "stream_ready",
                captureId: input.captureId,
                generation: input.generation,
                sourceWidth: 1600,
                sourceHeight: 1200,
              });
              queueMicrotask(() =>
                emit({
                  schemaVersion: 1,
                  kind: "frame",
                  captureId: input.captureId,
                  generation: input.generation,
                  sourceWidth: 1600,
                  sourceHeight: 1200,
                  width: 800,
                  height: 600,
                  bytes: new Uint8Array(jpeg),
                }),
              );
            });
            return true;
          },
          async waitForAdmission() {},
          async stop() {
            if (!activeWorkers.has(workerId) || stoppedWorkers.has(workerId)) {
              throw new Error(`synthetic worker ${workerId} stopped more than once`);
            }
            activeWorkers.delete(workerId);
            stoppedWorkers.add(workerId);
          },
        };
      },
    };
    const capture = new CaptureService(platform, {
      now: () => Date.parse("2026-08-21T12:00:00Z"),
    });
    const sessionValue = captureSessionSummary();
    const submit = vi.fn();
    const client = {
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { sessions: [sessionValue], nextCursor: null, hasMore: false },
      }),
      create: vi.fn(),
      load: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          session: sessionValue,
          messages: [],
          nextMessageCursor: "message-zero",
          messagesHasMore: false,
        },
      }),
      close: vi.fn(),
      events: vi.fn().mockResolvedValue({
        ok: true,
        value: { events: [], nextCursor: "event-zero", hasMore: false },
      }),
      cancel: vi.fn(),
      decide: vi.fn(),
      listArtifacts: vi.fn().mockResolvedValue({
        ok: true,
        value: { artifacts: [], nextCursor: null, complete: true },
      }),
      readArtifact: vi.fn(),
      detachArtifact: vi.fn(),
      restoreArtifact: vi.fn(),
      validateSessionClose: vi.fn(),
      validateTurnSubmission: vi.fn(),
      submit,
    };
    const supervisor = {
      status: vi.fn().mockResolvedValue({
        state: "ready",
        reachable: true,
        daemonVersion: "test",
        protocol: 1,
        configId: null,
        capabilities: [],
        errorCode: null,
      }),
      retry: vi.fn(),
      runtimeStatus: vi.fn().mockReturnValue({
        source: "pypi",
        selectedSource: "pypi",
        installedVersion: "0.0.19",
        availableVersion: null,
        phase: "unchecked",
      }),
      client,
    };
    const media = { pick: vi.fn(), release: vi.fn() };
    const files = {
      pick: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
      release: vi.fn(),
      activateSession: vi.fn(),
      fenceSession: vi.fn(),
    };
    desktop.registerIpcHandlers(supervisor as never, media as never, files as never, capture);
    const pagehide: Array<() => void> = [];
    let pageDisposed = false;
    const disposePage = () => {
      if (pageDisposed) return;
      pageDisposed = true;
      pagehide[0]?.();
    };
    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        if (type === "pagehide") pagehide.push(listener);
      },
    });
    try {
      const page = new CaptureFixtureDocument();
      await mount(mocks.exposedApi!, page.asDocument());
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(page.captureButtons()).toHaveLength(1));
      page.captureButtons()[0]!.click();
      setCaptureRegion(page);
      page.element("start-capture").click();
      await vi.waitFor(() =>
        expect(page.element("capture-preview").src).toContain("openminion://app/capture/frames/"),
      );
      expect(configs[0]).toMatchObject({
        region: { xBps: 2500, yBps: 2500, widthBps: 5000, heightBps: 5000 },
        cadenceMs: 2000,
      });
      const frame = mocks.rendererEvents.find((event: any) => event.kind === "frame") as any;
      expect(frame).toMatchObject({
        sessionId: sessionValue.sessionId,
        sourceKind: "region",
        parentSourceKind: "display",
        width: 800,
        height: 600,
        contentHash: createHash("sha256").update(jpeg).digest("hex"),
        sizeBytes: jpeg.byteLength,
      });
      expect([...capture.preview("frames", frame.frameId)!.bytes]).toEqual([...jpeg]);

      page.element("pause-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Paused"));
      expect(page.element("capture-preview").src).toBe("");
      expect(page.element("capture-facts").textContent).toContain("0 B retained");
      page.element("resume-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Observing"));
      page.element("change-capture").click();
      await vi.waitFor(() =>
        expect(page.element("capture-status").textContent).toContain("Choose a source"),
      );
      expect(page.captureButtons()).toHaveLength(1);
      expect(page.element("capture-preview").src).toBe("");
      page.captureButtons()[0]!.click();
      setCaptureRegion(page);
      page.element("start-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Observing"));
      page.element("stop-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Idle"));
      page.element("observe-computer").click();
      await vi.waitFor(() =>
        expect(page.element("capture-status").textContent).toContain("Choose a source"),
      );
      page.captureButtons()[0]!.click();
      setCaptureRegion(page);
      page.element("start-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Observing"));
      disposePage();
      await vi.waitFor(() =>
        expect(capture.status()).toMatchObject({
          ok: true,
          value: { state: "idle", captureId: null, retainedBytes: 0 },
        }),
      );

      expect(maximumWorkers).toBe(1);
      expect(activeWorkers).toEqual(new Set());
      expect(stoppedWorkers).toEqual(createdWorkers);
      expect(createdWorkers.size).toBe(4);
      expect(submit).not.toHaveBeenCalled();
      expect(media.pick).not.toHaveBeenCalled();
      expect(JSON.stringify(page.captureText())).not.toMatch(
        /synthetic:display|contentHash|bytes|token|endpoint|MediaStream|ipcRenderer/,
      );
    } finally {
      try {
        disposePage();
      } finally {
        vi.unstubAllGlobals();
        await capture.close();
      }
    }
  });

  it("creates a sandboxed local-only window and starts the daemon client", async () => {
    const supervisor = {
      start: vi.fn().mockResolvedValue({ state: "ready" }),
      startUpdateChecks: vi.fn(),
    };
    const created = await desktop.createWindow(supervisor as never, {} as never);
    const recorded = mocks.windows.at(-1)!;
    const webPreferences = recorded.options.webPreferences as Record<string, unknown>;
    expect(created).toBe(recorded);
    expect(recorded.loadedUrl).toBe("openminion://app/");
    expect(recorded.options.icon).toMatch(/renderer[\\/]logo\.png$/);
    expect(webPreferences.preload).toMatch(/preload[\\/]index\.cjs$/);
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(JSON.stringify(recorded.options)).not.toMatch(/token|127\.0\.0\.1|v1\//i);
    expect(supervisor.start).toHaveBeenCalledOnce();
  });
});

class CaptureFixtureElement {
  removeAttribute = vi.fn();
  scrollIntoView = vi.fn();
  showPopover = vi.fn();
  hidePopover = vi.fn();
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  src = "";
  alt = "";
  title = "";
  type = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  children: CaptureFixtureElement[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly tagName: string) {}

  append(...children: CaptureFixtureElement[]) {
    this.children.push(...children);
  }
  get lastElementChild(): CaptureFixtureElement | null {
    return this.children.at(-1) ?? null;
  }
  replaceChild(next: CaptureFixtureElement, previous: CaptureFixtureElement): void {
    this.children.splice(this.children.indexOf(previous), 1, next);
  }
  removeChild(child: CaptureFixtureElement): void {
    this.children.splice(this.children.indexOf(child), 1);
  }
  replaceChildren(...children: CaptureFixtureElement[]) {
    this.children = children;
  }
  setAttribute(_name: string, _value: string) {}
  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) listener({ preventDefault() {} });
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
  }
  descendants(): CaptureFixtureElement[] {
    return [this, ...this.children.flatMap((child) => child.descendants())];
  }
}

class CaptureFixtureDocument {
  addEventListener = vi.fn();
  private static readonly ids = [
    "settings-runtime-button",
    "chat-display",
    "chat-display-status",
    "status-dot",
    "status-summary",
    "retry",
    "show-connection",
    "diagnostics-dialog",
    "diagnostics-title",
    "diagnostics-result",
    "close-diagnostics",
    "show-daemon-status",
    "show-daemon-logs",
    "runtime-update-status",
    "runtime-update-source",
    "check-runtime-update",
    "stage-runtime-update",
    "pause-runtime-update",
    "discard-runtime-update",
    "pin-installed-runtime",
    "unpin-runtime",
    "runtime-pin-version",
    "pin-runtime-version",
    "connection-details",
    "recovery",
    "readiness-title",
    "readiness-summary",
    "readiness-actions",
    "readiness-retry",
    "readiness-settings",
    "daemon-version",
    "protocol-version",
    "shell-version",
    "connection-label",
    "session-list",
    "session-search",
    "clear-session-search",
    "session-search-count",
    "new-session",
    "close-session",
    "current-title",
    "rename-session",
    "rename-dialog",
    "rename-form",
    "task-name",
    "rename-session-id",
    "rename-error",
    "rename-cancel",
    "rename-reset",
    "timeline",
    "conversation",
    "chat-progress",
    "jump-latest",
    "chat-status",
    "chat-detail",
    "chat-update",
    "chat-elapsed",
    "composer-hint",
    "composer-form",
    "composer",
    "show-commands",
    "command-menu",
    "command-panel",
    "close-command",
    "command-title",
    "command-result",
    "context-panel",
    "screen-panel",
    "send",
    "cancel",
    "ask-guidance",
    "watch-settings",
    "guidance-card",
    "guidance-state",
    "guidance-preview",
    "guidance-facts",
    "guidance-text",
    "guidance-status",
    "attachments",
    "include-current-view",
    "include-screenshot-control",
    "screen-context-summary",
    "screen-context-name",
    "screen-context-status",
    "screen-context-preview",
    "attach-image",
    "attach-file",
    "refresh-artifacts",
    "artifact-status",
    "artifact-list",
    "artifact-detail",
    "artifact-detail-title",
    "artifact-content",
    "close-artifact",
    "choose-file",
    "file-status",
    "file-grant-list",
    "capture-state",
    "capture-status",
    "capture-source-kind",
    "capture-entire-screen",
    "capture-window",
    "observe-computer",
    "capture-candidates",
    "capture-region-controls",
    "capture-region-enabled",
    "capture-region-x",
    "capture-region-y",
    "capture-region-width",
    "capture-region-height",
    "capture-region-stage",
    "capture-region-image",
    "capture-region-overlay",
    "start-capture",
    "capture-live",
    "capture-preview",
    "capture-facts",
    "pause-capture",
    "resume-capture",
    "change-capture",
    "stop-capture",
    "observation-state",
    "observation-instruction",
    "observation-trigger",
    "start-observation",
    "stop-observation",
    "observation-status",
    "observation-selected",
    "observation-selected-preview",
    "observation-selected-facts",
    "observation-sent",
    "observation-sent-preview",
    "observation-sent-facts",
    "observation-counters",
    "observation-usage",
  ];
  private readonly elements = new Map(
    CaptureFixtureDocument.ids.map((id) => [id, new CaptureFixtureElement("div")]),
  );

  constructor() {
    this.element("capture-source-kind").value = "display";
    this.element("capture-region-x").value = "0";
    this.element("capture-region-y").value = "0";
    this.element("capture-region-width").value = "100";
    this.element("capture-region-height").value = "100";
    this.element("observation-trigger").value = "changes";
  }

  getElementById(id: string) {
    return this.elements.get(id) ?? null;
  }
  createElement(tagName: string) {
    return new CaptureFixtureElement(tagName);
  }
  asDocument() {
    return this as unknown as Document;
  }
  element(id: string) {
    return this.elements.get(id)!;
  }
  captureButtons() {
    return this.element("capture-candidates")
      .descendants()
      .filter((element) => element.tagName === "button");
  }
  captureText() {
    return ["capture-state", "capture-status", "capture-candidates", "capture-facts"]
      .flatMap((id) => this.element(id).descendants())
      .map((element) => element.textContent)
      .filter(Boolean);
  }
}

function setCaptureRegion(page: CaptureFixtureDocument): void {
  page.element("capture-region-enabled").checked = true;
  page.element("capture-region-x").value = "25";
  page.element("capture-region-y").value = "25";
  page.element("capture-region-width").value = "50";
  page.element("capture-region-height").value = "50";
  page.element("capture-region-x").dispatch("input");
}

function captureSessionSummary() {
  return {
    schemaVersion: 1 as const,
    sessionId: "capture-session",
    title: "Capture fixture",
    status: "active" as const,
    createdAt: "2026-08-21T12:00:00Z",
    updatedAt: "2026-08-21T12:00:00Z",
    activeAgentId: "openminion",
    model: { provider: null, modelId: null },
    projectId: null,
    eventCursor: "event-zero",
  };
}

function observationState() {
  return {
    schemaVersion: 1 as const,
    sessionId: "session-1",
    watchEnabled: false,
    trigger: null,
    state: "ready" as const,
    currentReason: null,
    selectedFrame: null,
    sentFrame: null,
    counters: {
      schemaVersion: 1 as const,
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
      schemaVersion: 1 as const,
      windowMs: 60_000 as const,
      capturedFrames: 0,
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
      costSource: "unavailable" as const,
    },
    lastError: null,
    updatedAt: "2026-08-22T00:00:00Z",
  };
}
