import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../../src/main/backend-supervisor.js";
import { CaptureService, type CapturePlatform } from "../../src/main/capture.js";
import { FileGrantService } from "../../src/main/files.js";
import { MediaService } from "../../src/main/media.js";
import { ObservationService } from "../../src/main/observation.js";
import { OpenMinionClient } from "../../src/main/openminion-client.js";
import { validateReadiness } from "../../src/main/security.js";
import { mount, recoverSession } from "../../src/renderer/app.js";
import {
  CAPTURE_WORKER_CONFIG_CHANNEL,
  CAPTURE_WORKER_EVENT_CHANNEL,
} from "../../src/shared/capture-worker.js";
import {
  IPC_CHANNELS,
  type DaemonStatus,
  type MessageV1,
  type NativeApi,
  type SessionEventV1,
  type TurnEventV1,
} from "../../src/shared/contracts.js";

const execFileAsync = promisify(execFile);
const integrationExecutable = process.env.OPENMINION_ODF_EXECUTABLE;

const mocks = vi.hoisted(() => ({
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
      IPC_CHANNELS.tasksControl,
      IPC_CHANNELS.reportsRead,
      IPC_CHANNELS.sessionsExport,
      IPC_CHANNELS.copyText,
      IPC_CHANNELS.profilesRead,
      IPC_CHANNELS.profilesPresets,
      IPC_CHANNELS.profilesSetup,
      IPC_CHANNELS.profilesSave,
      IPC_CHANNELS.profilesImport,
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
    await mocks.ipcHandlers.get(IPC_CHANNELS.tasksControl)!(event, {
      sessionId: "session-1",
      action: "list",
    });
    expect(client.controlTasks).toHaveBeenCalledWith({ sessionId: "session-1", action: "list" });
    for (const channel of [
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

  it("revokes the client lease before application quit", async () => {
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
    };
    const created = await desktop.createWindow(supervisor as never, {} as never);
    const recorded = mocks.windows.at(-1)!;
    const webPreferences = recorded.options.webPreferences as Record<string, unknown>;
    expect(created).toBe(recorded);
    expect(recorded.loadedUrl).toBe("openminion://app/");
    expect(recorded.options.icon).toMatch(/renderer\/logo\.png$/);
    expect(webPreferences.preload).toMatch(/preload\/index\.cjs$/);
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(JSON.stringify(recorded.options)).not.toMatch(/token|127\.0\.0\.1|v1\//i);
    expect(supervisor.start).toHaveBeenCalledOnce();
  });
});

it("selects uploads submits and releases media through fixed boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "openminion-odm-main-"));
  try {
    const imagePath = join(root, "pixel.png");
    const imageBytes = Buffer.from("PNG!");
    const mediaIds = ["a".repeat(48), "b".repeat(48), "c".repeat(48)];
    const uploads: Array<{ body: string; name: string; token: string }> = [];
    const submissions: Array<Record<string, unknown>> = [];
    const releases: string[] = [];
    let uploadIndex = 0;
    const server = createHttpServer((request, response) => {
      void (async () => {
        const body = await readHttpBody(request);
        if (request.method === "POST" && request.url === "/v1/client/sessions") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, session: fixtureSession(), meta: {} }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/client/sessions/session-1/media") {
          const mediaId = mediaIds[uploadIndex++];
          uploads.push({
            body,
            name: String(request.headers["x-openminion-media-name"] ?? ""),
            token: String(request.headers["x-openminion-client-token"] ?? ""),
          });
          response.statusCode = 201;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              media: {
                schema_version: 1,
                media_id: mediaId,
                session_id: "session-1",
                name: "pixel.png",
                mime_type: "image/png",
                size_bytes: imageBytes.length,
                kind: "image",
                turn_compatible: true,
                expires_at: "2999-01-01T00:00:00Z",
              },
              meta: {},
            }),
          );
          return;
        }
        if (request.method === "POST" && request.url === "/v1/turn/stream") {
          const turn = JSON.parse(body) as Record<string, unknown>;
          submissions.push(turn);
          if (submissions.length === 1) {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify({
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "Correct the message and retry.",
                  retryable: false,
                  retry_after_ms: null,
                },
                meta: {},
              }),
            );
            return;
          }
          if (submissions.length === 3) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end("{}");
            return;
          }
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          writeFixtureEvent(response, "meta", {
            request_id: request.headers["x-request-id"],
            trace_id: turn.trace_id,
            session_id: turn.session_id,
          });
          writeFixtureEvent(response, "response", {
            trace_id: turn.trace_id,
            final_text: "fixture complete",
            errors: [],
          });
          writeFixtureEvent(response, "done", { status: "complete" });
          response.end();
          return;
        }
        const releaseMatch = request.url?.match(
          /^\/v1\/client\/sessions\/session-1\/media\/([0-9a-f]{48})$/,
        );
        if (request.method === "DELETE" && releaseMatch) {
          releases.push(releaseMatch[1]);
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              released: true,
              media_id: releaseMatch[1],
              meta: {},
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
      })();
    });
    try {
      await writeFile(imagePath, imageBytes);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("media fixture server did not bind");
      }
      const readiness = {
        schema_version: 1 as const,
        event: "desktop.client.ready" as const,
        host: "127.0.0.1" as const,
        port: address.port,
        protocol_min: 1 as const,
        protocol_max: 1 as const,
        daemon_version: "0.0.9",
        config_id: "a".repeat(64),
        client_id: "client-1",
        client_token: `synthetic-${"x".repeat(43)}`,
        expires_at: "2999-01-01T00:00:00Z",
      };
      const client = new OpenMinionClient(() => readiness);
      const pickDialog = vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [imagePath],
      });
      desktop.registerIpcHandlers({ client } as never, new MediaService(client, pickDialog));
      const api = mocks.exposedApi;
      if (!api) {
        throw new Error("preload API was not exposed");
      }
      expect(await api.sessions.create({ title: "Media fixture" })).toMatchObject({
        ok: true,
      });

      const firstPick = await api.media.pick({ sessionId: "session-1", kind: "image" });
      if (!firstPick.ok) {
        throw new Error(firstPick.error.code);
      }
      const retainedId = firstPick.value.attachments[0].mediaId;
      expect(
        await api.turns.submit({
          sessionId: "session-1",
          message: "explicit failure",
          attachmentIds: [retainedId],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      const turnEvents: TurnEventV1[] = [];
      const unsubscribe = api.turns.subscribe((event) => turnEvents.push(event));
      expect(
        await api.turns.submit({
          sessionId: "session-1",
          message: "retry once",
          attachmentIds: [retainedId],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(turnEvents.at(-1)).toMatchObject({ kind: "done" }));
      expect(
        await api.media.release({
          sessionId: "session-1",
          mediaId: retainedId,
        }),
      ).toMatchObject({ ok: true, value: { released: true } });

      const pagehidePick = await api.media.pick({ sessionId: "session-1", kind: "image" });
      if (!pagehidePick.ok) {
        throw new Error(pagehidePick.error.code);
      }
      const pagehideId = pagehidePick.value.attachments[0].mediaId;
      expect(
        await api.media.release({
          sessionId: "session-1",
          mediaId: pagehideId,
        }),
      ).toMatchObject({ ok: true, value: { released: true } });

      const ambiguousPick = await api.media.pick({ sessionId: "session-1", kind: "image" });
      if (!ambiguousPick.ok) {
        throw new Error(ambiguousPick.error.code);
      }
      const ambiguousId = ambiguousPick.value.attachments[0].mediaId;
      const ambiguous = await api.turns.submit({
        sessionId: "session-1",
        message: "ambiguous once",
        attachmentIds: [ambiguousId],
      });
      expect(ambiguous).toMatchObject({
        ok: false,
        error: { code: "submission_ambiguous", retryable: false },
      });
      expect(
        await api.media.release({
          sessionId: "session-1",
          mediaId: ambiguousId,
        }),
      ).toMatchObject({ ok: true, value: { released: true } });
      expect(submissions).toHaveLength(3);
      expect(submissions.map((turn) => turn.attachments)).toEqual([
        [retainedId],
        [retainedId],
        [ambiguousId],
      ]);
      expect(releases).toEqual([retainedId, pagehideId, ambiguousId]);
      expect(uploads).toHaveLength(3);
      expect(uploads.every((upload) => upload.body === imageBytes.toString())).toBe(true);
      expect(uploads.every((upload) => upload.name === "pixel.png")).toBe(true);
      expect(uploads.every((upload) => upload.token === readiness.client_token)).toBe(true);
      const visible = JSON.stringify([
        firstPick,
        turnEvents,
        pagehidePick,
        ambiguousPick,
        ambiguous,
      ]);
      expect(visible).not.toContain(root);
      expect(visible).not.toContain(readiness.client_token);
      expect(visible).not.toMatch(/artifact:\/\/|\/v1\/|127\.0\.0\.1|sha256|digest/i);
      unsubscribe();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("runs approval lifecycle through main and preload after renderer reload", async () => {
  const decisions: Array<{ path: string; body: Record<string, unknown> }> = [];
  let streamDecision: "allow_once" | "deny" | null = null;
  let releaseStream: (() => void) | null = null;
  const decisionGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let submitCount = 0;
  const server = createHttpServer((request, response) => {
    void (async () => {
      const body = await readHttpBody(request);
      const session = fixtureSession();
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, session, meta: {} }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/stream") {
        submitCount += 1;
        const turn = JSON.parse(body) as Record<string, string>;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        writeFixtureEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: turn.trace_id,
          session_id: turn.session_id,
        });
        writeFixtureEvent(response, "chunk", {
          trace_id: turn.trace_id,
          kind: "approval_required",
          data: {
            approval_id: "approval-live",
            call_id: "call-live",
            tool_name: "workspace.write",
            argument_keys: ["path", "text"],
            requested_at: "2026-08-20T00:00:00Z",
            expires_at: "2026-08-20T00:01:00Z",
          },
          ts: "2026-08-20T00:00:00Z",
        });
        await decisionGate;
        writeFixtureEvent(response, "chunk", {
          trace_id: turn.trace_id,
          kind: "approval_resolved",
          data: {
            approval_id: "approval-live",
            call_id: "call-live",
            tool_name: "workspace.write",
            decision: streamDecision,
            outcome: streamDecision === "allow_once" ? "applied" : "denied",
            resolved_at: "2026-08-20T00:00:01Z",
          },
          ts: "2026-08-20T00:00:01Z",
        });
        writeFixtureEvent(response, "response", {
          trace_id: turn.trace_id,
          final_text: "fixture complete",
          errors: [],
        });
        writeFixtureEvent(response, "done", { status: "complete" });
        response.end();
        return;
      }
      if (request.method === "POST" && request.url?.includes("/approvals/")) {
        const parsed = JSON.parse(body) as { decision: "allow_once" | "deny" };
        decisions.push({ path: request.url, body: parsed });
        if (request.url.endsWith("/approval-live")) {
          streamDecision = parsed.decision;
          releaseStream?.();
        }
        const approvalId = request.url.split("/").at(-1)!;
        const traceId = request.url.split("/")[6];
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            approval: {
              schema_version: 1,
              approval_id: approvalId,
              session_id: "session-1",
              trace_id: traceId,
              call_id: approvalId === "approval-live" ? "call-live" : "call-deny",
              decision: parsed.decision,
              outcome: parsed.decision === "allow_once" ? "applied" : "denied",
              resolved_at: "2026-08-20T00:00:01Z",
            },
            meta: {},
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/v1/client/sessions/session-1?message_limit=200"
      ) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            session,
            messages: [],
            next_message_cursor: "message-zero",
            messages_has_more: false,
            meta: {},
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/v1/client/sessions/session-1/events?after=event-zero&limit=200"
      ) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            events: fixtureApprovalEvents(),
            next_cursor: "event-two",
            has_more: false,
            meta: {},
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: "not_found", message: "missing", retryable: false },
        }),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }
  const readiness = {
    schema_version: 1 as const,
    event: "desktop.client.ready" as const,
    host: "127.0.0.1" as const,
    port: address.port,
    protocol_min: 1 as const,
    protocol_max: 1 as const,
    daemon_version: "0.0.9",
    config_id: "a".repeat(64),
    client_id: "client-1",
    client_token: `synthetic-${"x".repeat(43)}`,
    expires_at: "2999-01-01T00:00:00Z",
  };
  try {
    const client = new OpenMinionClient(() => readiness);
    desktop.registerIpcHandlers({ client } as never);
    mocks.rendererListeners.clear();
    const api = mocks.exposedApi as NativeApi | null;
    if (!api) {
      throw new Error("preload API was not exposed");
    }
    expect(await api.sessions.create({ title: "Approval fixture" })).toMatchObject({ ok: true });
    const live: TurnEventV1[] = [];
    const unsubscribe = api.turns.subscribe((event) => live.push(event));
    const submitted = await api.turns.submit({ sessionId: "session-1", message: "approve" });
    if (!submitted.ok) {
      throw new Error(submitted.error.code);
    }
    await vi.waitFor(() => expect(live.some((event) => event.kind === "approval")).toBe(true));
    expect(
      await api.approvals.decide({
        sessionId: "session-1",
        traceId: submitted.value.traceId,
        approvalId: "approval-live",
        decision: "allow_once",
      }),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    await vi.waitFor(() => expect(live.at(-1)).toMatchObject({ kind: "done" }));
    expect(
      live.find(
        (event) =>
          event.kind === "approval" &&
          event.phase === "resolved" &&
          event.approvalId === "approval-live",
      ),
    ).toMatchObject({
      kind: "approval",
      phase: "resolved",
      sessionId: "session-1",
      traceId: submitted.value.traceId,
      approvalId: "approval-live",
      callId: "call-live",
      decision: "allow_once",
      outcome: "applied",
    });
    expect(
      await api.approvals.decide({
        sessionId: "session-1",
        traceId: "trace-deny",
        approvalId: "approval-deny",
        decision: "deny",
      }),
    ).toMatchObject({ ok: true, value: { outcome: "denied" } });

    const beforeReload = { submits: submitCount, decisions: decisions.length };
    const rendererWindow = await desktop.createWindow(
      { start: vi.fn().mockResolvedValue({ state: "ready" }) } as never,
      {} as never,
    );
    const reloadRecovery = new Promise<Awaited<ReturnType<typeof recoverSession>>>(
      (resolve, reject) => {
        const reload = rendererWindow.webContents.reload as ReturnType<typeof vi.fn>;
        reload.mockImplementationOnce(() => {
          void recoverSession(api, "session-1").then(resolve, reject);
        });
      },
    );
    rendererWindow.webContents.reload();
    const reloaded = await reloadRecovery;
    if ("code" in reloaded) {
      throw new Error(reloaded.code);
    }
    expect(reloaded.events.map((event) => event.facts.approval_id)).toEqual([
      "approval-live",
      "approval-live",
    ]);
    expect(rendererWindow.webContents.reload).toHaveBeenCalledOnce();
    expect({ submits: submitCount, decisions: decisions.length }).toEqual(beforeReload);
    expect(decisions).toHaveLength(2);
    expect(
      decisions.every(
        (decision) => !/token|endpoint|argument.*value|secret/i.test(JSON.stringify(decision)),
      ),
    ).toBe(true);
    expect(JSON.stringify([live, reloaded])).not.toMatch(
      /synthetic-|127\.0\.0\.1|\/v1\/|secret|\/private/i,
    );
    unsubscribe();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.skipIf(!integrationExecutable)(
  "runs the authenticated OpenMinion daemon lifecycle",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openminion-odf-"));
    const executable = integrationExecutable!;
    let commandRoots: string[] | null = null;
    try {
      const homeRoot = join(root, "home");
      const dataRoot = join(root, "data");
      const configPath = join(root, "config.json");
      const mismatchRoot = join(root, "mismatch");
      const mismatchConfig = join(mismatchRoot, "config.json");
      const ipcToken = `odf-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const port = await availablePort();
      commandRoots = [
        "--home-root",
        homeRoot,
        "--data-root",
        dataRoot,
        "--config",
        configPath,
        "--no-interactive",
      ];
      await mkdir(homeRoot, { recursive: true });
      await mkdir(dataRoot, { recursive: true });
      await writeConfig(configPath, dataRoot, port, ipcToken);
      const supervisor = new DaemonSupervisor({
        openminionExecutable: executable,
        configPath,
        homeRoot,
        dataRoot,
      });
      const started = await supervisor.start();
      expect(started.state, JSON.stringify(started)).toBe("ready");
      expect(started).toMatchObject({ reachable: true, protocol: 1 });
      expect(JSON.stringify(started)).not.toContain(ipcToken);
      expect(JSON.stringify(started)).not.toContain(root);

      await proveRealLeaseExpiry(port, ipcToken);

      desktop.registerIpcHandlers(supervisor);
      const attemptsBeforeReload = supervisor.startAttempts;
      const rendererWindow = await desktop.createWindow(supervisor, {} as never);
      rendererWindow.webContents.reload();
      const reloaded = (await mocks.ipcHandlers.get(IPC_CHANNELS.daemonStatus)!()) as DaemonStatus;
      expect(reloaded).toMatchObject({ state: "ready", configId: started.configId });
      expect(rendererWindow.webContents.reload).toHaveBeenCalledOnce();
      expect(supervisor.startAttempts).toBe(attemptsBeforeReload);
      expect(reloaded.capabilities).toContain("turns.submit");
      expect(() =>
        validateReadiness({
          schema_version: 1,
          event: "desktop.client.ready",
          host: "127.0.0.1",
          port,
          protocol_min: 1,
          protocol_max: 1,
          daemon_version: reloaded.daemonVersion,
          config_id: reloaded.configId,
          client_id: "expired-client",
          client_token: "x".repeat(43),
          expires_at: "2000-01-01T00:00:00Z",
        }),
      ).toThrow(/expired/);

      const attached = new DaemonSupervisor({
        openminionExecutable: executable,
        configPath,
        homeRoot,
        dataRoot,
      });
      expect(await attached.start()).toMatchObject({
        state: "ready",
        configId: started.configId,
      });
      expect(await attached.stop()).toEqual({ stopped: true });

      await mkdir(mismatchRoot, { recursive: true });
      await writeConfig(
        mismatchConfig,
        join(mismatchRoot, "data"),
        port,
        `mismatch-${crypto.randomUUID()}`,
      );
      const mismatch = new DaemonSupervisor({
        openminionExecutable: executable,
        configPath: mismatchConfig,
        homeRoot: mismatchRoot,
        dataRoot: join(mismatchRoot, "data"),
      });
      expect(await mismatch.start()).toMatchObject({
        state: "degraded",
        reachable: false,
        errorCode: "daemon_config_mismatch",
      });
      await mismatch.stop();

      const beforeRestart = await daemonStatus(executable, commandRoots);
      expect(beforeRestart.reachable).toBe(true);
      await runOpenMinion(executable, [...commandRoots, "daemon", "stop"]);
      const attemptsBeforeRecovery = supervisor.startAttempts;
      expect(await supervisor.status()).toMatchObject({
        state: "ready",
        reachable: true,
        configId: started.configId,
      });
      expect(supervisor.startAttempts).toBe(attemptsBeforeRecovery + 1);
      expect(await supervisor.status()).toMatchObject({ state: "ready" });
      expect(supervisor.startAttempts).toBe(attemptsBeforeRecovery + 1);

      expect(await supervisor.stop()).toEqual({ stopped: true });
      const afterExit = await daemonStatus(executable, commandRoots);
      expect(afterExit.reachable).toBe(true);
      expect(afterExit.status).toBe("running");
      expect(await readFile(join(dataRoot, "daemon.log"), "utf-8")).not.toContain(
        "/v1/turn/stream",
      );
    } finally {
      if (commandRoots) {
        await runOpenMinion(executable, [...commandRoots, "daemon", "stop"]).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!integrationExecutable)(
  "shares one durable session between desktop and CLI",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openminion-ods-"));
    const executable = integrationExecutable!;
    const homeRoot = join(root, "home");
    const dataRoot = join(root, "data");
    const configPath = join(root, "config.json");
    const ipcToken = `ods-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const commandRoots = [
      "--home-root",
      homeRoot,
      "--data-root",
      dataRoot,
      "--config",
      configPath,
      "--no-interactive",
    ];
    let supervisor: DaemonSupervisor | null = null;
    try {
      const port = await availablePort();
      await mkdir(homeRoot, { recursive: true });
      await mkdir(dataRoot, { recursive: true });
      await writeConfig(configPath, dataRoot, port, ipcToken);
      supervisor = new DaemonSupervisor({
        openminionExecutable: executable,
        commandTimeoutMs: 60_000,
        configPath,
        homeRoot,
        dataRoot,
      });
      const started = await supervisor.start();
      expect(started, JSON.stringify(started)).toMatchObject({ state: "ready" });

      const created = await supervisor.client.create({ title: "Shared durable chat" });
      if (!created.ok) {
        throw new Error(created.error.code);
      }
      const sessionId = created.value.sessionId;
      const initialEventCursor = created.value.eventCursor;
      const listed = await supervisor.client.list({ limit: 1 });
      expect(listed).toMatchObject({
        ok: true,
        value: { sessions: [{ sessionId }] },
      });

      const turnEvents: TurnEventV1[] = [];
      const submitted = await supervisor.client.submit(
        { sessionId, message: "Desktop opening" },
        (event) => turnEvents.push(event),
      );
      if (!submitted.ok) {
        throw new Error(submitted.error.code);
      }
      await vi.waitFor(
        () => expect(turnEvents.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
        { timeout: 30_000 },
      );
      expect(turnEvents.map((event) => event.kind)).toContain("response");

      const messages: MessageV1[] = [];
      let messageAfter: string | undefined;
      let messagePages = 0;
      while (true) {
        const loaded = await supervisor.client.load({
          sessionId,
          messageAfter,
          messageLimit: 1,
        });
        if (!loaded.ok) {
          throw new Error(loaded.error.code);
        }
        messagePages += 1;
        messages.push(...loaded.value.messages);
        if (!loaded.value.messagesHasMore) {
          break;
        }
        expect(loaded.value.nextMessageCursor).not.toBe(messageAfter);
        messageAfter = loaded.value.nextMessageCursor;
      }
      expect(messagePages).toBeGreaterThan(1);
      expect(messages.filter((message) => message.body === "Desktop opening")).toHaveLength(1);

      const sessionEvents: SessionEventV1[] = [];
      let eventAfter = initialEventCursor;
      let eventPages = 0;
      while (true) {
        const page = await supervisor.client.events({
          sessionId,
          after: eventAfter,
          limit: 1,
        });
        if (!page.ok) {
          throw new Error(page.error.code);
        }
        eventPages += 1;
        sessionEvents.push(...page.value.events);
        if (!page.value.hasMore) {
          break;
        }
        expect(page.value.nextCursor).not.toBe(eventAfter);
        eventAfter = page.value.nextCursor;
      }
      expect(eventPages).toBeGreaterThan(1);
      expect(sessionEvents.some((event) => event.traceId === submitted.value.traceId)).toBe(true);

      desktop.registerIpcHandlers(supervisor);
      const attemptsBeforeReload = supervisor.startAttempts;
      const rendererWindow = await desktop.createWindow(supervisor, {} as never);
      const frame = {
        url: "openminion://app/",
        detached: false,
        send: vi.fn(),
      };
      const rendererEvent = { senderFrame: frame, sender: { mainFrame: frame } };
      const replaySubmit = vi.fn();
      const reloadedApi = {
        sessions: {
          load(input: Parameters<NativeApi["sessions"]["load"]>[0]) {
            return mocks.ipcHandlers.get(IPC_CHANNELS.sessionsLoad)!(
              rendererEvent,
              input,
            ) as ReturnType<NativeApi["sessions"]["load"]>;
          },
          events(input: Parameters<NativeApi["sessions"]["events"]>[0]) {
            return mocks.ipcHandlers.get(IPC_CHANNELS.sessionsEvents)!(
              rendererEvent,
              input,
            ) as ReturnType<NativeApi["sessions"]["events"]>;
          },
        },
        turns: { submit: replaySubmit },
      } as unknown as NativeApi;
      const reloadRecovery = new Promise<Awaited<ReturnType<typeof recoverSession>>>(
        (resolve, reject) => {
          const reload = rendererWindow.webContents.reload as ReturnType<typeof vi.fn>;
          reload.mockImplementation(() => {
            void recoverSession(reloadedApi, sessionId).then(resolve, reject);
          });
        },
      );
      rendererWindow.webContents.reload();
      const reloaded = await reloadRecovery;
      if ("code" in reloaded) {
        throw new Error(reloaded.code);
      }
      expect(
        reloaded.messages.filter((message) => message.body === "Desktop opening"),
      ).toHaveLength(1);
      expect(reloaded.events.some((event) => event.traceId === submitted.value.traceId)).toBe(true);
      expect(replaySubmit).not.toHaveBeenCalled();
      expect(rendererWindow.webContents.reload).toHaveBeenCalledOnce();
      expect(supervisor.startAttempts).toBe(attemptsBeforeReload);

      await runOpenMinion(executable, [...commandRoots, "daemon", "stop"]);
      const attemptsBeforeRestart = supervisor.startAttempts;
      expect(await supervisor.status()).toMatchObject({ state: "ready" });
      expect(supervisor.startAttempts).toBe(attemptsBeforeRestart + 1);
      expect(await supervisor.status()).toMatchObject({ state: "ready" });
      expect(supervisor.startAttempts).toBe(attemptsBeforeRestart + 1);
      const afterRestart = await supervisor.client.load({ sessionId, messageLimit: 20 });
      if (!afterRestart.ok) {
        throw new Error(afterRestart.error.code);
      }
      expect(
        afterRestart.value.messages.filter((message) => message.body === "Desktop opening"),
      ).toHaveLength(1);

      const cli = await runOpenMinion(executable, [
        ...commandRoots,
        "run",
        "CLI continuation",
        "--profile",
        "openminion",
        "--session",
        sessionId,
        "--runtime-source",
        "daemon",
        "--stream",
        "--json",
      ]);
      const cliPayload = JSON.parse(cli.stdout) as Record<string, unknown>;
      expect(JSON.stringify(cliPayload)).not.toContain(root);
      expect(JSON.stringify(cliPayload)).not.toContain(ipcToken);

      const afterCli = await supervisor.client.load({ sessionId, messageLimit: 20 });
      if (!afterCli.ok) {
        throw new Error(afterCli.error.code);
      }
      expect(
        afterCli.value.messages.filter((message) => message.body === "Desktop opening"),
      ).toHaveLength(1);
      expect(
        afterCli.value.messages.filter((message) => message.body === "CLI continuation"),
      ).toHaveLength(1);

      const firstCancellation = await supervisor.client.cancel({
        sessionId,
        traceId: submitted.value.traceId,
      });
      const secondCancellation = await supervisor.client.cancel({
        sessionId,
        traceId: submitted.value.traceId,
      });
      expect(firstCancellation).toMatchObject({
        ok: true,
        value: { state: "completed", terminal: true },
      });
      expect(secondCancellation).toEqual(firstCancellation);

      const closed = await supervisor.client.close({ sessionId, reason: "fixture complete" });
      expect(closed).toMatchObject({
        ok: true,
        value: { sessionId, status: "closed" },
      });
      const observableResults = JSON.stringify([
        started,
        created,
        listed,
        submitted,
        turnEvents,
        messages,
        sessionEvents,
        reloaded,
        afterRestart,
        cliPayload,
        afterCli,
        firstCancellation,
        secondCancellation,
        closed,
      ]);
      expect(observableResults).not.toMatch(/client_token|ipc_token|127\.0\.0\.1|::1|\/v1\//i);
      expect(observableResults).not.toContain(root);
      expect(observableResults).not.toContain(homeRoot);
      expect(observableResults).not.toContain(dataRoot);
      expect(observableResults).not.toContain(configPath);
      expect(observableResults).not.toContain(ipcToken);
      expect(observableResults).not.toContain(`:${port}`);
    } finally {
      if (supervisor) {
        await supervisor.stop().catch(() => undefined);
      }
      await runOpenMinion(executable, [...commandRoots, "daemon", "stop"]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!integrationExecutable)(
  "reads artifacts and imports opaque grants through the real daemon",
  async () => {
    const cleanup: {
      supervisor: DaemonSupervisor | null;
      files: FileGrantService | null;
      unsubscribe: (() => void) | null;
      captureServer: ReturnType<typeof createHttpServer> | null;
      commandRoots: string[];
    } = {
      supervisor: null,
      files: null,
      unsubscribe: null,
      captureServer: null,
      commandRoots: [],
    };
    const root = await mkdtemp(join(tmpdir(), "openminion-odg-"));
    try {
      const executable = integrationExecutable!;
      const homeRoot = join(root, "home");
      const dataRoot = join(root, "data");
      const configPath = join(root, "config.json");
      const imagePath = join(root, "pixel.png");
      const ipcToken = `odg-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const daemonPort = await availablePort();
      const commandRoots = [
        "--home-root",
        homeRoot,
        "--data-root",
        dataRoot,
        "--config",
        configPath,
        "--no-interactive",
      ];
      cleanup.commandRoots = commandRoots;
      const capturedRequests: Array<Record<string, unknown>> = [];
      const capturePaths: string[] = [];
      const captureServer = createHttpServer((request, response) => {
        void (async () => {
          capturePaths.push(request.url ?? "");
          const body = JSON.parse(await readHttpBody(request)) as Record<string, unknown>;
          capturedRequests.push(body);
          const serialized = JSON.stringify(body);
          // Keep the detached turn provider-visible without adding assistant history,
          // so restore exercises the selected historical attachment on the next turn.
          const emptyDetachedResponse =
            serialized.includes("Detached context turn") && serialized.includes('"name":"respond"');
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              id: `capture-${capturedRequests.length}`,
              object: "chat.completion",
              created: 1,
              model: "capture-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: emptyDetachedResponse ? "" : "captured response",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          );
        })().catch(() => {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "capture_failed" }));
        });
      });
      cleanup.captureServer = captureServer;
      await new Promise<void>((resolve) => captureServer.listen(0, "127.0.0.1", resolve));
      const captureAddress = captureServer.address();
      if (!captureAddress || typeof captureAddress === "string") {
        throw new Error("capture server did not bind");
      }
      await mkdir(homeRoot, { recursive: true });
      await mkdir(dataRoot, { recursive: true });
      const imageBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(imagePath, imageBytes);
      await writeArtifactConfig(configPath, dataRoot, daemonPort, ipcToken, captureAddress.port);
      const supervisor = new DaemonSupervisor({
        openminionExecutable: executable,
        commandTimeoutMs: 60_000,
        configPath,
        homeRoot,
        dataRoot,
      });
      cleanup.supervisor = supervisor;
      const started = await supervisor.start();
      expect(started, JSON.stringify(started)).toMatchObject({
        state: "ready",
      });

      const media = new MediaService(supervisor.client);
      const files = new FileGrantService(
        supervisor.client,
        media,
        vi.fn().mockResolvedValue({ canceled: false, filePaths: [imagePath] }),
      );
      cleanup.files = files;
      desktop.registerIpcHandlers(supervisor, media, files);
      mocks.rendererListeners.clear();
      const api = mocks.exposedApi;
      if (!api) throw new Error("preload API was not exposed");
      const created = await api.sessions.create({
        title: "Artifact and grant fixture",
      });
      if (!created.ok) throw new Error(created.error.code);
      const sessionId = created.value.sessionId;
      const turnEvents: TurnEventV1[] = [];
      const unsubscribe = api.turns.subscribe((event) => turnEvents.push(event));
      cleanup.unsubscribe = unsubscribe;

      const picked = await api.files.pick({ sessionId, kind: "file" });
      if (!picked.ok || !picked.value.grant) throw new Error("file grant was not created");
      const grant = picked.value.grant;
      const imported = await api.files.import({
        sessionId,
        grantId: grant.grantId,
      });
      if (!imported.ok) throw new Error(imported.error.code);
      expect(imported.value.attachment).toMatchObject({
        sessionId,
        mimeType: "image/png",
        turnCompatible: true,
      });

      const submitTurn = async (
        message: string,
        attachmentIds?: string[],
        outcome: "complete" | "error" = "complete",
      ): Promise<Array<Record<string, unknown>>> => {
        const requestStart = capturedRequests.length;
        const submitted = await api.turns.submit({
          sessionId,
          message,
          ...(attachmentIds ? { attachmentIds } : {}),
        });
        if (!submitted.ok) throw new Error(submitted.error.code);
        await vi.waitFor(
          () =>
            expect(
              turnEvents.some(
                (event) => event.kind === "done" && event.traceId === submitted.value.traceId,
              ),
            ).toBe(true),
          { timeout: 30_000 },
        );
        expect(
          turnEvents.find(
            (event) => event.kind === "done" && event.traceId === submitted.value.traceId,
          ),
          JSON.stringify(turnEvents),
        ).toMatchObject({ kind: "done", outcome });
        expect(
          capturedRequests.length,
          JSON.stringify({ created, submitted, turnEvents, capturePaths }),
        ).toBeGreaterThan(requestStart);
        return capturedRequests.slice(requestStart);
      };

      const attachedRequests = await submitTurn("First attached turn", [
        imported.value.attachment.mediaId,
      ]);
      expect(attachedRequests.some((request) => imagePartCount(request) > 0)).toBe(true);
      await seedToolTranscript(
        executable,
        join(dataRoot, "state", "brain", "sessions.db"),
        sessionId,
        { homeRoot, dataRoot, configPath },
      );

      const catalogItems = [];
      let catalogCursor: string | undefined;
      do {
        const page = await api.artifacts.list({
          sessionId,
          ...(catalogCursor ? { cursor: catalogCursor } : {}),
          limit: 1,
        });
        if (!page.ok) throw new Error(page.error.code);
        catalogItems.push(...page.value.artifacts);
        catalogCursor = page.value.nextCursor ?? undefined;
        if (!page.value.complete && !catalogCursor) throw new Error("catalog cursor stalled");
      } while (catalogCursor);
      const artifactItem = catalogItems.find((item) => item.kind === "artifact");
      const toolItem = catalogItems.find((item) => item.kind === "tool_output");
      if (!artifactItem || !toolItem) throw new Error("artifact catalog was incomplete");
      expect(toolItem).toMatchObject({
        contentKind: "diff",
        toolName: "fixture.diff",
        toolStatus: "success",
      });

      const diffPages: string[] = [];
      let contentCursor: string | undefined;
      do {
        const page = await api.artifacts.read({
          sessionId,
          artifactId: toolItem.artifactId,
          ...(contentCursor ? { cursor: contentCursor } : {}),
          limitBytes: 1024,
        });
        if (!page.ok) throw new Error(page.error.code);
        expect(page.value.contentKind).toBe("diff");
        if (page.value.text === null) throw new Error("diff content was unavailable");
        diffPages.push(page.value.text);
        contentCursor = page.value.nextCursor ?? undefined;
        if (!page.value.complete && !contentCursor) throw new Error("content cursor stalled");
      } while (contentCursor);
      expect(diffPages.length).toBeGreaterThan(1);
      expect(diffPages.join("")).toContain("+new-99");

      const capturesBeforeDetach = capturedRequests.length;
      const detached = await api.artifacts.detach({
        sessionId,
        artifactId: artifactItem.artifactId,
      });
      expect(detached).toMatchObject({
        ok: true,
        value: { state: "detached" },
      });
      expect(
        await api.artifacts.detach({
          sessionId,
          artifactId: artifactItem.artifactId,
        }),
      ).toMatchObject({ ok: true, value: { outcome: "already_applied" } });
      expect(capturedRequests).toHaveLength(capturesBeforeDetach);
      const detachedRequests = await submitTurn("Detached context turn", undefined, "error");
      expect(detachedRequests.every((request) => imagePartCount(request) === 0)).toBe(true);

      const capturesBeforeRestore = capturedRequests.length;
      const restored = await api.artifacts.restore({
        sessionId,
        artifactId: artifactItem.artifactId,
      });
      expect(restored).toMatchObject({ ok: true, value: { state: "active" } });
      expect(
        await api.artifacts.restore({
          sessionId,
          artifactId: artifactItem.artifactId,
        }),
      ).toMatchObject({ ok: true, value: { outcome: "already_applied" } });
      expect(capturedRequests).toHaveLength(capturesBeforeRestore);
      const restoredRequests = await submitTurn("Restored context turn");
      expect(
        restoredRequests.some((request) => imagePartCount(request) > 0),
        JSON.stringify(restoredRequests.map(requestMessageSummary)),
      ).toBe(true);
      const history = await supervisor.client.load({
        sessionId,
        messageLimit: 20,
      });
      if (!history.ok) throw new Error(history.error.code);
      for (const body of [
        "First attached turn",
        "Detached context turn",
        "Restored context turn",
      ]) {
        expect(history.value.messages.filter((message) => message.body === body)).toHaveLength(1);
      }

      expect(await api.files.pick({ sessionId, kind: "directory" })).toMatchObject({
        ok: false,
        error: { code: "unsupported_file" },
      });
      expect(await api.files.list({ sessionId, grantId: grant.grantId })).toMatchObject({
        ok: false,
        error: { code: "grant_revoked" },
      });
      const released = await api.files.release({
        sessionId,
        grantId: grant.grantId,
      });
      expect(released).toMatchObject({ ok: true, value: { released: true } });
      expect(await api.files.release({ sessionId, grantId: grant.grantId })).toEqual(released);
      expect(await readFile(imagePath)).toEqual(imageBytes);
      expect(capturePaths.length).toBeGreaterThanOrEqual(3);
      expect(capturePaths.every((path) => path === "/v1/chat/completions")).toBe(true);
      expect(capturedRequests.length).toBeLessThanOrEqual(32);
      const providerVisible = JSON.stringify(capturedRequests);
      expect(Buffer.byteLength(providerVisible)).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(providerVisible).not.toMatch(
        /artifact:\/\/|sha256|client_token|ipc_token|endpoint|\/v1\//i,
      );
      for (const hidden of [root, homeRoot, dataRoot, configPath, ipcToken]) {
        expect(providerVisible).not.toContain(hidden);
      }

      const visible = JSON.stringify({
        started,
        created,
        picked,
        imported,
        catalogItems,
        detached,
        restored,
        released,
        history,
        diffPageCount: diffPages.length,
        imageCounts: [
          attachedRequests.map(imagePartCount),
          detachedRequests.map(imagePartCount),
          restoredRequests.map(imagePartCount),
        ],
      });
      expect(visible).not.toMatch(/artifact:\/\/|sha256|client_token|ipc_token|endpoint|\/v1\//i);
      expect(visible).not.toContain(root);
      expect(visible).not.toContain(ipcToken);
      expect(await api.sessions.close({ sessionId, reason: "fixture complete" })).toMatchObject({
        ok: true,
        value: { status: "closed" },
      });
    } finally {
      cleanup.unsubscribe?.();
      if (cleanup.files) await cleanup.files.close().catch(() => undefined);
      if (cleanup.supervisor) await cleanup.supervisor.stop().catch(() => undefined);
      if (cleanup.commandRoots.length > 0) {
        await runOpenMinion(integrationExecutable!, [
          ...cleanup.commandRoots,
          "daemon",
          "stop",
        ]).catch(() => undefined);
      }
      if (cleanup.captureServer?.listening) {
        await new Promise<void>((resolve) => cleanup.captureServer!.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!integrationExecutable)(
  "observes synthetic capture through the real daemon and local provider",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openminion-odi-"));
    const cleanup: {
      supervisor: DaemonSupervisor | null;
      files: FileGrantService | null;
      capture: CaptureService | null;
      observation: ObservationService | null;
      provider: ReturnType<typeof createHttpServer> | null;
      commandRoots: string[];
      pagehide: Array<() => void>;
    } = {
      supervisor: null,
      files: null,
      capture: null,
      observation: null,
      provider: null,
      commandRoots: [],
      pagehide: [],
    };
    try {
      const executable = integrationExecutable!;
      const homeRoot = join(root, "home");
      const dataRoot = join(root, "data");
      const configPath = join(root, "config.json");
      const ipcToken = `odi-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const providerKey = `odi-provider-${crypto.randomUUID()}`;
      const guidancePrompt = "Explain the safest next step from this exact view";
      const guidanceAnswer = "Review the visible changes before choosing an action.";
      const canonicalGuidanceAnswer = `openminion: ${guidanceAnswer}`;
      const daemonPort = await availablePort();
      const commandRoots = [
        "--home-root",
        homeRoot,
        "--data-root",
        dataRoot,
        "--config",
        configPath,
        "--no-interactive",
      ];
      cleanup.commandRoots = commandRoots;
      const capturedRequests: Array<Record<string, unknown>> = [];
      const maxProviderRequests = 32;
      const maxProviderBytes = 2 * 1024 * 1024;
      let reservedProviderRequests = 0;
      let reservedProviderBytes = 0;
      const provider = createHttpServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.statusCode = 404;
            response.end();
            return;
          }
          if (reservedProviderRequests >= maxProviderRequests) {
            throw new Error("provider_request_limit");
          }
          reservedProviderRequests += 1;
          const contentLength = exactContentLength(request);
          if (contentLength > maxProviderBytes - reservedProviderBytes) {
            throw new Error("provider_body_limit");
          }
          reservedProviderBytes += contentLength;
          const body = JSON.parse(await readExactHttpBody(request, contentLength)) as Record<
            string,
            unknown
          >;
          capturedRequests.push(body);
          const structured = fixtureSubmitOutput(body);
          const guidance = providerUserTexts(body).includes(guidancePrompt);
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              id: `observation-${capturedRequests.length}`,
              object: "chat.completion",
              created: 1,
              model: "capture-model",
              choices: [
                {
                  index: 0,
                  message: structured
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: `submit-${capturedRequests.length}`,
                            type: "function",
                            function: {
                              name: "submit_output",
                              arguments: JSON.stringify(structured),
                            },
                          },
                        ],
                      }
                    : {
                        role: "assistant",
                        content: guidance ? guidanceAnswer : "Observed locally.",
                      },
                  finish_reason: structured ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            }),
          );
        })().catch(() => {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "capture_failed" }));
        });
      });
      cleanup.provider = provider;
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const providerAddress = provider.address();
      if (!providerAddress || typeof providerAddress === "string") {
        throw new Error("observation provider did not bind");
      }
      const providerEndpoint = `http://127.0.0.1:${providerAddress.port}/v1`;
      const daemonEndpoint = `http://127.0.0.1:${daemonPort}`;

      await mkdir(homeRoot, { recursive: true });
      await mkdir(dataRoot, { recursive: true });
      await writeObservationConfig(
        configPath,
        dataRoot,
        daemonPort,
        ipcToken,
        providerAddress.port,
        providerKey,
      );
      const supervisor = new DaemonSupervisor({
        openminionExecutable: executable,
        commandTimeoutMs: 60_000,
        configPath,
        homeRoot,
        dataRoot,
      });
      cleanup.supervisor = supervisor;
      expect(await supervisor.start()).toMatchObject({ state: "ready" });
      const created = await supervisor.client.create({ title: "Observation fixture" });
      if (!created.ok) throw new Error(created.error.code);
      const sessionId = created.value.sessionId;

      const clock = { value: Date.parse("2026-08-22T12:00:00Z") };
      mocks.decodedSize = { width: 480, height: 270 };
      const emittedBuffers: Uint8Array[] = [];
      let emitWorkerFrame: ((bytes: Uint8Array) => void) | null = null;
      const firstJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
      const thumbnail = {
        isEmpty: () => false,
        getSize: () => ({ width: 640, height: 360 }),
        resize: () => thumbnail,
        toJPEG: () => Buffer.from(firstJpeg),
      };
      const source = {
        nativeId: "synthetic:observation:1",
        label: "Observation fixture display",
        thumbnail: thumbnail as never,
        scaleFactor: 1,
        grantSource: { id: "synthetic:observation:1", name: "Observation fixture display" },
      };
      const platform: CapturePlatform = {
        platform: "darwin",
        permission: () => "granted",
        sources: async () => [source],
        createWorker: async (input, emit) => {
          queueMicrotask(() => emit({ schemaVersion: 1, kind: "ready" }));
          const emitFrame = (bytes: Uint8Array) => {
            emittedBuffers.push(bytes);
            emit({
              schemaVersion: 1,
              kind: "frame",
              captureId: input.captureId,
              generation: input.generation,
              sourceWidth: 640,
              sourceHeight: 360,
              width: 640,
              height: 360,
              bytes,
            });
          };
          emitWorkerFrame = emitFrame;
          return {
            configure() {
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
              mocks.decodedSize = { width: 640, height: 360 };
              queueMicrotask(() => {
                emit({
                  schemaVersion: 1,
                  kind: "stream_ready",
                  captureId: input.captureId,
                  generation: input.generation,
                  sourceWidth: 640,
                  sourceHeight: 360,
                });
                queueMicrotask(() => emitFrame(new Uint8Array(firstJpeg)));
              });
              return true;
            },
            async waitForAdmission() {},
            async stop() {},
          };
        },
      };
      const capture = new CaptureService(platform, { now: () => clock.value });
      cleanup.capture = capture;
      const media = new MediaService(supervisor.client);
      const files = new FileGrantService(supervisor.client, media);
      cleanup.files = files;
      const observation = new ObservationService(capture, media, () => clock.value);
      cleanup.observation = observation;
      desktop.registerIpcHandlers(supervisor, media, files, capture, observation);

      mocks.rendererListeners.clear();
      const pagehide: Array<() => void> = [];
      cleanup.pagehide = pagehide;
      vi.stubGlobal("window", {
        addEventListener(type: string, listener: () => void) {
          if (type === "pagehide") pagehide.push(listener);
        },
      });
      const page = new CaptureFixtureDocument();
      await mount(mocks.exposedApi!, page.asDocument());
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toContain("Observation fixture"),
      );
      await vi.waitFor(() => expect(page.element("observe-computer").disabled).toBe(false));
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(page.captureButtons()).toHaveLength(1));
      page.captureButtons()[0]!.click();
      page.element("start-capture").click();
      await vi.waitFor(() =>
        expect(
          page.element("capture-state").textContent,
          page.element("capture-status").textContent,
        ).toBe("Observing"),
      );
      await vi.waitFor(() => expect(page.element("include-current-view").disabled).toBe(false));

      page.element("composer").value = "Describe the current screen";
      page.element("composer").dispatch("input");
      page.element("include-current-view").checked = true;
      const manualRequestStart = capturedRequests.length;
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(
        async () => {
          const status = await mocks.exposedApi!.observation!.status();
          expect(status).toMatchObject({
            ok: true,
            value: { counters: { inferencesCompleted: 1 } },
          });
        },
        { timeout: 30_000 },
      );
      const firstProviderImages = providerImageUrls(capturedRequests.slice(manualRequestStart));
      expect(
        firstProviderImages,
        JSON.stringify({
          requests: capturedRequests.slice(manualRequestStart).map(requestMessageSummary),
          tools: capturedRequests[manualRequestStart]?.tools,
        }),
      ).toEqual([`data:image/jpeg;base64,${Buffer.from(firstJpeg).toString("base64")}`]);
      expect(
        capturedRequests
          .slice(manualRequestStart)
          .filter((request) => fixtureSubmitOutput(request) !== null)
          .flatMap(providerImageUrls),
      ).toEqual([]);
      const manualStatus = await mocks.exposedApi!.observation!.status();
      if (!manualStatus.ok || !manualStatus.value.selectedFrame || !manualStatus.value.sentFrame) {
        throw new Error("manual_observation_facts_missing");
      }
      expect(manualStatus.value.sentFrame).toEqual(manualStatus.value.selectedFrame);
      expect(manualStatus.value.sentFrame.contentHash).toBe(
        createHash("sha256").update(firstJpeg).digest("hex"),
      );
      expect(manualStatus.value.sentFrame.previewUrl).toBe(
        `openminion://app/capture/frames/${manualStatus.value.sentFrame.frameId}`,
      );
      expect(manualStatus.value.sentFrame.expiresAt).toBe(
        new Date(clock.value + 30_000).toISOString(),
      );
      expect(page.element("observation-selected-preview").src).toBe(
        manualStatus.value.sentFrame.previewUrl,
      );
      expect(page.element("observation-sent-preview").src).toBe(
        manualStatus.value.sentFrame.previewUrl,
      );
      expect(page.element("observation-sent-facts").textContent).toContain("user send");

      const initialWatchJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 4, 5, 6, 0xff, 0xd9]);
      page.element("observation-instruction").value = "Describe visible changes";
      page.element("observation-instruction").dispatch("input");
      const initialRequestStart = capturedRequests.length;
      page.element("start-observation").click();
      await vi.waitFor(async () => {
        const status = await mocks.exposedApi!.observation!.status();
        expect(status).toMatchObject({
          ok: true,
          value: { watchEnabled: true, state: "waiting" },
        });
      });
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(initialWatchJpeg));
      await vi.waitFor(
        async () => {
          const status = await mocks.exposedApi!.observation!.status();
          expect(status).toMatchObject({
            ok: true,
            value: { counters: { inferencesCompleted: 2 } },
          });
        },
        { timeout: 30_000 },
      );
      const initialRequests = capturedRequests.slice(initialRequestStart);
      const initialUrl = `data:image/jpeg;base64,${Buffer.from(initialWatchJpeg).toString("base64")}`;
      expect(providerImageUrls(initialRequests).filter((url) => url === initialUrl)).toEqual([
        initialUrl,
      ]);
      expect(
        initialRequests
          .filter((request) => fixtureSubmitOutput(request) !== null)
          .flatMap(providerImageUrls),
      ).toEqual([]);
      const historyAfterInitial = await supervisor.client.load({ sessionId, messageLimit: 20 });
      if (!historyAfterInitial.ok) throw new Error(historyAfterInitial.error.code);
      expect(
        historyAfterInitial.value.messages.filter(
          (message) => message.body === "Describe the current screen",
        ),
      ).toHaveLength(1);
      expect(
        historyAfterInitial.value.messages.filter(
          (message) => message.body === "Describe visible changes",
        ),
      ).toHaveLength(1);

      const beforeDuplicate = capturedRequests.length;
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(initialWatchJpeg));
      await vi.waitFor(async () => {
        const status = await mocks.exposedApi!.observation!.status();
        expect(status).toMatchObject({
          ok: true,
          value: { counters: { skippedUnchanged: 1 } },
        });
      });
      expect(capturedRequests).toHaveLength(beforeDuplicate);

      const replacedJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe2, 7, 8, 9, 0xff, 0xd9]);
      const latestJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe3, 10, 11, 12, 0xff, 0xd9]);
      const changeStart = capturedRequests.length;
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(replacedJpeg));
      await vi.waitFor(async () => {
        const status = await mocks.exposedApi!.observation!.status();
        expect(status).toMatchObject({
          ok: true,
          value: { counters: { captureFrames: 4 } },
        });
      });
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(latestJpeg));
      await vi.waitFor(
        async () => {
          const status = await mocks.exposedApi!.observation!.status();
          expect(status).toMatchObject({
            ok: true,
            value: { counters: { inferencesCompleted: 3 } },
          });
        },
        { timeout: 30_000 },
      );
      const changeRequests = capturedRequests.slice(changeStart);
      const latestUrl = `data:image/jpeg;base64,${Buffer.from(latestJpeg).toString("base64")}`;
      const replacedUrl = `data:image/jpeg;base64,${Buffer.from(replacedJpeg).toString("base64")}`;
      expect(providerImageUrls(changeRequests).filter((url) => url === latestUrl)).toEqual([
        latestUrl,
      ]);
      expect(providerImageUrls(changeRequests)).not.toContain(replacedUrl);
      expect(
        changeRequests
          .filter((request) => fixtureSubmitOutput(request) !== null)
          .flatMap(providerImageUrls),
      ).toEqual([]);
      const afterChange = await mocks.exposedApi!.observation!.status();
      expect(afterChange).toMatchObject({
        ok: true,
        value: {
          counters: {
            replacedPending: expect.any(Number),
            inferencesStarted: 3,
            inferencesCompleted: 3,
          },
          usage: {
            usageAvailable: true,
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
            costSource: "unavailable",
          },
        },
      });
      if (afterChange.ok) {
        expect(afterChange.value.counters.replacedPending).toBeGreaterThanOrEqual(1);
        expect(afterChange.value.selectedFrame).not.toBeNull();
        expect(afterChange.value.sentFrame).toEqual(afterChange.value.selectedFrame);
        expect(afterChange.value.sentFrame?.contentHash).toBe(
          createHash("sha256").update(latestJpeg).digest("hex"),
        );
        expect(afterChange.value.sentFrame?.previewUrl).toBe(
          `openminion://app/capture/frames/${afterChange.value.sentFrame?.frameId}`,
        );
        expect(page.element("observation-selected-preview").src).toBe(
          afterChange.value.sentFrame?.previewUrl,
        );
        expect(page.element("observation-sent-preview").src).toBe(
          afterChange.value.sentFrame?.previewUrl,
        );
      }
      expect(page.element("observation-counters").textContent).toContain("3 started");
      expect(page.element("observation-usage").textContent).toMatch(
        /^7 input \+ 3 output tokens · 1 model call · \d+ ms · Cost unavailable$/,
      );

      page.element("stop-observation").click();
      await vi.waitFor(async () => {
        const status = await mocks.exposedApi!.observation!.status();
        expect(status).toMatchObject({
          ok: true,
          value: { watchEnabled: false, state: "ready" },
        });
      });
      clock.value = Date.now();
      const guidanceJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe5, 13, 14, 15, 0xff, 0xd9]);
      const guidanceUrl = `data:image/jpeg;base64,${Buffer.from(guidanceJpeg).toString("base64")}`;
      emitWorkerFrame!(new Uint8Array(guidanceJpeg));
      page.element("composer").value = guidancePrompt;
      page.element("composer").dispatch("input");
      await vi.waitFor(() => expect(page.element("ask-guidance").disabled).toBe(false));
      const guidanceSubmitSpy = vi.spyOn(mocks.exposedApi!.turns, "submit");
      const guidanceRequestStart = capturedRequests.length;
      page.element("ask-guidance").click();
      await vi.waitFor(() => expect(page.element("guidance-card").hidden).toBe(false), {
        timeout: 30_000,
      });
      expect(guidanceSubmitSpy).toHaveBeenCalledTimes(1);
      expect(guidanceSubmitSpy).toHaveBeenCalledWith({
        sessionId,
        message: guidancePrompt,
        observation: { includeCurrentView: true },
      });
      const guidanceSubmit = await guidanceSubmitSpy.mock.results[0]!.value;
      guidanceSubmitSpy.mockRestore();
      if (!guidanceSubmit.ok) throw new Error(guidanceSubmit.error.code);
      const guidanceRequests = capturedRequests.slice(guidanceRequestStart);
      const guidanceImageRequests = guidanceRequests.filter(
        (request) => providerImageUrls(request).length > 0,
      );
      expect(guidanceImageRequests).toHaveLength(1);
      expect(providerImageUrls(guidanceRequests).filter((url) => url === guidanceUrl)).toEqual([
        guidanceUrl,
      ]);
      expect(
        providerUserTexts(guidanceImageRequests[0]!).filter((text) => text === guidancePrompt),
      ).toHaveLength(1);
      expect(
        guidanceRequests
          .filter((request) => fixtureSubmitOutput(request) !== null)
          .flatMap(providerImageUrls),
      ).toEqual([]);
      const guidanceStatus = await mocks.exposedApi!.observation!.status();
      if (
        !guidanceStatus.ok ||
        !guidanceStatus.value.selectedFrame ||
        !guidanceStatus.value.sentFrame
      ) {
        throw new Error("guidance_observation_facts_missing");
      }
      expect(guidanceStatus.value.sentFrame).toEqual(guidanceStatus.value.selectedFrame);
      expect(guidanceStatus.value.sentFrame.reason).toBe("user_send");
      expect(guidanceStatus.value.sentFrame.traceId).toBe(guidanceSubmit.value.traceId);
      expect(guidanceStatus.value.sentFrame.sentAt).not.toBeNull();
      expect(guidanceStatus.value.sentFrame.contentHash).toBe(
        createHash("sha256").update(guidanceJpeg).digest("hex"),
      );
      expect(page.element("observation-selected-preview").src).toBe(
        guidanceStatus.value.sentFrame.previewUrl,
      );
      expect(page.element("observation-sent-preview").src).toBe(
        guidanceStatus.value.sentFrame.previewUrl,
      );
      expect(page.element("guidance-state").textContent).toBe("Current");
      expect(page.element("guidance-preview").src).toBe(guidanceStatus.value.sentFrame.previewUrl);
      expect(page.element("guidance-facts").textContent).toContain(source.label);
      expect(page.element("guidance-facts").textContent).toContain("display");
      expect(page.element("guidance-text").textContent).toBe(canonicalGuidanceAnswer);
      expect(
        page
          .element("guidance-card")
          .descendants()
          .filter((element) => element.tagName === "button"),
      ).toEqual([]);
      await vi.waitFor(async () => {
        expect(await mocks.exposedApi!.capture!.status()).toMatchObject({
          ok: true,
          value: { state: "observing", sessionId },
        });
        expect(page.element("capture-state").textContent).toBe("Observing");
        expect(page.element("capture-preview").src).toBe(
          guidanceStatus.value.sentFrame!.previewUrl,
        );
      });

      const beforeGuidanceStale = capturedRequests.length;
      const newerGuidanceJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe6, 16, 17, 18, 0xff, 0xd9]);
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(newerGuidanceJpeg));
      await vi.waitFor(() => expect(page.element("guidance-state").textContent).toBe("Stale"));
      expect(page.element("guidance-status").textContent).toContain("newer frame");
      expect(page.element("guidance-preview").src).toBe("");
      expect(page.element("guidance-text").textContent).toBe(canonicalGuidanceAnswer);
      await vi.waitFor(() =>
        expect(
          page
            .element("timeline")
            .descendants()
            .filter((element) => element.textContent === canonicalGuidanceAnswer),
        ).toHaveLength(1),
      );
      const historyAfterGuidance = await supervisor.client.load({
        sessionId,
        messageLimit: 30,
      });
      if (!historyAfterGuidance.ok) throw new Error(historyAfterGuidance.error.code);
      expect(
        historyAfterGuidance.value.messages.filter(
          (message) => message.role === "user" && message.body === guidancePrompt,
        ),
      ).toHaveLength(1);
      expect(
        historyAfterGuidance.value.messages.filter(
          (message) => message.role === "assistant" && message.body === canonicalGuidanceAnswer,
        ),
      ).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capturedRequests).toHaveLength(beforeGuidanceStale);

      const beforeExpired = capturedRequests.length;
      const expiredJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe4, 13, 14, 15, 0xff, 0xd9]);
      clock.value += 2_001;
      emitWorkerFrame!(new Uint8Array(expiredJpeg));
      clock.value += 30_001;
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      expect(capturedRequests).toHaveLength(beforeExpired);

      page.element("pause-capture").click();
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Paused"));
      const beforePaused = capturedRequests.length;
      emitWorkerFrame!(new Uint8Array([0xff, 0xd8, 0xff, 0xe5, 0xff, 0xd9]));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capturedRequests).toHaveLength(beforePaused);
      expect(emittedBuffers.every((bytes) => bytes.every((value) => value === 0))).toBe(true);

      const publicFacts = JSON.stringify({
        observation: await mocks.exposedApi!.observation!.status(),
        counters: page.element("observation-counters").textContent,
        usage: page.element("observation-usage").textContent,
        selected: page.element("observation-selected-facts").textContent,
        sent: page.element("observation-sent-facts").textContent,
        guidance: {
          state: page.element("guidance-state").textContent,
          facts: page.element("guidance-facts").textContent,
          text: page.element("guidance-text").textContent,
          status: page.element("guidance-status").textContent,
          preview: page.element("guidance-preview").src,
        },
        timeline: page
          .element("timeline")
          .descendants()
          .map((element) => element.textContent),
        history: historyAfterInitial,
        guidanceHistory: historyAfterGuidance,
      });
      const providerFacts = JSON.stringify(capturedRequests);
      expect(publicFacts).not.toMatch(
        /artifact:\/\/|client[_-]?token|ipc[_-]?token|media[_-]?id|internal[_-]?ref|endpoint|\/v1\//i,
      );
      expect(providerFacts).not.toMatch(
        /artifact:\/\/|client[_-]?token|ipc[_-]?token|media[_-]?id|internal[_-]?ref/i,
      );
      for (const hidden of [
        root,
        homeRoot,
        dataRoot,
        configPath,
        ipcToken,
        providerKey,
        providerEndpoint,
        daemonEndpoint,
      ]) {
        expect(publicFacts).not.toContain(hidden);
        expect(providerFacts).not.toContain(hidden);
      }
      expect(Buffer.byteLength(providerFacts)).toBeLessThan(2 * 1024 * 1024);
      expect(capturedRequests.length).toBeLessThanOrEqual(maxProviderRequests);
      expect(reservedProviderRequests).toBeLessThanOrEqual(maxProviderRequests);
      expect(reservedProviderBytes).toBeLessThanOrEqual(maxProviderBytes);
    } finally {
      cleanup.pagehide[0]?.();
      vi.unstubAllGlobals();
      if (cleanup.observation) await cleanup.observation.close().catch(() => undefined);
      if (cleanup.capture) await cleanup.capture.close().catch(() => undefined);
      if (cleanup.files) await cleanup.files.close().catch(() => undefined);
      if (cleanup.supervisor) await cleanup.supervisor.stop().catch(() => undefined);
      if (cleanup.commandRoots.length > 0) {
        await runOpenMinion(integrationExecutable!, [
          ...cleanup.commandRoots,
          "daemon",
          "stop",
        ]).catch(() => undefined);
      }
      if (cleanup.provider?.listening) {
        await new Promise<void>((resolve) => cleanup.provider!.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("unable to allocate loopback port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function imagePartCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + imagePartCount(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const own = record.type === "image_url" || record.type === "input_image" ? 1 : 0;
  return (
    own + Object.values(record).reduce<number>((count, item) => count + imagePartCount(item), 0)
  );
}

function providerImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(providerImageUrls);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const image =
    record.type === "image_url" && record.image_url && typeof record.image_url === "object"
      ? (record.image_url as Record<string, unknown>).url
      : null;
  return [
    ...(typeof image === "string" ? [image] : []),
    ...Object.values(record).flatMap(providerImageUrls),
  ];
}

function fixtureSubmitOutput(request: Record<string, unknown>): unknown {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const record = fn as Record<string, unknown>;
    if (
      record.name !== "submit_output" ||
      !record.parameters ||
      typeof record.parameters !== "object"
    )
      continue;
    return fixtureSchemaValue(record.parameters as Record<string, unknown>);
  }
  return null;
}

function fixtureSchemaValue(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): unknown {
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    let resolved: unknown = root;
    for (const segment of schema.$ref.slice(2).split("/")) {
      if (!resolved || typeof resolved !== "object") return "Observed locally.";
      resolved = (resolved as Record<string, unknown>)[segment];
    }
    return resolved && typeof resolved === "object"
      ? fixtureSchemaValue(resolved as Record<string, unknown>, root)
      : "Observed locally.";
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const alternative of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (!Array.isArray(alternative)) continue;
    const selected = alternative.find(
      (item) =>
        item && typeof item === "object" && (item as Record<string, unknown>).type !== "null",
    );
    if (selected && typeof selected === "object") {
      return fixtureSchemaValue(selected as Record<string, unknown>, root);
    }
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "array") return [];
  if (schema.type === "object" || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : Object.keys(properties);
    return Object.fromEntries(
      required.map((key) => {
        const property = properties[key];
        return [
          key,
          property && typeof property === "object"
            ? fixtureSchemaValue(property as Record<string, unknown>, root)
            : "Observed locally.",
        ];
      }),
    );
  }
  return "Observed locally.";
}

