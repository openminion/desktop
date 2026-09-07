import { app, BrowserWindow, session } from "electron";
import { join } from "node:path";
import { CaptureService } from "../../src/main/capture.js";
import { registerAppProtocol } from "../../src/main/protocol.js";
import type {
  CaptureCandidateV1,
  CaptureEventV1,
  CaptureFrameV1,
  ClientResult,
} from "../../src/shared/contracts.js";

const targetLabel = "OpenMinion Capture Fixture";
const sessionId = "native-capture-session";
const fixtureRoot = process.env.OPENMINION_ODC_NATIVE_ROOT;

if (!fixtureRoot) throw new Error("native fixture root is required");
app.setPath("userData", join(fixtureRoot, "electron"));

type CaptureFacts = {
  frames: number;
  dropped: number;
  retainedBytesPeak: number;
  width: number;
  height: number;
  cadenceMs: number;
  previewBytes: number;
};

type NativeRecord = {
  schemaVersion: 1;
  runtime: "electron-native-fixture";
  packagedArtifact: "verified_only";
  electronVersion: string;
  permission: "granted";
  targetLabel: typeof targetLabel;
  fullWindow: CaptureFacts;
  region: CaptureFacts;
  pause: { framesStable: true; retainedBytes: 0 };
  stop: { reason: "user_stopped"; retainedBytes: 0 };
  sourceClose: { reason: "source_ended"; retainedBytes: 0 };
  lockBoundary: { kind: "service_stop_reason"; reason: "screen_locked"; retainedBytes: 0 };
  indicatorStates: string[];
  cleanup: { active: boolean; retainedBytes: number };
};

void loadMainOwners()
  .then(async (owners) => {
    await app.whenReady();
    await run(owners);
  })
  .catch(fail);

async function run(owners: typeof import("../../src/main/index.js")): Promise<void> {
  const target = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    title: targetLabel,
    backgroundColor: "#14324a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await target.loadURL(fixtureUrl());
  target.show();

  const captureSession = session.fromPartition("persist:openminion-native-capture");
  const platform = new owners.ElectronCapturePlatform(captureSession);
  owners.secureSession(captureSession, platform);
  const capture = new CaptureService(platform);
  registerAppProtocol(captureSession, undefined, capture);
  const events: CaptureEventV1[] = [];
  const indicators: string[] = [];
  capture.setIndicator((state) => indicators.push(state.state));

  try {
    await capture.activateSession(sessionId);
    const permission = unwrap(capture.status()).permission;
    if (permission !== "granted") {
      throw new Error(`native capture permission is ${permission}`);
    }

    const fullWindow = await captureRun(capture, events, null);
    const beforePause = unwrap(await capture.pause());
    const pausedFrames = beforePause.capturedFrames;
    await delay(2_250);
    const afterPause = unwrap(capture.status());
    if (afterPause.capturedFrames !== pausedFrames || afterPause.retainedBytes !== 0) {
      throw new Error("pause retained or captured a frame");
    }
    unwrap(await capture.resume());
    await waitFor(() => unwrap(capture.status()).capturedFrames > pausedFrames, 6_000);
    const stopped = unwrap(await capture.stop());
    if (stopped.reason !== "user_stopped" || stopped.retainedBytes !== 0) {
      throw new Error("explicit stop did not purge capture state");
    }

    const region = await captureRun(capture, events, {
      xBps: 2500,
      yBps: 2500,
      widthBps: 5000,
      heightBps: 5000,
    });
    if (region.width >= fullWindow.width || region.height >= fullWindow.height) {
      throw new Error("native region was not smaller than the full window");
    }
    unwrap(await capture.stop());

    await captureRun(capture, events, null, false);
    const locked = unwrap(await capture.stop("screen_locked"));
    if (locked.reason !== "screen_locked" || locked.retainedBytes !== 0) {
      throw new Error("screen-lock boundary did not purge capture state");
    }

    await captureRun(capture, events, null, false);
    target.close();
    await waitFor(() => {
      const state = unwrap(capture.status());
      return state.state === "idle" && state.reason === "source_ended";
    }, 8_000);
    const sourceClosed = unwrap(capture.status());
    if (sourceClosed.retainedBytes !== 0) {
      throw new Error("source close retained frame bytes");
    }

    await capture.close();
    const cleanup = unwrap(capture.status());
    const record: NativeRecord = {
      schemaVersion: 1,
      runtime: "electron-native-fixture",
      packagedArtifact: "verified_only",
      electronVersion: process.versions.electron,
      permission: "granted",
      targetLabel,
      fullWindow,
      region,
      pause: { framesStable: true, retainedBytes: 0 },
      stop: { reason: "user_stopped", retainedBytes: 0 },
      sourceClose: { reason: "source_ended", retainedBytes: 0 },
      lockBoundary: {
        kind: "service_stop_reason",
        reason: "screen_locked",
        retainedBytes: 0,
      },
      indicatorStates: [...new Set(indicators)],
      cleanup: { active: cleanup.captureId !== null, retainedBytes: cleanup.retainedBytes },
    };
    if (record.cleanup.active || record.cleanup.retainedBytes !== 0) {
      throw new Error("native fixture cleanup was incomplete");
    }
    process.stdout.write(`${JSON.stringify(record)}\n`);
    app.quit();
  } finally {
    capture.setIndicator(null);
    await capture.close();
    if (!target.isDestroyed()) target.destroy();
  }
}

