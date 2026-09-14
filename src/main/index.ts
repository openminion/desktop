import type { DesktopStore } from "./desktop-store.js";
import { failure } from "./openminion-client.js";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  powerMonitor,
  screen,
  shell,
  session,
  systemPreferences,
  type DisplayMediaRequestHandlerHandlerRequest,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type PermissionRequest,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  CAPTURE_WORKER_CONFIG_CHANNEL,
  CAPTURE_WORKER_EVENT_CHANNEL,
  isCaptureWorkerEvent,
  type CaptureWorkerConfigV1,
} from "../shared/capture-worker.js";
import {
  IPC_CHANNELS,
  type CaptureStateV1,
  type ClientResult,
  type ObservationStatusV1,
  type TurnEventV1,
  type TurnSubmitInput,
  type TurnSubmitValue,
} from "../shared/contracts.js";
import { DaemonSupervisor } from "./backend-supervisor.js";
import {
  CaptureService,
  type CaptureNativeSource,
  type CapturePlatform,
  type CaptureWorkerController,
} from "./capture.js";
import { FileGrantService } from "./files.js";
import { MediaService } from "./media.js";
import { ObservationService } from "./observation.js";
import type { ObservationPreparedTurn } from "./observation.js";
import { registerAppProtocol, registerPrivilegedSchemes } from "./protocol.js";

registerPrivilegedSchemes();

