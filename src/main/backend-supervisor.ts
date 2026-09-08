import type { DaemonStatus } from "../shared/contracts.js";
import { randomBytes } from "node:crypto";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { LifecycleState } from "./lifecycle-state.js";
import {
  OpenMinionInstallation,
  type OpenMinionInstallationOptions,
  type RunCommand,
  runCommand,
} from "./installation.js";
import { OpenMinionClient } from "./openminion-client.js";

export type DaemonSupervisorOptions = OpenMinionInstallationOptions & {
  commandTimeoutMs?: number;
  configPath?: string;
  homeRoot?: string;
  dataRoot?: string;
};

type DaemonCliStatus = {
  reachable: boolean;
};

export type OpenMinionCommandContext = {
  executable: string;
  args: readonly string[];
};

export class DaemonSupervisor {
  readonly lifecycle = new LifecycleState();
  readonly client = new OpenMinionClient(() => null);
  readonly #options: DaemonSupervisorOptions;
  readonly #installation: OpenMinionInstallation;
  readonly #runCommand: RunCommand;
  #executable: string | null = null;
  #daemonVersion: string | null = null;
  #errorCode: string | null = null;
  #daemonStarted = false;
  #startPromise: Promise<DaemonStatus> | null = null;
  #startAttempts = 0;

  constructor(options: DaemonSupervisorOptions) {
    this.#options = options;
    this.#runCommand = options.runCommand ?? runCommand;
    this.#installation = new OpenMinionInstallation(options);
  }

  get startAttempts(): number {
    return this.#startAttempts;
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
      if (!status.reachable) throw new Error("daemon_unavailable");
      this.#errorCode = null;
    } catch (error) {
      this.#errorCode = normalizeErrorCode(error, "daemon_status_failed");
      this.lifecycle.move("degraded");
    }
    return this.snapshot();
  }

  async retry(): Promise<DaemonStatus> {
    return this.lifecycle.current === "running" ? this.status() : this.start();
  }

  async stop(): Promise<{ stopped: boolean }> {
    if (this.lifecycle.current === "stopped") return { stopped: false };
    if (this.#startPromise) await this.#startPromise;
    if (this.lifecycle.current !== "stopping") this.lifecycle.move("stopping");

    let stopped = false;
    if (this.#daemonStarted && this.#executable) {
      const result = await this.#runOpenMinion(["daemon", "stop"]);
      stopped = result.exitCode === 0;
    }
    this.#daemonStarted = false;
    this.#errorCode = null;
    this.lifecycle.move("stopped");
    return { stopped };
  }

  snapshot(): DaemonStatus {
    return {
      state: this.lifecycle.current,
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
    this.#startAttempts += 1;
    this.lifecycle.move("probing");
    this.#errorCode = null;
    try {
      this.lifecycle.move("starting");
      const installed = await this.#installation.ensure();
      this.#executable = installed.path;
      this.#daemonVersion = installed.version;
      await this.#ensureConfig();

      const current = await this.#daemonStatus();
      if (!current.reachable) {
        const started = await this.#runOpenMinion(["daemon", "start"]);
        if (started.exitCode !== 0) throw new Error("daemon_start_failed");
      }
      const ready = await this.#daemonStatus();
      if (!ready.reachable) throw new Error("daemon_unavailable");

      this.#daemonStarted = true;
      this.lifecycle.move("running");
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
    return { reachable };
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