async function loadMainOwners(): Promise<typeof import("../../src/main/index.js")> {
  const realWhenReady = app.whenReady.bind(app);
  const heldReady = new Promise<void>(() => {});
  Object.defineProperty(app, "whenReady", {
    configurable: true,
    value: () => heldReady,
  });
  try {
    return await import("../../src/main/index.js");
  } finally {
    delete (app as unknown as { whenReady?: unknown }).whenReady;
    Object.defineProperty(app, "whenReady", {
      configurable: true,
      value: realWhenReady,
    });
  }
}

async function captureRun(
  capture: CaptureService,
  events: CaptureEventV1[],
  region: { xBps: number; yBps: number; widthBps: number; heightBps: number } | null,
  waitForCadence = true,
): Promise<CaptureFacts> {
  const candidate = await fixtureCandidate(capture);
  const startIndex = events.length;
  const started = unwrap(
    await capture.start({ sessionId, candidateId: candidate.candidateId, region }, (event) => {
      events.push(event);
      return true;
    }),
  );
  if (started.state !== "observing" || started.capturedFrames < 1) {
    throw new Error("native capture did not reach observing");
  }
  if (waitForCadence) {
    await waitFor(() => frameEvents(events, startIndex).length >= 2, 6_000);
  }
  const frames = frameEvents(events, startIndex);
  const first = frames[0];
  if (!first) throw new Error("native capture produced no frame");
  const preview = capture.preview("frames", first.frameId);
  if (!preview || preview.bytes.byteLength === 0) {
    throw new Error("native preview was unavailable");
  }
  const latest = unwrap(capture.status());
  return {
    frames: latest.capturedFrames,
    dropped: latest.droppedFrames,
    retainedBytesPeak: latest.retainedBytes,
    width: first.width,
    height: first.height,
    cadenceMs:
      frames.length > 1 ? Date.parse(frames[1]!.capturedAt) - Date.parse(first.capturedAt) : 0,
    previewBytes: preview.bytes.byteLength,
  };
}

async function fixtureCandidate(capture: CaptureService): Promise<CaptureCandidateV1> {
  const result = unwrap(await capture.sources({ sessionId, sourceKind: "window" }));
  const matches = result.candidates.filter((value) => value.label === targetLabel);
  if (matches.length !== 1) {
    throw new Error("dedicated synthetic target was not unique");
  }
  return matches[0]!;
}

function frameEvents(events: CaptureEventV1[], from: number): CaptureFrameV1[] {
  return events.slice(from).filter((event): event is CaptureFrameV1 => event.kind === "frame");
}

function unwrap<T>(result: ClientResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("native capture fixture timed out");
    await delay(50);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fixtureUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${targetLabel}</title>
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#14324a}
    body{display:grid;place-items:center;color:#fff;font:600 30px system-ui}
    main{padding:48px;border:8px solid #78dce8;background:#243b53}</style></head>
    <body><main>${targetLabel}</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : "native capture fixture failed";
  process.stderr.write(`native capture failed: ${message}\n`);
  app.exit(1);
}