function requestMessageSummary(request: Record<string, unknown>) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return {
    imageParts: imagePartCount(request),
    messages: messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      const record = message as Record<string, unknown>;
      const content =
        typeof record.content === "string" ? record.content.slice(-240) : record.content;
      return { role: record.role, content };
    }),
  };
}

function providerUserTexts(request: Record<string, unknown>): string[] {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.role !== "user") return [];
    if (typeof record.content === "string") return [record.content];
    if (!Array.isArray(record.content)) return [];
    return record.content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const content = part as Record<string, unknown>;
      return (content.type === "text" || content.type === "input_text") &&
        typeof content.text === "string"
        ? [content.text]
        : [];
    });
  });
}

async function seedToolTranscript(
  executable: string,
  databasePath: string,
  sessionId: string,
  roots: { homeRoot: string; dataRoot: string; configPath: string },
): Promise<void> {
  const source = [
    "import sys",
    "from openminion.modules.session.storage.store import SQLiteSessionStore",
    "store = SQLiteSessionStore(sys.argv[1])",
    "try:",
    "    session_id = sys.argv[2]",
    "    request_id = store.append_event(session_id, type='tool.call.requested', payload={",
    "        'schema_version': 1, 'turn_scope_id': 'fixture-turn',",
    "        'call_id': 'fixture-call', 'canonical_name': 'fixture.diff',",
    "        'sanitized_normalized_arguments': {}, 'batch_index': 0, 'depends_on': []})",
    "    diff = '--- a/safe.txt\\n+++ b/safe.txt\\n' + ''.join(",
    "        f'@@ -{index + 1},1 +{index + 1},1 @@\\n-old-{index}\\n+new-{index}\\n'",
    "        for index in range(100))",
    "    store.append_event(session_id, type='tool.call.completed', parent_event_id=request_id, payload={",
    "        'schema_version': 1, 'turn_scope_id': 'fixture-turn',",
    "        'call_id': 'fixture-call', 'status': 'success',",
    "        'output': {'summary': 'synthetic diff complete', 'outputs': {'diff': diff}}})",
    "finally:",
    "    store.close()",
  ].join("\n");
  await execFileAsync(
    join(dirname(executable), "python3.11"),
    ["-c", source, databasePath, sessionId],
    {
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        OPENMINION_HOME: roots.homeRoot,
        OPENMINION_DATA_ROOT: roots.dataRoot,
        OPENMINION_CONFIG_PATH: roots.configPath,
        OPENMINION_GENERATED_ROOT: join(roots.dataRoot, "runtime"),
      },
    },
  );
}

