import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_WORKER_CONFIG_CHANNEL,
  CAPTURE_WORKER_EVENT_CHANNEL,
} from "../../src/shared/capture-worker.js";
import { IPC_CHANNELS } from "../../src/shared/contracts.js";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
  invoke: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.set(channel, listener);
    }),
    send: mocks.send,
    invoke: mocks.invoke,
    removeListener: mocks.removeListener,
  },
}));

describe("capture worker preload", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.expose.mockReset();
    mocks.send.mockReset();
    mocks.invoke.mockReset();
    mocks.removeListener.mockReset();
    mocks.listeners.clear();
  });

  it("exposes only one fixed configure callback and event sender", async () => {
    await import("../../src/preload/capture.js");
    expect(mocks.expose).toHaveBeenCalledOnce();
    const [name, bridge] = mocks.expose.mock.calls[0];
    expect(name).toBe("openminionCaptureBridge");
    expect(Object.keys(bridge)).toEqual(["configure", "send"]);
    expect(bridge).not.toHaveProperty("invoke");
    expect(bridge).not.toHaveProperty("request");

    const configured = vi.fn();
    bridge.configure(configured);
    const config = {
      schemaVersion: 1,
      kind: "configure",
      captureId: "a".repeat(48),
      generation: 1,
      region: null,
      cadenceMs: 2000,
      maxWidth: 1920,
      maxHeight: 1080,
      jpegQuality: 0.8,
      maxBytes: 2_097_152,
    };
    mocks.listeners.get(CAPTURE_WORKER_CONFIG_CHANNEL)!({}, config);
    expect(configured).toHaveBeenCalledWith(config);
    mocks.listeners.get(CAPTURE_WORKER_CONFIG_CHANNEL)!({}, { ...config, maxBytes: 3 });
    expect(configured).toHaveBeenCalledOnce();

    const ready = { schemaVersion: 1, kind: "ready" };
    bridge.send(ready);
    expect(mocks.send).toHaveBeenCalledWith(CAPTURE_WORKER_EVENT_CHANNEL, ready);
    const validBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    let sentBytes: Uint8Array | undefined;
    mocks.send.mockImplementationOnce((_channel, event) => {
      sentBytes = new Uint8Array(event.bytes);
    });
    bridge.send({
      schemaVersion: 1,
      kind: "frame",
      captureId: "a".repeat(48),
      generation: 1,
      sourceWidth: 100,
      sourceHeight: 100,
      width: 100,
      height: 100,
      bytes: validBytes,
    });
    expect([...sentBytes!]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect([...validBytes]).toEqual([0, 0, 0, 0]);
    const bytes = new Uint8Array([4, 5, 6]);
    bridge.send({
      schemaVersion: 1,
      kind: "frame",
      captureId: "a".repeat(48),
      generation: 1,
      sourceWidth: 100,
      sourceHeight: 100,
      width: 100,
      height: 100,
      bytes,
      extra: true,
    });
    expect([...bytes]).toEqual([0, 0, 0]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});

describe("product capture preload", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.expose.mockReset();
    mocks.invoke.mockReset();
    mocks.removeListener.mockReset();
    mocks.listeners.clear();
  });

  it("forwards only exact safe capture events through one listener", async () => {
    await import("../../src/preload/index.js");
    const api = mocks.expose.mock.calls[0]![1];
    expect(Object.keys(api.capture)).toEqual([
      "status",
      "sources",
      "start",
      "pause",
      "resume",
      "stop",
      "subscribe",
    ]);
    const first = vi.fn();
    const firstUnsubscribe = api.capture.subscribe(first);
    const firstWrapped = mocks.listeners.get(IPC_CHANNELS.captureEvent)!;
    const second = vi.fn();
    const secondUnsubscribe = api.capture.subscribe(second);
    expect(mocks.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.captureEvent, firstWrapped);
    const wrapped = mocks.listeners.get(IPC_CHANNELS.captureEvent)!;
    wrapped(null, publicStateEvent());
    wrapped(null, publicFrameEvent());
    expect(second).toHaveBeenCalledTimes(2);
    wrapped(null, { ...publicFrameEvent(), nativeSourceId: "screen:0:0" });
    wrapped(null, { ...publicFrameEvent(), bytes: new Uint8Array([1, 2, 3]) });
    wrapped(null, {
      ...publicStateEvent(),
      value: { ...publicStateEvent().value, endpoint: "127.0.0.1" },
    });
    expect(second).toHaveBeenCalledTimes(2);
    firstUnsubscribe();
    secondUnsubscribe();
    secondUnsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.captureEvent, wrapped);
  });
});

