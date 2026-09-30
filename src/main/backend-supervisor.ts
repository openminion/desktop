import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type {
  ClientResult,
  DaemonStatus,
  RuntimeControlInput,
  RuntimeUpdateStatus,
} from "../shared/contracts.js";
import type {
  IdentityProfileView,
  IdentitySettings,
  IdentityValidation,
} from "../shared/identity.js";
import type { ProfileSettings } from "../shared/profiles.js";
import { CliClient } from "./cli-client.js";
import { IdentitySettingsService } from "./identity.js";
import {
  OpenMinionInstallation,
  type OpenMinionInstallationOptions,
  type RunCommand,
  runCommand,
} from "./installation.js";
import { LifecycleState } from "./lifecycle-state.js";
import { failure, failureFrom } from "./openminion-client.js";
import { Profiles } from "./profiles.js";
import {
  checkRuntimeManifest,
  desktopCompatible,
  type RuntimeOffer,
  runtimeOfferDigest,
} from "./runtime-manifest.js";

export type DaemonSupervisorOptions = OpenMinionInstallationOptions & {
  commandTimeoutMs?: number;
  configPath?: string;
  homeRoot?: string;
  dataRoot?: string;
  spawnDaemon?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  exclusiveRuntime?: boolean;
};

type DaemonCliStatus = {
  reachable: boolean;
  pid?: number | null;
  pid_alive?: boolean;
  lifecycle?: string;
  endpoint_status?: string;
  remote_config_path?: string;
  remote_data_root?: string;
};

export type OpenMinionCommandContext = {
  executable: string;
  args: readonly string[];
};

export class DaemonSupervisor {
  readonly profiles: Profiles | null;
  readonly identity: IdentitySettingsService | null;
  readonly lifecycle = new LifecycleState();
  readonly client: CliClient;
  readonly #options: DaemonSupervisorOptions;
  readonly #installation: OpenMinionInstallation;
  readonly #runCommand: RunCommand;
  #executable: string | null = null;
  #daemonVersion: string | null = null;
  #errorCode: string | null = null;
  #daemon: ChildProcess | null = null;
  #startPromise: Promise<DaemonStatus> | null = null;
  #startAttempts = 0;
  #installedVersion: string | null = null;
  #offer: RuntimeOffer | null = null;
  #updatePhase: RuntimeUpdateStatus["phase"] = "unchecked";
  #checkPromise: Promise<RuntimeUpdateStatus> | null = null;
  #checkController: AbortController | null = null;
  #stagePromise: Promise<ClientResult<RuntimeUpdateStatus>> | null = null;
  #stageController: AbortController | null = null;
  #controlPromise: Promise<ClientResult<RuntimeUpdateStatus>> | null = null;
  #controlController: AbortController | null = null;
  #closing = false;
  #updateTimer: ReturnType<typeof setInterval> | null = null;
  #chatConnected = false;