async function readHttpBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function exactContentLength(request: IncomingMessage): number {
  const value = request.headers["content-length"];
  if (Array.isArray(value) || typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("provider_content_length_required");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("provider_content_length_invalid");
  }
  return length;
}

async function readExactHttpBody(request: IncomingMessage, contentLength: number): Promise<string> {
  const body = Buffer.allocUnsafe(contentLength);
  let offset = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (offset + chunk.byteLength > contentLength) {
      body.fill(0);
      throw new Error("provider_body_overflow");
    }
    chunk.copy(body, offset);
    offset += chunk.byteLength;
  }
  if (offset !== contentLength) {
    body.fill(0);
    throw new Error("provider_body_truncated");
  }
  const text = body.toString("utf-8");
  body.fill(0);
  return text;
}

function writeFixtureEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function fixtureSession() {
  return {
    schema_version: 1,
    session_id: "session-1",
    title: "Approval fixture",
    status: "active",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:01Z",
    active_agent_id: "openminion",
    model: { provider: null, model_id: null },
    project_id: null,
    event_cursor: "event-zero",
  };
}

function fixtureApprovalEvents() {
  const shared = {
    schema_version: 1,
    created_at: "2026-08-20T00:00:00Z",
    run_id: null,
    trace_id: "trace-recovered",
  };
  return [
    {
      ...shared,
      event_type: "desktop.approval.requested",
      cursor: "event-one",
      state: "pending",
      facts: {
        approval_id: "approval-live",
        call_id: "call-live",
        tool_name: "workspace.write",
        argument_keys: ["path", "text"],
        argument_keys_count: 2,
        requested_at: "2026-08-20T00:00:00Z",
        expires_at: "2026-08-20T00:01:00Z",
        outcome: "pending",
      },
    },
    {
      ...shared,
      event_type: "desktop.approval.resolved",
      cursor: "event-two",
      state: "terminal",
      facts: {
        approval_id: "approval-live",
        call_id: "call-live",
        tool_name: "workspace.write",
        decision: "allow_once",
        outcome: "applied",
        resolved_at: "2026-08-20T00:00:01Z",
      },
    },
  ];
}