describe("sandboxed capture worker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts once with video-only media and emits one bounded encode at a time", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const events: any[] = [];
    const senderArrays: Uint8Array[] = [];
    let frameReady!: () => void;
    const framePending = new Promise<void>((resolve) => {
      frameReady = resolve;
    });
    let configure: ((value: any) => void) | undefined;
    let ended: (() => void) | undefined;
    let resolveStream!: (value: unknown) => void;
    const streamPending = new Promise((resolve) => {
      resolveStream = resolve;
    });
    const track = {
      addEventListener: vi.fn((_name: string, listener: () => void) => {
        ended = listener;
      }),
      stop: vi.fn(),
    };
    const stream = {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    };
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: (blob: Blob) => void) => {
        callback(
          new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
            type: "image/jpeg",
          }),
        );
      }),
    };
    const video = {
      muted: false,
      playsInline: false,
      srcObject: null,
      videoWidth: 2560,
      videoHeight: 1440,
      play: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = {
      configure(listener: (value: any) => void) {
        configure = listener;
      },
      send(event: any) {
        if (event.kind === "frame") senderArrays.push(event.bytes);
        events.push(
          event.kind === "frame" ? { ...event, bytes: new Uint8Array(event.bytes) } : { ...event },
        );
        if (event.kind === "frame") frameReady();
      },
    };
    const workerWindow: any = { openminionCaptureBridge: bridge };
    const getDisplayMedia = vi.fn(() => streamPending);
    vi.stubGlobal("window", workerWindow);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal("document", {
      createElement: vi.fn((kind: string) => (kind === "video" ? video : canvas)),
    });

    await import("../../src/renderer/capture-worker.js");
    expect(events).toEqual([{ schemaVersion: 1, kind: "ready" }]);
    configure!({
      schemaVersion: 1,
      kind: "configure",
      captureId: "c".repeat(48),
      generation: 4,
      region: { xBps: 2500, yBps: 2500, widthBps: 5000, heightBps: 5000 },
      cadenceMs: 2000,
      maxWidth: 1920,
      maxHeight: 1080,
      jpegQuality: 0.8,
      maxBytes: 2_097_152,
    });
    expect(events.at(-1)).toMatchObject({ kind: "configured", generation: 4 });
    expect(workerWindow.openminionCaptureWorker.start()).toBe(true);
    expect(workerWindow.openminionCaptureWorker.start()).toBe(false);
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });

    resolveStream(stream);
    await framePending;
    expect(events.find((event) => event.kind === "stream_ready")).toMatchObject({
      sourceWidth: 2560,
      sourceHeight: 1440,
    });
    const frame = events.find((event) => event.kind === "frame");
    expect(frame).toMatchObject({
      width: 1280,
      height: 720,
      sourceWidth: 2560,
      sourceHeight: 1440,
    });
    expect([...frame.bytes]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect([...senderArrays[0]]).toEqual([0, 0, 0, 0]);
    expect(drawImage).toHaveBeenCalledWith(video, 640, 360, 1280, 720, 0, 0, 1280, 720);
    expect(canvas.toBlob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(canvas.toBlob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(canvas.toBlob).toHaveBeenCalledTimes(2);

    ended!();
    expect(events.at(-1)).toMatchObject({ kind: "ended", reason: "track_ended" });
    expect(track.stop).toHaveBeenCalled();
  });
});

function publicStateEvent() {
  return {
    schemaVersion: 1,
    kind: "state",
    value: {
      schemaVersion: 1,
      state: "observing",
      reason: "user_started",
      permission: "granted",
      captureId: "a".repeat(48),
      sessionId: "session-1",
      sourceKind: "display",
      parentSourceKind: "display",
      sourceLabel: "Display 1",
      scaleFactor: 2,
      startedAt: "2026-08-21T00:00:00Z",
      pausedAt: null,
      capturedFrames: 1,
      droppedFrames: 0,
      retainedBytes: 1024,
      lastFrameAt: "2026-08-21T00:00:01Z",
    },
  };
}

function publicFrameEvent() {
  return {
    schemaVersion: 1,
    kind: "frame",
    captureId: "a".repeat(48),
    frameId: "b".repeat(48),
    sessionId: "session-1",
    sourceKind: "display",
    parentSourceKind: "display",
    width: 1280,
    height: 720,
    scaleFactor: 2,
    capturedAt: "2026-08-21T00:00:01Z",
    expiresAt: "2026-08-21T00:00:31Z",
    contentHash: "c".repeat(64),
    encoding: "image/jpeg",
    sizeBytes: 1024,
    previewUrl: `openminion://app/capture/frames/${"b".repeat(48)}`,
  };
}