  constructor(options: DaemonSupervisorOptions) {
    this.#options = options;
    this.#runCommand = options.runCommand ?? runCommand;
    this.client = new CliClient(() => this.getCommandContext(), this.#runCommand);
    this.#installation = new OpenMinionInstallation(options);
    this.profiles =
      options.configPath && options.homeRoot && options.dataRoot
        ? new Profiles(options.configPath, options.homeRoot, options.dataRoot, this.#runCommand)
        : null;
    this.identity =
      options.configPath && options.homeRoot && options.dataRoot
        ? new IdentitySettingsService(
            options.configPath,
            options.homeRoot,
            options.dataRoot,
            this.#runCommand,
          )
        : null;
  }

  async readIdentity(): Promise<ClientResult<IdentitySettings>> {
    return this.#withIdentity((identity, executable) => identity.read(executable));
  }

  async verifyIdentity(input: unknown): Promise<ClientResult<IdentityValidation>> {
    return this.#withIdentity((identity, executable) => identity.verify(input, executable));
  }

  async saveIdentity(input: unknown): Promise<ClientResult<IdentityProfileView>> {
    return this.#withIdentity((identity, executable) => identity.save(input, executable));
  }

  async #withIdentity<T>(
    action: (identity: IdentitySettingsService, executable: string) => Promise<T>,
  ): Promise<ClientResult<T>> {
    if (!this.identity || !this.#executable)
      return failure(
        "identity_unavailable",
        "Connect to OpenMinion before opening identity settings.",
      );
    try {
      return { ok: true, value: await action(this.identity, this.#executable) };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async readProfiles(): Promise<ClientResult<ProfileSettings>> {
    if (!this.profiles) return failure("settings_unavailable", "Profile settings are unavailable.");
    try {
      return { ok: true, value: await this.profiles.read() };
    } catch {
      return failure(
        "settings_unavailable",
        "Could not load profiles. Connect to OpenMinion, then reopen Settings.",
      );
    }
  }

  async setupPresets() {
    if (!this.profiles || !this.#executable)
      return failure(
        "setup_unavailable",
        "Wait for OpenMinion to finish starting, then reopen Settings.",
      );
    try {
      return { ok: true as const, value: await this.profiles.presets(this.#executable) };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async applyProfiles(
    save: (profiles: Profiles, executable: string) => Promise<ProfileSettings>,
  ): Promise<ClientResult<{ settings: ProfileSettings; daemon: DaemonStatus }>> {
    if (!this.profiles || !this.#executable)
      return failure("settings_unavailable", "Connect to OpenMinion before editing profiles.");
    const ownedDaemon = this.#daemon;
    let canApply = false;
    try {
      const current = await this.#daemonStatus();
      const childStopped =
        !ownedDaemon || ownedDaemon.exitCode !== null || ownedDaemon.signalCode !== null;
      canApply = Boolean(
        (ownedDaemon && this.#owns(current, ownedDaemon)) ||
          (childStopped &&
            !current.reachable &&
            current.pid_alive === false &&
            current.lifecycle === "stopped" &&
            current.endpoint_status === "unreachable"),
      );
    } catch {
      canApply = false;
    }
    if (!canApply)
      return failure(
        "runtime_external",
        "This daemon is managed outside Desktop. Stop it before applying profile changes.",
      );
    if (this.#startPromise || !this.client.beginConfiguration())
      return failure("settings_busy", "Wait for running chats to finish before applying settings.");
    try {
      const settings = await save(this.profiles, this.#executable);
      const needsStop =
        this.#daemon !== null && this.#daemon.exitCode === null && this.#daemon.signalCode === null;
      const stopped = await this.stop();
      if (needsStop && !stopped.stopped)
        return failure(
          "settings_restart_failed",
          "Settings were saved, but OpenMinion could not stop. Restart Desktop to apply them.",
        );
      const daemon = await this.start();
      return { ok: true, value: { settings, daemon } };
    } catch (error) {
      return failureFrom(error);
    } finally {
      this.client.endConfiguration();
    }
  }

  get startAttempts(): number {
    return this.#startAttempts;
  }

  runtimeStatus(): RuntimeUpdateStatus {
    const state = this.#options.store?.runtimeState();
    const unmanaged = Boolean(this.#options.openminionExecutable);
    let phase = this.#updatePhase;
    if (
      (phase === "current" || phase === "unchecked") &&
      state?.active &&
      !desktopCompatible(
        this.#options.desktopVersion ?? "0.0.0",
        state.active.desktopMinVersion,
        state.active.desktopMaxVersionExclusive,
      )
    )
      phase = "incompatible";
    if (state?.pending) phase = "pending";
    if (state?.launchIntent) phase = "recovery_required";
    if (unmanaged) phase = "unmanaged";
    return {
      source: unmanaged ? "unmanaged" : (state?.active?.source ?? state?.source ?? "pypi"),
      selectedSource: state?.source ?? "pypi",
      installedVersion: this.#installedVersion,
      availableVersion: state?.pending?.version ?? this.#offer?.record.runtime_version ?? null,
      paused: state?.paused ?? false,
      pinnedVersion: state?.pin?.version ?? null,
      phase,
    };
  }

  checkRuntime(): Promise<RuntimeUpdateStatus> {
    if (this.#checkPromise) return this.#checkPromise;
    if (
      this.#closing ||
      this.#controlPromise ||
      this.#options.openminionExecutable ||
      !this.#options.store ||
      !this.#installedVersion ||
      this.#options.store.runtimeState().pending ||
      this.#options.store.runtimeState().launchIntent ||
      this.#stagePromise
    ) {
      return Promise.resolve(this.runtimeStatus());
    }
    this.#offer = null;
    this.#checkController = new AbortController();
    this.#updatePhase = "checking";
    const state = this.#options.store.runtimeState();
    this.#checkPromise = checkRuntimeManifest({
      source: state.source,
      desktopVersion: this.#options.desktopVersion ?? "0.0.0",
      installedVersion: this.#installedVersion,
      installedDigest: state.active?.sha256,
      pin: state.pin,
      signal: this.#checkController.signal,
    })
      .then((offer) => {
        this.#offer = offer;
        this.#updatePhase = offer ? "available" : "current";
        return this.runtimeStatus();
      })
      .catch(() => {
        // Network/metadata failures do not affect the active installation or replay work.
        this.#updatePhase = "check_failed";
        return this.runtimeStatus();
      })
      .finally(() => {
        this.#checkPromise = null;
        this.#checkController = null;
      });
    return this.#checkPromise;
  }

  stageRuntime(): Promise<ClientResult<RuntimeUpdateStatus>> {
    if (this.#stagePromise) return this.#stagePromise;
    if (this.#options.store?.runtimeState().paused)
      return Promise.resolve(
        failure("runtime_updates_paused", "Resume upgrades before preparing an update."),
      );
    if (!this.#options.exclusiveRuntime) {
      return Promise.resolve(
        failure(
          "runtime_shared_roots",
          "Runtime updates require Desktop's private installation. This adopted runtime must be updated outside Desktop.",
        ),
      );
    }
    if (
      this.#closing ||
      this.#controlPromise ||
      !this.#offer ||
      this.#checkPromise ||
      this.#options.openminionExecutable ||
      this.#options.store?.runtimeState().pending
    ) {
      return Promise.resolve(
        failure("runtime_candidate_unavailable", "Check for a compatible update first."),
      );
    }
    this.#updatePhase = "staging";
    this.#stageController = new AbortController();
    this.#stagePromise = this.#installation
      .stage(this.#offer, this.#stageController.signal)
      .then(() => {
        this.#offer = null;
        return { ok: true as const, value: this.runtimeStatus() };
      })
      .catch(() => {
        this.#updatePhase = "available";
        return failure(
          "runtime_stage_failed",
          "The update could not be prepared. Your current runtime is unchanged.",
        );
      })
      .finally(() => {
        this.#stagePromise = null;
        this.#stageController = null;
      });
    return this.#stagePromise;
  }

  controlRuntime(input: unknown): Promise<ClientResult<RuntimeUpdateStatus>> {
    if (this.#controlPromise || this.#startPromise || this.#closing)
      return Promise.resolve(failure("runtime_busy", "Wait for the current runtime operation."));
    if (!input || typeof input !== "object" || Array.isArray(input))
      return Promise.resolve(failure("invalid_input", "Invalid runtime control."));
    const value = input as Record<string, unknown>;
    if (
      !Object.keys(value).every(
        (key) =>
          key === "action" ||
          (value.action === "pin" && key === "version") ||
          (value.action === "source" && key === "source"),
      ) ||
      typeof value.action !== "string" ||
      !["pause", "resume", "discard", "unpin", "pin-installed", "pin", "source"].includes(
        value.action,
      ) ||
      (value.action === "pin" &&
        (typeof value.version !== "string" ||
          !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version))) ||
      (value.action === "source" && !["pypi", "binary"].includes(String(value.source)))
    )
      return Promise.resolve(failure("invalid_input", "Choose a supported runtime control."));
    if (
      !this.#options.store ||
      this.#options.openminionExecutable ||
      !this.#options.exclusiveRuntime
    )
      return Promise.resolve(
        failure("runtime_unmanaged", "Runtime controls require Desktop's private installation."),
      );
    this.#controlController = new AbortController();
    this.#controlPromise = this.#controlRuntime(value as RuntimeControlInput)
      .catch(() =>
        failure(
          "runtime_control_failed",
          "The runtime control could not be applied. No runtime was launched.",
        ),
      )
      .finally(() => {
        this.#controlPromise = null;
        this.#controlController = null;
      });
    return this.#controlPromise;
  }

  async #controlRuntime(input: RuntimeControlInput): Promise<ClientResult<RuntimeUpdateStatus>> {
    const store = this.#options.store!;
    const state = store.runtimeState();
    if (state.launchIntent)
      return failure(
        "runtime_recovery_required",
        "Recovery needs review before changing runtime policy.",
      );
    if (input.action === "source" && state.pending)
      return failure(
        "runtime_candidate_pending",
        "Discard the prepared update before changing its source.",
      );
    if (input.action === "source" && state.pin && state.pin.source !== input.source)
      return failure(
        "runtime_pin_source_mismatch",
        "Remove the exact runtime pin before changing its source.",
      );
    if (input.action === "pause" || input.action === "discard") {
      if (input.action === "pause") store.setRuntimePolicy(true, state.pin);
      this.#stageController?.abort();
      if (this.#stagePromise) await this.#stagePromise;
      if (this.#closing) return failure("runtime_busy", "Desktop is closing.");
      if (input.action === "discard") store.discardRuntime();
    } else {
      if (this.#stagePromise)
        return failure("runtime_busy", "Finish or discard preparation before changing the pin.");
      this.#checkController?.abort();
      if (this.#checkPromise) await this.#checkPromise;
      if (this.#closing) return failure("runtime_busy", "Desktop is closing.");
      if (input.action === "resume") store.setRuntimePolicy(false, state.pin);
      else if (input.action === "unpin") store.setRuntimePolicy(state.paused, null);
      else if (input.action === "source") store.setRuntimeSource(input.source);
      else if (input.action === "pin-installed") {
        if (!state.active)
          return failure(
            "runtime_identity_unverified",
            "This legacy installation has no verified artifact identity. Use a developer executable or pin a published candidate.",
          );
        store.setRuntimePolicy(state.paused, {
          source: state.active.source,
          version: state.active.version,
          manifestUrl: state.active.manifestUrl,
          sha256: state.active.sha256,
        });
      } else if (input.action === "pin") {
        if (!this.#installedVersion)
          return failure(
            "runtime_unavailable",
            "Connect the installed runtime before selecting a pin.",
          );
        const offer = await checkRuntimeManifest({
          source: state.source,
          desktopVersion: this.#options.desktopVersion ?? "0.0.0",
          installedVersion: this.#installedVersion,
          targetVersion: input.version,
          includeInstalled: true,
          signal: this.#controlController!.signal,
        });
        if (this.#closing || this.#controlController!.signal.aborted)
          return failure("runtime_busy", "Desktop is closing.");
        if (!offer)
          return failure(
            "runtime_pin_unavailable",
            "That exact compatible published runtime is unavailable. No fallback or downgrade was selected.",
          );
        store.setRuntimePolicy(state.paused, {
          source: offer.record.distribution,
          version: offer.record.runtime_version,
          manifestUrl: offer.reference.manifest_url,
          sha256: runtimeOfferDigest(offer),
        });
      }
    }
    this.#offer = null;
    this.#updatePhase = "unchecked";
    return { ok: true, value: this.runtimeStatus() };
  }

  startUpdateChecks(): void {
    if (
      this.#closing ||
      !this.#options.store ||
      this.#options.openminionExecutable ||
      this.#updateTimer
    )
      return;
    void this.checkRuntime();
    this.#updateTimer = setInterval(
      () => {
        void this.checkRuntime();
      },
      24 * 60 * 60_000,
    );
    this.#updateTimer.unref();
  }

  async start(): Promise<DaemonStatus> {
    if (this.lifecycle.current === "running") return this.status();
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async status(): Promise<DaemonStatus> {
    if (this.lifecycle.current !== "running" || !this.#executable) return this.snapshot();
    try {
      const status = await this.#daemonStatus();
      const slowHealthProbe =
        !status.reachable &&
        status.pid_alive === true &&
        status.lifecycle === "running" &&
        status.endpoint_status === "unreachable";
      if (!status.reachable && !slowHealthProbe) throw new Error("daemon_unavailable");
      if (
        this.#daemon &&
        !(status.reachable ? this.#owns(status, this.#daemon) : status.pid === this.#daemon.pid)
      )
        throw new Error("daemon_ownership_unverified");
      this.#chatConnected = (await this.client.list({ limit: 1 })).ok;
      if (!status.reachable && !this.#chatConnected) throw new Error("daemon_unavailable");
      this.#errorCode = null;
    } catch (error) {
      this.#errorCode = normalizeErrorCode(error, "daemon_status_failed");
      this.lifecycle.move("degraded");
    }
    return this.snapshot();
  }

  async inspect(kind: unknown): Promise<ClientResult<{ text: string }>> {
    if (kind !== "status" && kind !== "logs")
      return failure("invalid_request", "Choose daemon status or logs.");
    if (!this.#executable)
      return failure(
        "runtime_unavailable",
        "OpenMinion is not installed yet. Check the connection details.",
      );
    try {
      const result = await this.#runOpenMinion([
        "daemon",
        kind,
        ...(kind === "logs" ? ["--lines", "200"] : []),
      ]);
      if (result.exitCode !== 0 && !(kind === "status" && result.exitCode === 1))
        return failure(
          "diagnostics_unavailable",
          "Could not read daemon diagnostics. The log may not exist yet; try Refresh after reconnecting.",
        );
      return { ok: true, value: { text: result.stdout.trim() || "No entries reported." } };
    } catch {
      return failure("diagnostics_unavailable", "Could not read daemon diagnostics. Try Refresh.");
    }
  }

  async retry(): Promise<DaemonStatus> {
    return this.lifecycle.current === "running" ? this.status() : this.start();
  }

  async stop(shutdown = false): Promise<{ stopped: boolean }> {
    if (shutdown) {
      this.#closing = true;
      if (this.#updateTimer) clearInterval(this.#updateTimer);
      this.#updateTimer = null;
      this.#checkController?.abort();
      this.#stageController?.abort();
      this.#controlController?.abort();
      if (this.#checkPromise) await this.#checkPromise;
      if (this.#stagePromise) await this.#stagePromise;
      if (this.#controlPromise) await this.#controlPromise;
    }
    if (this.lifecycle.current === "stopped") return { stopped: false };
    if (this.#startPromise) await this.#startPromise;
    if (this.lifecycle.current !== "stopping") this.lifecycle.move("stopping");

    let stopped = false;
    const daemon = this.#daemon;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      let current: DaemonCliStatus;
      try {
        current = await this.#daemonStatus();
      } catch {
        this.#errorCode = "daemon_ownership_unverified";
        this.lifecycle.move("degraded");
        return { stopped: false };
      }
      if (!this.#owns(current, daemon)) {
        this.#errorCode = "daemon_ownership_unverified";
        this.lifecycle.move("degraded");
        return { stopped: false };
      }
      stopped = await new Promise<boolean>((resolve) => {
        const exited = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          daemon.removeListener("exit", exited);
          resolve(false);
        }, 10_000);
        daemon.once("exit", exited);
        if (!daemon.kill("SIGTERM")) {
          clearTimeout(timer);
          daemon.removeListener("exit", exited);
          resolve(false);
        }
      });
      if (!stopped) {
        this.#errorCode = "daemon_stop_failed";
        this.lifecycle.move("degraded");
        return { stopped: false };
      }
    }
    this.#daemon = null;
    this.#chatConnected = false;
    this.#errorCode = null;
    this.lifecycle.move("stopped");
    return { stopped };
  }

  snapshot(): DaemonStatus {
    return {
      state:
        this.lifecycle.current === "running" && this.#chatConnected
          ? "ready"
          : this.lifecycle.current,
      reachable: this.lifecycle.current === "running",
      daemonVersion: this.#daemonVersion,
      protocol: null,
      configId: null,
      capabilities: [],
      errorCode: this.#errorCode,
    };
  }

  getCommandContext(): OpenMinionCommandContext | null {
    if (this.lifecycle.current !== "running" || !this.#executable) return null;
    return { executable: this.#executable, args: rootArguments(this.#options) };
  }

  async #start(): Promise<DaemonStatus> {
    if (this.#controlPromise) await this.#controlPromise;
    const startupActivationAllowed = this.#startAttempts === 0;
    this.#startAttempts += 1;
    this.lifecycle.move("probing");
    this.#errorCode = null;
    try {
      this.lifecycle.move("starting");
      let installed = await this.#installation.ensure();
      this.#executable = installed.path;
      this.#installedVersion = installed.version;
      // Public status currently does not report the running runtime version.
      this.#daemonVersion = null;
      const state = this.#options.store?.runtimeState();
      const compatible = (runtime: NonNullable<typeof state>["active"]) =>
        !runtime ||
        desktopCompatible(
          this.#options.desktopVersion ?? "0.0.0",
          runtime.desktopMinVersion,
          runtime.desktopMaxVersionExclusive,
        );
      const activeCompatible = compatible(state?.active ?? null);
      const canActivate = Boolean(
        state?.pending &&
          startupActivationAllowed &&
          this.#options.exclusiveRuntime &&
          !this.#options.openminionExecutable &&
          this.#options.store!.runtimeAllowed(state.pending) &&
          compatible(state.pending),
      );
      if (!activeCompatible && !canActivate) throw new Error("runtime_incompatible");
      if (
        !activeCompatible &&
        (!this.#options.configPath || !(await pathExists(this.#options.configPath)))
      )
        throw new Error("runtime_incompatible");
      await this.#ensureConfig();

      const current = await this.#daemonStatus();
      if (!activeCompatible && current.reachable) throw new Error("runtime_incompatible");
      if (
        !current.reachable &&
        current.pid_alive === true &&
        current.lifecycle === "running" &&
        current.endpoint_status === "unreachable"
      ) {
        this.lifecycle.move("running");
        this.#chatConnected = (await this.client.list({ limit: 1 })).ok;
        if (this.#chatConnected) return this.snapshot();
        throw new Error("daemon_ownership_unverified");
      }
      let launchingUpdate = false;
      if (!current.reachable) {
        if (
          current.pid_alive !== false ||
          current.lifecycle !== "stopped" ||
          current.endpoint_status !== "unreachable"
        )
          throw new Error("daemon_ownership_unverified");
        if (!this.#options.configPath || !this.#options.homeRoot || !this.#options.dataRoot)
          throw new Error("daemon_roots_unavailable");
        const store = this.#options.store;
        const pending = store?.runtimeState().pending;
        if (store && pending && canActivate) {
          // Persist BEFORE the candidate executes against live configuration or data.
          const candidate = store.beginRuntimeLaunch();
          installed = { path: candidate.executable, version: candidate.version };
          this.#executable = candidate.executable;
          launchingUpdate = true;
        }
        const executable = join(
          dirname(installed.path),
          process.platform === "win32" ? "openminiond.exe" : "openminiond",
        );
        const daemon = (this.#options.spawnDaemon ?? spawn)(
          executable,
          ["serve", "--config", this.#options.configPath],
          {
            shell: false,
            stdio: "ignore",
            env: {
              ...process.env,
              OPENMINION_HOME: this.#options.homeRoot,
              OPENMINION_DATA_ROOT: this.#options.dataRoot,
            },
          },
        );
        this.#daemon = daemon;
        let spawnError = false;
        daemon.once("error", () => {
          spawnError = true;
        });
        const deadline = Date.now() + 10_000;
        while (true) {
          const ready = await this.#daemonStatus();
          if (ready.reachable && this.#owns(ready, daemon)) break;
          if (
            spawnError ||
            daemon.exitCode !== null ||
            daemon.signalCode !== null ||
            Date.now() >= deadline
          )
            throw new Error("daemon_start_failed");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const ready = await this.#daemonStatus();
      if (!ready.reachable) throw new Error("daemon_unavailable");
      if (this.#daemon && !this.#owns(ready, this.#daemon))
        throw new Error("daemon_ownership_unverified");

      this.lifecycle.move("running");
      // A completed, schema-validated public request proves the chat transport;
      // reachability alone does not fabricate runtime version/capabilities.
      this.#chatConnected = (await this.client.list({})).ok;
      if (launchingUpdate) {
        if (!this.#chatConnected) throw new Error("runtime_health_failed");
        this.#options.store!.completeRuntimeLaunch();
        this.#installedVersion = installed.version;
      }
    } catch (error) {
      this.#errorCode = normalizeErrorCode(error, "daemon_start_failed");
      if (this.lifecycle.current !== "degraded") this.lifecycle.move("degraded");
    }
    return this.snapshot();
  }

  async #daemonStatus(): Promise<DaemonCliStatus> {
    const result = await this.#runOpenMinion(["daemon", "status", "--json"]);
    if (!result.stdout.trim()) throw new Error("invalid_daemon_status");
    const payload: unknown = JSON.parse(result.stdout);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid_daemon_status");
    }
    const reachable = (payload as Record<string, unknown>).reachable;
    if (typeof reachable !== "boolean" || result.exitCode !== (reachable ? 0 : 1)) {
      throw new Error("invalid_daemon_status");
    }
    return payload as DaemonCliStatus;
  }

  #owns(status: DaemonCliStatus, daemon: ChildProcess): boolean {
    if (!this.#options.configPath || !this.#options.dataRoot) return false;
    try {
      return (
        daemon.exitCode === null &&
        daemon.signalCode === null &&
        daemon.pid !== undefined &&
        status.pid === daemon.pid &&
        status.pid_alive === true &&
        status.remote_config_path === realpathSync(this.#options.configPath) &&
        status.remote_data_root === realpathSync(this.#options.dataRoot)
      );
    } catch {
      return false;
    }
  }

  async #ensureConfig(): Promise<void> {
    if (!this.#options.configPath || (await pathExists(this.#options.configPath))) return;
    const initialized = await this.#runOpenMinion(["config", "init", "--provider", "echo"]);
    if (initialized.exitCode !== 0 || !(await pathExists(this.#options.configPath))) {
      throw new Error("config_initialization_failed");
    }
    await configureInitialDaemon(this.#options.configPath);
  }

  #runOpenMinion(args: readonly string[]) {
    if (!this.#executable) throw new Error("openminion_executable_unavailable");
    return this.#runCommand(
      this.#executable,
      [...rootArguments(this.#options), ...args],
      this.#options.commandTimeoutMs ?? 30_000,
    );
  }
}

function rootArguments(options: DaemonSupervisorOptions): string[] {
  const args: string[] = [];
  if (options.homeRoot) args.push("--home-root", options.homeRoot);
  if (options.dataRoot) args.push("--data-root", options.dataRoot);
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function normalizeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof SyntaxError) return "invalid_daemon_status";
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) return error.message;
  return fallback;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function configureInitialDaemon(configPath: string): Promise<void> {
  const payload: unknown = JSON.parse(await readFile(configPath, "utf-8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("config_initialization_failed");
  }
  const config = payload as Record<string, unknown>;
  const runtime =
    config.runtime && typeof config.runtime === "object" && !Array.isArray(config.runtime)
      ? (config.runtime as Record<string, unknown>)
      : {};
  config.runtime = {
    ...runtime,
    ipc_host: "127.0.0.1",
    ipc_port: await availablePort(),
    ipc_token: randomBytes(32).toString("base64url"),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await chmod(configPath, 0o600);
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("config_initialization_failed"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