export function registerIpcHandlers(
  supervisor: DaemonSupervisor,
  media = new MediaService(supervisor.client),
  files = new FileGrantService(supervisor.client, media),
  capture = new CaptureService(),
  observation = new ObservationService(capture, media),
  store?: DesktopStore,
): void {
  ipcMain.handle(IPC_CHANNELS.chatNamesLoad, (event, input: unknown) =>
    !isAppInvocation(event)
      ? forbiddenResult()
      : store
        ? store.load(input)
        : failure("storage_unavailable", "Desktop storage is unavailable."),
  );
  ipcMain.handle(IPC_CHANNELS.chatNamesSave, (event, input: unknown) =>
    !isAppInvocation(event)
      ? forbiddenResult()
      : store
        ? store.save(input)
        : failure("storage_unavailable", "Desktop storage is unavailable."),
  );
  const dispatchDesktopTurn = async (
    input: TurnSubmitInput,
    sourceFrame: WebFrameMain | null,
    sourceContents: WebContents | null = null,
    automaticPrepared: ObservationPreparedTurn | null = null,
    automaticDelivery: ((event: TurnEventV1) => boolean) | null = null,
  ): Promise<ClientResult<TurnSubmitValue>> => {
    const validated = supervisor.client.validateTurnSubmission(input);
    if (!validated.ok) return validated;
    const turnInput = validated.value.input;
    if (!automaticPrepared && turnInput.observation) {
      const validObservation = observation.validateManualTurn(turnInput);
      if (!validObservation.ok) return validObservation;
    }
    if (
      !automaticPrepared &&
      !(await observation.preemptAutomaticForManual(
        validated.value.sessionId,
        Boolean(turnInput.observation),
      ))
    ) {
      return sessionTurnActiveResult();
    }
    const prepared = automaticPrepared
      ? { ok: true as const, value: automaticPrepared }
      : turnInput.observation
        ? await observation.prepareManualTurn(turnInput)
        : null;
    if (prepared && !prepared.ok) return prepared;
    const submittedInput = prepared?.value.input ?? turnInput;
    const manualAdmission =
      !automaticPrepared && !turnInput.observation
        ? observation.beginManualTurn(validated.value.sessionId)
        : { admitted: true, token: null };
    if (!manualAdmission.admitted) return sessionTurnActiveResult();
    let manualTurn = manualAdmission.token;
    const settleManualTurn = () => {
      if (manualTurn === null) return;
      observation.endManualTurn(manualTurn);
      manualTurn = null;
    };
    try {
      await files.fenceSession(validated.value.sessionId, "session_turn_active");
      if (prepared?.ok) {
        const ready = observation.validatePreparedTurn(prepared.value);
        if (!ready.ok) return observation.settleSubmission(prepared.value, ready);
      }
      let deliveryActive = true;
      const result = await supervisor.client.submit(submittedInput, (turnEvent: TurnEventV1) => {
        if (turnEvent.kind === "done") settleManualTurn();
        const observationDelivery = prepared?.ok
          ? observation.acceptTurnEvent(prepared.value, turnEvent)
          : true;
        if (!deliveryActive) return;
        if (!observationDelivery) {
          deliveryActive = false;
          return;
        }
        if (automaticDelivery) {
          let delivered = false;
          try {
            delivered = automaticDelivery(turnEvent);
          } catch {
            delivered = false;
          }
          if (!delivered) {
            deliveryActive = false;
            void observation.close();
            return;
          }
        }
        if (!sourceFrame) return;
        if (sourceFrame.detached || sourceContents?.mainFrame !== sourceFrame) {
          deliveryActive = false;
          void observation.close();
          return;
        }
        try {
          sourceFrame.send(IPC_CHANNELS.turnEvent, turnEvent);
        } catch {
          deliveryActive = false;
          void observation.close();
        }
      });
      if (!result.ok) settleManualTurn();
      return prepared?.ok ? observation.settleSubmission(prepared.value, result) : result;
    } catch (error) {
      settleManualTurn();
      throw error;
    }
  };
  observation.connectTurnOwner({
    dispatch: (prepared, deliver) =>
      dispatchDesktopTurn(prepared.input, null, null, prepared, deliver),
    cancel: (input) => supervisor.client.cancel(input),
  });
  let observationFrame: WebFrameMain | null = null;
  const bindObservationFrame = async (event: IpcMainInvokeEvent): Promise<boolean> => {
    const sourceFrame = event.senderFrame;
    if (sourceFrame === null || !isAppInvocation(event)) return false;
    if (observationFrame !== null && observationFrame !== sourceFrame) {
      await observation.stop();
    }
    observationFrame = sourceFrame;
    const deliverStatus = (value: ObservationStatusV1): boolean => {
      if (sourceFrame.detached || event.sender.mainFrame !== sourceFrame) {
        if (observationFrame === sourceFrame) observationFrame = null;
        return false;
      }
      try {
        sourceFrame.send(IPC_CHANNELS.observationEvent, value);
        return true;
      } catch {
        if (observationFrame === sourceFrame) observationFrame = null;
        return false;
      }
    };
    const deliverTurn = (value: TurnEventV1): boolean => {
      if (sourceFrame.detached || event.sender.mainFrame !== sourceFrame) {
        if (observationFrame === sourceFrame) observationFrame = null;
        return false;
      }
      try {
        sourceFrame.send(IPC_CHANNELS.turnEvent, value);
        return true;
      } catch {
        if (observationFrame === sourceFrame) observationFrame = null;
        return false;
      }
    };
    observation.setListener(deliverStatus, deliverTurn);
    return true;
  };

  ipcMain.handle(IPC_CHANNELS.tasksControl, (event, input: unknown) =>
    isAppInvocation(event) ? supervisor.client.controlTasks(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.reportsRead, (event, input: unknown) =>
    isAppInvocation(event) ? supervisor.client.readReport(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.sessionsExport, async (event, input: unknown) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    const transcript = await supervisor.client.exportTranscript(input);
    if (!transcript.ok) return transcript;
    const selected = await dialog.showSaveDialog({
      title: "Export conversation",
      defaultPath: "conversation.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: true, value: { cancelled: true } };
    try {
      await writeFile(selected.filePath, transcript.value, { mode: 0o600 });
      return { ok: true, value: { cancelled: false } };
    } catch {
      return failure(
        "export_failed",
        "Could not save the conversation. Choose a writable location.",
      );
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.openLink,
    async (event, input: unknown): Promise<ClientResult<null>> => {
      if (!isAppInvocation(event)) return forbiddenResult();
      if (typeof input !== "string" || input.length > 8192)
        return failure("invalid_request", "Choose a web link.");
      try {
        const url = new URL(input);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          return failure(
            "invalid_request",
            "Only web links without embedded credentials can be opened.",
          );
        await shell.openExternal(url.href);
        return { ok: true, value: null };
      } catch {
        return failure("open_link_failed", "Could not open this link in your browser.");
      }
    },
  );
  ipcMain.handle(IPC_CHANNELS.copyText, (event, text: unknown): ClientResult<null> => {
    if (!isAppInvocation(event)) return forbiddenResult();
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: "Choose up to 1 MB of text to copy.",
          retryable: false,
          retryAfterMs: null,
        },
      };
    }
    clipboard.writeText(text);
    return { ok: true, value: null };
  });
  ipcMain.handle(IPC_CHANNELS.profilesRead, (event) =>
    isAppInvocation(event) ? supervisor.readProfiles() : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.profilesPresets, (event) =>
    isAppInvocation(event) ? supervisor.setupPresets() : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.profilesSetup, (event, input: unknown) =>
    isAppInvocation(event)
      ? supervisor.applyProfiles((profiles, executable) => profiles.setup(input, executable))
      : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.profilesSave, (event, input: unknown) =>
    isAppInvocation(event)
      ? supervisor.applyProfiles((profiles, executable) => profiles.save(input, executable))
      : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.profilesImport, async (event, input: unknown) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !("revision" in input) ||
      typeof input.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.revision)
    )
      return failure("invalid_request", "Reopen Settings before importing profiles.");
    const revision = input.revision;
    const selected = await dialog.showOpenDialog({
      title: "Import OpenMinion profiles and runtime keys",
      buttonLabel: "Import profiles",
      filters: [{ name: "OpenMinion JSON profiles", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (selected.canceled) return { ok: true, value: null };
    return supervisor.applyProfiles((profiles, executable) =>
      profiles.importFile(selected.filePaths[0], revision, executable),
    );
  });
  ipcMain.handle(IPC_CHANNELS.daemonStatus, () => supervisor.status());
  ipcMain.handle(IPC_CHANNELS.daemonRetry, () => supervisor.retry());
  ipcMain.handle(IPC_CHANNELS.sessionsList, (event, input) =>
    isAppInvocation(event) ? supervisor.client.list(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.sessionsCreate, async (event, input) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    const created = await supervisor.client.create(input);
    if (created.ok) {
      await observation.activateSession(created.value.sessionId);
      await files.activateSession(created.value.sessionId);
      await capture.activateSession(created.value.sessionId);
    }
    return created;
  });
  ipcMain.handle(IPC_CHANNELS.sessionsLoad, async (event, input) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    const loaded = await supervisor.client.load(input);
    if (loaded.ok) {
      await observation.activateSession(loaded.value.session.sessionId);
      await files.activateSession(loaded.value.session.sessionId);
      await capture.activateSession(loaded.value.session.sessionId);
    }
    return loaded;
  });
  ipcMain.handle(IPC_CHANNELS.sessionsClose, async (event, input) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    const validated = supervisor.client.validateSessionClose(input);
    if (!validated.ok) return validated;
    await observation.fenceSession(validated.value.sessionId);
    await capture.fenceSession(validated.value.sessionId, "session_closed");
    await files.fenceSession(validated.value.sessionId);
    return supervisor.client.close(input);
  });
  ipcMain.handle(IPC_CHANNELS.sessionsEvents, (event, input) =>
    isAppInvocation(event) ? supervisor.client.events(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.turnsCancel, (event, input) =>
    isAppInvocation(event) ? supervisor.client.cancel(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.approvalsDecide, (event, input) =>
    isAppInvocation(event) ? supervisor.client.decide(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.artifactsList, (event, input) =>
    isAppInvocation(event) ? supervisor.client.listArtifacts(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.artifactsRead, (event, input) =>
    isAppInvocation(event) ? supervisor.client.readArtifact(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.artifactsDetach, (event, input) =>
    isAppInvocation(event) ? supervisor.client.detachArtifact(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.artifactsRestore, (event, input) =>
    isAppInvocation(event) ? supervisor.client.restoreArtifact(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.filesPick, (event, input) =>
    isAppInvocation(event) ? files.pick(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.filesList, (event, input) =>
    isAppInvocation(event) ? files.list(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.filesImport, (event, input) =>
    isAppInvocation(event) ? files.import(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.filesRelease, (event, input) =>
    isAppInvocation(event) ? files.release(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.mediaPick, (event, input) =>
    isAppInvocation(event) ? media.pick(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.mediaRelease, (event, input) =>
    isAppInvocation(event) ? media.release(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.captureStatus, (event, input) =>
    isAppInvocation(event)
      ? input === undefined
        ? capture.status()
        : invalidRequestResult()
      : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.captureSources, (event, input) =>
    isAppInvocation(event) ? capture.sources(input) : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.captureStart, (event, input) => {
    const sourceFrame = event.senderFrame;
    if (sourceFrame === null || !isAppInvocation(event)) return forbiddenResult();
    return capture.start(input, (captureEvent) => {
      observation.acceptCaptureEvent(captureEvent);
      if (sourceFrame.detached) return false;
      try {
        sourceFrame.send(IPC_CHANNELS.captureEvent, captureEvent);
        return true;
      } catch {
        return false;
      }
    });
  });
  ipcMain.handle(IPC_CHANNELS.capturePause, async (event, input) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    if (input !== undefined) return invalidRequestResult();
    await observation.stop();
    return capture.pause();
  });
  ipcMain.handle(IPC_CHANNELS.captureResume, (event, input) =>
    isAppInvocation(event)
      ? input === undefined
        ? capture.resume()
        : invalidRequestResult()
      : forbiddenResult(),
  );
  ipcMain.handle(IPC_CHANNELS.captureStop, async (event, input) => {
    if (!isAppInvocation(event)) return forbiddenResult();
    if (input !== undefined) return invalidRequestResult();
    await observation.stop();
    return capture.stop();
  });
  ipcMain.handle(IPC_CHANNELS.observationStatus, async (event, input) => {
    if (!(await bindObservationFrame(event))) return forbiddenResult();
    return input === undefined ? observation.status() : invalidRequestResult();
  });
  ipcMain.handle(IPC_CHANNELS.observationConfigure, async (event, input) => {
    if (!(await bindObservationFrame(event))) return forbiddenResult();
    return observation.configure(input);
  });
  ipcMain.handle(IPC_CHANNELS.observationStop, async (event, input) => {
    if (!(await bindObservationFrame(event))) return forbiddenResult();
    return input === undefined ? observation.stop() : invalidRequestResult();
  });
  ipcMain.handle(IPC_CHANNELS.turnsSubmit, async (event, input) => {
    const sourceFrame = event.senderFrame;
    if (sourceFrame === null || !isAppInvocation(event)) {
      return forbiddenResult();
    }
    return dispatchDesktopTurn(input, sourceFrame, event.sender);
  });
}

function isAppInvocation(event: IpcMainInvokeEvent): boolean {
  return (
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === "openminion://app/"
  );
}

function forbiddenResult() {
  return {
    ok: false as const,
    error: {
      code: "forbidden",
      message: "Desktop request origin is not authorized.",
      retryable: false,
      retryAfterMs: null,
    },
  };
}

function invalidRequestResult() {
  return {
    ok: false as const,
    error: {
      code: "invalid_request",
      message: "Desktop request is invalid.",
      retryable: false,
      retryAfterMs: null,
    },
  };
}

function sessionTurnActiveResult() {
  return {
    ok: false as const,
    error: {
      code: "session_turn_active",
      message: "A turn is already active for this session.",
      retryable: true,
      retryAfterMs: null,
    },
  };
}

type PendingCaptureGrant = {
  captureId: string;
  generation: number;
  source: { id: string; name: string } | null;
  worker: BrowserWindow;
  armed: boolean;
  permissionSeen: boolean;
  displaySeen: boolean;
  admissionResolved: boolean;
  resolveAdmission: () => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
};

export class ElectronCapturePlatform implements CapturePlatform {
  readonly platform: NodeJS.Platform;
  #session: Session;
  #grant: PendingCaptureGrant | null = null;

  constructor(appSession: Session, platform: NodeJS.Platform = process.platform) {
    this.#session = appSession;
    this.platform = platform;
  }

  permission() {
    if (this.platform !== "darwin") return "unsupported" as const;
    const value = systemPreferences.getMediaAccessStatus("screen");
    return value === "not-determined" ? "not_determined" : value;
  }

  async sources(kind: "display" | "window", thumbnail: boolean): Promise<CaptureNativeSource[]> {
    const sources = await desktopCapturer.getSources({
      types: [kind === "display" ? "screen" : "window"],
      thumbnailSize: thumbnail ? { width: 480, height: 270 } : { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const displays = kind === "display" ? screen.getAllDisplays() : [];
    return sources.map((source) => ({
      nativeId: source.id,
      label: source.name,
      thumbnail: source.thumbnail,
      scaleFactor:
        kind === "display"
          ? (displays.find((display) => String(display.id) === source.display_id)?.scaleFactor ??
            null)
          : null,
      grantSource: { id: source.id, name: source.name },
    }));
  }

  async createWorker(
    input: {
      captureId: string;
      generation: number;
      nativeSourceId: string;
      grantSource: { id: string; name: string } | null;
    },
    onEvent: (event: unknown) => void,
  ): Promise<CaptureWorkerController> {
    if (!input.grantSource || input.grantSource.id !== input.nativeSourceId) {
      throw new Error("capture source grant is unavailable");
    }
    this.#clearGrant();
    const worker = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        session: this.#session,
        preload: join(import.meta.dirname, "../preload/capture.cjs"),
      },
    });
    worker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    worker.webContents.on("will-navigate", (event) => event.preventDefault());
    const expiresAt = performance.now() + 7_000;
    const timer = setTimeout(() => this.#clearGrant(input.captureId, input.generation), 7_000);
    timer.unref();
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    this.#grant = {
      captureId: input.captureId,
      generation: input.generation,
      source: input.grantSource,
      worker,
      armed: false,
      permissionSeen: false,
      displaySeen: false,
      admissionResolved: false,
      resolveAdmission,
      expiresAt,
      timer,
    };

    let stopped = false;
    let terminalSent = false;
    const workerUrl = "openminion://app/capture-worker.html";
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      this.#clearGrant(input.captureId, input.generation);
      ipcMain.removeListener(CAPTURE_WORKER_EVENT_CHANNEL, handler);
      if (!worker.isDestroyed()) worker.destroy();
    };
    const terminalFailure = () => {
      if (stopped || terminalSent) return;
      terminalSent = true;
      cleanup();
      onEvent({
        schemaVersion: 1,
        kind: "ended",
        captureId: input.captureId,
        generation: input.generation,
        reason: "worker_error",
      });
    };
    const handler = (event: IpcMainEvent, value: unknown) => {
      if (
        event.sender !== worker.webContents ||
        event.senderFrame !== worker.webContents.mainFrame ||
        event.senderFrame.url !== workerUrl
      ) {
        overwriteWorkerBytes(value);
        return;
      }
      if (
        isCaptureWorkerEvent(value) &&
        value.kind === "stream_ready" &&
        !this.#acceptStreamReady(input.captureId, input.generation)
      ) {
        terminalFailure();
        return;
      }
      onEvent(value);
    };
    ipcMain.on(CAPTURE_WORKER_EVENT_CHANNEL, handler);
    worker.webContents.on("render-process-gone", terminalFailure);
    worker.on("closed", terminalFailure);
    void worker.loadURL(workerUrl).catch(terminalFailure);

    const controller: CaptureWorkerController = {
      configure: (config: CaptureWorkerConfigV1) => {
        if (!stopped && !worker.isDestroyed()) {
          worker.webContents.send(CAPTURE_WORKER_CONFIG_CHANNEL, config);
        }
      },
      startWithGesture: async () => {
        if (stopped || worker.isDestroyed()) return false;
        if (!this.#armGrant(input.captureId, input.generation)) return false;
        return worker.webContents.executeJavaScript("window.openminionCaptureWorker.start()", true);
      },
      waitForAdmission: () => admission,
      stop: async () => {
        cleanup();
      },
    };
    return controller;
  }

  permissionRequest(
    webContents: WebContents,
    permission: string,
    details: PermissionRequest,
  ): boolean {
    const grant = this.#currentGrant();
    if (
      !grant?.armed ||
      permission !== "display-capture" ||
      grant.permissionSeen ||
      webContents !== grant.worker.webContents ||
      !details.isMainFrame ||
      details.requestingUrl !== "openminion://app/capture-worker.html"
    ) {
      return false;
    }
    grant.permissionSeen = true;
    this.#resolveAdmission(grant);
    return true;
  }

  displayRequest(request: DisplayMediaRequestHandlerHandlerRequest) {
    const grant = this.#currentGrant();
    if (
      !grant?.armed ||
      grant.displaySeen ||
      !grant.source ||
      request.frame !== grant.worker.webContents.mainFrame ||
      request.securityOrigin !== "openminion://app" ||
      !request.videoRequested ||
      request.audioRequested ||
      !request.userGesture
    ) {
      return {};
    }
    const source = grant.source;
    grant.source = null;
    grant.displaySeen = true;
    this.#resolveAdmission(grant);
    return { video: source };
  }

  #acceptStreamReady(captureId: string, generation: number): boolean {
    const grant = this.#currentGrant();
    if (
      !grant?.armed ||
      grant.captureId !== captureId ||
      grant.generation !== generation ||
      !grant.permissionSeen ||
      !grant.displaySeen
    ) {
      return false;
    }
    this.#clearGrant(captureId, generation);
    return true;
  }

  #armGrant(captureId: string, generation: number): boolean {
    const grant = this.#currentGrant();
    if (!grant || grant.armed || grant.captureId !== captureId || grant.generation !== generation) {
      return false;
    }
    clearTimeout(grant.timer);
    grant.armed = true;
    grant.expiresAt = performance.now() + 5_000;
    grant.timer = setTimeout(() => this.#clearGrant(captureId, generation), 5_000);
    grant.timer.unref();
    return true;
  }

  #resolveAdmission(grant: PendingCaptureGrant): void {
    if (grant.admissionResolved || !grant.permissionSeen || !grant.displaySeen) return;
    grant.admissionResolved = true;
    clearTimeout(grant.timer);
    grant.expiresAt = performance.now() + 5_000;
    grant.timer = setTimeout(() => this.#clearGrant(grant.captureId, grant.generation), 5_000);
    grant.timer.unref();
    grant.resolveAdmission();
  }

  #currentGrant(): PendingCaptureGrant | null {
    if (
      this.#grant &&
      this.#grant.expiresAt > performance.now() &&
      !this.#grant.worker.isDestroyed()
    ) {
      return this.#grant;
    }
    this.#clearGrant();
    return null;
  }

  #clearGrant(captureId?: string, generation?: number): void {
    if (
      !this.#grant ||
      (captureId !== undefined &&
        (this.#grant.captureId !== captureId || this.#grant.generation !== generation))
    ) {
      return;
    }
    clearTimeout(this.#grant.timer);
    this.#grant.source = null;
    this.#grant = null;
  }
}

export function secureSession(
  appSession: Session,
  capturePlatform?: Pick<ElectronCapturePlatform, "permissionRequest" | "displayRequest">,
): void {
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(capturePlatform?.permissionRequest(webContents, permission, details) ?? false);
  });
  appSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      callback(capturePlatform?.displayRequest(request) ?? {});
    },
    { useSystemPicker: false },
  );
}

export function secureWindow(window: BrowserWindow, rendererLost?: () => void): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
    rendererLost?.();
  });
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) rendererLost?.();
  });
  window.webContents.on("render-process-gone", () => rendererLost?.());
}

export async function createWindow(
  supervisor: DaemonSupervisor,
  appSession: Session,
  rendererLost?: () => void,
): Promise<BrowserWindow> {
  const icon = join(import.meta.dirname, "../renderer/logo.png");
  app.dock?.setIcon(icon);
  const window = new BrowserWindow({
    icon,
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#202020",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: appSession,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
    },
  });
  let loaded = false;
  secureWindow(window, () => {
    if (loaded) rendererLost?.();
  });
  await window.loadURL("openminion://app/");
  loaded = true;
  void supervisor.start();
  return window;
}

export async function launchDesktop(
  supervisor = createDesktopSupervisor(app.getPath("userData")),
  store?: DesktopStore,
): Promise<BrowserWindow> {
  const appSession = session.fromPartition("persist:openminion");
  const capturePlatform = new ElectronCapturePlatform(appSession);
  secureSession(appSession, capturePlatform);
  const media = new MediaService(supervisor.client);
  const files = new FileGrantService(supervisor.client, media);
  const capture = new CaptureService(capturePlatform);
  const observation = new ObservationService(capture, media);
  activeFileGrants = files;
  activeCapture = capture;
  activeObservation = observation;
  registerIpcHandlers(supervisor, media, files, capture, observation, store);
  registerAppProtocol(appSession, undefined, capture);
  let rendererCleanupStarted = false;
  const rendererLost = () => {
    if (rendererCleanupStarted) return;
    rendererCleanupStarted = true;
    void observation.close().then(async () => {
      await Promise.allSettled([files.close(), capture.close("renderer_lost")]);
    });
  };
  const window = await createWindow(supervisor, appSession, rendererLost);
  capture.setIndicator((state) => updateCaptureIndicator(window, state));
  const stopCapture = async (reason: CaptureStateV1["reason"]) => {
    await observation.stop();
    await capture.stop(reason);
  };
  const onLock = () => void stopCapture("screen_locked");
  const onSuspend = () => void stopCapture("system_suspended");
  const onDisplayChange = () => void stopCapture("display_changed");
  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("suspend", onSuspend);
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  window.on("closed", () => {
    capture.setIndicator(null);
    powerMonitor.removeListener("lock-screen", onLock);
    powerMonitor.removeListener("suspend", onSuspend);
    screen.removeListener("display-removed", onDisplayChange);
    screen.removeListener("display-metrics-changed", onDisplayChange);
    rendererLost();
  });
  return window;
}

function updateCaptureIndicator(window: BrowserWindow, state: CaptureStateV1): void {
  if (state.state === "stopping") return;
  if (state.state === "starting" || state.state === "observing") {
    window.setTitle("OpenMinion — Observing");
    app.dock?.setBadge("●");
    return;
  }
  if (state.state === "paused") {
    window.setTitle("OpenMinion — Observation paused");
    app.dock?.setBadge("Ⅱ");
    return;
  }
  window.setTitle("OpenMinion");
  app.dock?.setBadge("");
}

function overwriteWorkerBytes(value: unknown): void {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { bytes?: unknown }).bytes instanceof Uint8Array
  ) {
    (value as { bytes: Uint8Array }).bytes.fill(0);
  }
}