async function proveRealLeaseExpiry(port: number, ipcToken: string): Promise<void> {
  const body = JSON.stringify({
    schema_version: 1,
    client: {
      kind: "desktop",
      version: "odf-e2e",
      protocol_min: 1,
      protocol_max: 1,
    },
    requested_ttl_seconds: 60,
  });
  const minted = await localJsonRequest(port, "/v1/client/leases", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body).toString(),
      "X-IPC-Token": ipcToken,
    },
    body,
  });
  expect(minted.status).toBe(200);
  const lease = minted.payload.lease as Record<string, unknown>;
  const clientToken = String(lease.client_token ?? "");
  const expiresAt = Date.parse(String(lease.expires_at ?? ""));
  expect(clientToken.length).toBeGreaterThanOrEqual(43);
  expect(Number.isFinite(expiresAt)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 250)));
  const expired = await localJsonRequest(port, "/v1/client/capabilities", {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-OpenMinion-Client-Token": clientToken,
    },
  });
  expect(expired.status).toBe(403);
  expect((expired.payload.error as Record<string, unknown>).code).toBe("forbidden");
}

async function localJsonRequest(
  port: number,
  path: string,
  options: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 64 * 1024) {
            response.destroy(new Error("fixture response exceeded 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("fixture timeout")));
    request.once("error", reject);
    request.end(options.body);
  });
}

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
  scrollTop = 0;
  scrollHeight = 0;
  children: CaptureFixtureElement[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly tagName: string) {}

  append(...children: CaptureFixtureElement[]) {
    this.children.push(...children);
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
    "status-dot",
    "status-summary",
    "retry",
    "show-connection",
    "connection-details",
    "recovery",
    "daemon-version",
    "protocol-version",
    "shell-version",
    "connection-label",
    "session-list",
    "new-session",
    "close-session",
    "current-title",
    "timeline",
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
    "command-title",
    "command-result",
    "context-panel",
    "screen-panel",
    "send",
    "cancel",
    "ask-guidance",
    "guidance-card",
    "guidance-state",
    "guidance-preview",
    "guidance-facts",
    "guidance-text",
    "guidance-status",
    "attachments",
    "include-current-view",
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

async function writeConfig(
  configPath: string,
  dataRoot: string,
  port: number,
  ipcToken: string,
): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        runtime: {
          ipc_host: "127.0.0.1",
          ipc_port: port,
          ipc_token: ipcToken,
          daemon_pid_file: join(dataRoot, "daemon.pid"),
          daemon_log_file: join(dataRoot, "daemon.log"),
          memory_enabled: false,
          telemetry_enabled: false,
          session_context_token_budget: 100_000,
        },
        storage: { path: join(dataRoot, "state", "openminion.db") },
        agents: {
          openminion: {
            name: "openminion",
            default_channel: "console",
            provider: "echo",
          },
        },
        default_agent: "openminion",
        enabled_plugins: ["validate"],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function writeArtifactConfig(
  configPath: string,
  dataRoot: string,
  port: number,
  ipcToken: string,
  capturePort: number,
): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        runtime: {
          ipc_host: "127.0.0.1",
          ipc_port: port,
          ipc_token: ipcToken,
          daemon_pid_file: join(dataRoot, "daemon.pid"),
          daemon_log_file: join(dataRoot, "daemon.log"),
          memory_enabled: false,
          telemetry_enabled: false,
        },
        storage: { path: join(dataRoot, "state", "openminion.db") },
        providers: {
          openai: {
            api_key: "synthetic-local-key",
            base_url: `http://127.0.0.1:${capturePort}/v1`,
            enable_vision_input: true,
            model: "capture-model",
          },
        },
        agents: {
          openminion: {
            name: "openminion",
            default_channel: "console",
            provider: "openai",
            model: "capture-model",
          },
        },
        default_agent: "openminion",
        enabled_plugins: ["validate"],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function writeObservationConfig(
  configPath: string,
  dataRoot: string,
  port: number,
  ipcToken: string,
  capturePort: number,
  providerKey: string,
): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        runtime: {
          ipc_host: "127.0.0.1",
          ipc_port: port,
          ipc_token: ipcToken,
          daemon_pid_file: join(dataRoot, "daemon.pid"),
          daemon_log_file: join(dataRoot, "daemon.log"),
          memory_enabled: false,
          telemetry_enabled: false,
        },
        storage: { path: join(dataRoot, "state", "openminion.db") },
        providers: {
          openai: {
            api_key: providerKey,
            base_url: `http://127.0.0.1:${capturePort}/v1`,
            enable_vision_input: true,
            model: "capture-model",
          },
        },
        agents: {
          openminion: {
            name: "openminion",
            default_channel: "console",
            provider: "openai",
            model: "capture-model",
          },
        },
        default_agent: "openminion",
        enabled_plugins: ["validate"],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function daemonStatus(
  executable: string,
  commandRoots: string[],
): Promise<Record<string, unknown>> {
  const { stdout } = await runOpenMinion(executable, [
    ...commandRoots,
    "daemon",
    "status",
    "--json",
  ]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runOpenMinion(executable: string, args: string[]) {
  return execFileAsync(executable, args, {
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
}