export function registerQuitLifecycle(
  appInstance: typeof app,
  supervisor: DaemonSupervisor,
  closeObservation: () => Promise<void> = () => activeObservation?.close() ?? Promise.resolve(),
  closeFiles: () => Promise<void> = () => activeFileGrants?.close() ?? Promise.resolve(),
  closeCapture: () => Promise<void> = () => activeCapture?.close("app_quit") ?? Promise.resolve(),
): void {
  let stopping = false;
  let readyToQuit = false;
  appInstance.on("before-quit", (event) => {
    if (readyToQuit) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    void closeObservation()
      .then(() => Promise.allSettled([closeFiles(), closeCapture()]))
      .then(() => supervisor.stop())
      .finally(() => {
        readyToQuit = true;
        appInstance.quit();
      });
  });
}

let activeFileGrants: FileGrantService | null = null;
let activeCapture: CaptureService | null = null;
let activeObservation: ObservationService | null = null;

export function createDesktopSupervisor(userDataRoot: string): DaemonSupervisor {
  return new DaemonSupervisor({
    runtimeRoot: join(userDataRoot, "runtime"),
    homeRoot: userDataRoot,
    dataRoot: join(userDataRoot, "data"),
    configPath: join(userDataRoot, "agents.json"),
    openminionExecutable: process.env.OPENMINION_EXECUTABLE,
  });
}
