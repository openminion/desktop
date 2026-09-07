import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { DaemonStatus, DesktopClientReady } from "../shared/contracts.js";
import { DESKTOP_CAPABILITIES } from "../shared/contracts.js";
import { LifecycleState } from "./lifecycle-state.js";
import { OpenMinionClient } from "./openminion-client.js";
import { clientHeaders, publicStatus, validateReadiness } from "./security.js";

const MAX_READINESS_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024;

export type DaemonSupervisorOptions = {
  openminionExecutable?: string;
  startupTimeoutMs?: number;
  configPath?: string;
  homeRoot?: string;
  dataRoot?: string;
};

export class DaemonSupervisor {
  readonly lifecycle = new LifecycleState();
  readonly client: OpenMinionClient;
  readonly #options: DaemonSupervisorOptions;
  #readiness: DesktopClientReady | null = null;
  #capabilities: string[] = [];
  #errorCode: string | null = null;
  #bootstrapChild: ChildProcess | null = null;
  #startPromise: Promise<DaemonStatus> | null = null;
  #renewalTimer: NodeJS.Timeout | null = null;
  #recoveryUsed = false;
  #bootstrapAttempts = 0;

  constructor(options: DaemonSupervisorOptions = {}) {
    this.#options = options;
    this.client = new OpenMinionClient(() => this.#readiness);
  }

  get bootstrapAttempts(): number {
    return this.#bootstrapAttempts;
  }

  async start(): Promise<DaemonStatus> {
    if (this.lifecycle.current === "ready") {
      return this.snapshot();
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }
    this.#startPromise = this.#bootstrap().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async status(): Promise<DaemonStatus> {
    if (this.lifecycle.current !== "ready" || !this.#readiness) {
      return this.snapshot();
    }
    try {
      await fetchHealth(this.#readiness);
      this.#errorCode = null;
      this.#recoveryUsed = false;
    } catch {
      await this.#recoverOnce("daemon_unavailable");
    }
    return this.snapshot();
  }

  async retry(): Promise<DaemonStatus> {
    if (this.lifecycle.current === "ready") {
      return this.status();
    }
    this.#recoveryUsed = false;
    return this.start();
  }

  async stop(): Promise<{ revoked: boolean }> {
    this.#clearRenewal();
    if (this.lifecycle.current === "stopped") {
      return { revoked: false };
    }
    if (this.lifecycle.current !== "stopping") {
      this.lifecycle.move("stopping");
    }
    if (this.#bootstrapChild) {
      this.#bootstrapChild.kill("SIGTERM");
      this.#bootstrapChild = null;
    }
    if (this.#startPromise) {
      await this.#startPromise;
      if (this.lifecycle.current !== "stopping") {
        this.lifecycle.move("stopping");
      }
    }
    let revoked = false;
    if (this.#readiness) {
      try {
        await revokeLease(this.#readiness);
        revoked = true;
      } catch {
        // Lease expiry is the bounded fallback; the daemon remains persistent.
      }
    }
    this.#readiness = null;
    this.#capabilities = [];
    this.#errorCode = null;
    this.lifecycle.move("stopped");
    return { revoked };
  }

  snapshot(): DaemonStatus {
    return publicStatus(
      this.lifecycle.current,
      this.#readiness,
      this.#capabilities,
      this.#errorCode,
    );
  }

  async #bootstrap(): Promise<DaemonStatus> {
    this.#bootstrapAttempts += 1;
    this.lifecycle.move("probing");
    this.#errorCode = null;
    const child = spawn(
      this.#options.openminionExecutable ?? "openminion",
      bootstrapArguments(this.#options),
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    this.#bootstrapChild = child;
    this.lifecycle.move("leasing");
    try {
      const [readinessBytes, stdout, stderr, exitCode] = await withTimeout(
        Promise.all([
          collectBounded(child.stdio[3] as Readable | null, MAX_READINESS_BYTES),
          collectBounded(child.stdout, MAX_HELPER_OUTPUT_BYTES),
          collectBounded(child.stderr, MAX_HELPER_OUTPUT_BYTES),
          childExitCode(child),
        ]),
        this.#options.startupTimeoutMs ?? 15_000,
        () => child.kill("SIGTERM"),
      );
      if (exitCode !== 0) {
        throw new Error(bootstrapErrorCode(stderr));
      }
      if (stdout.length !== 0 || stderr.length !== 0) {
        throw new Error("unexpected_bootstrap_output");
      }
      const readiness = parseReadinessRecord(readinessBytes);
      const capabilities = await fetchCapabilities(readiness);
      this.#readiness = readiness;
      this.#capabilities = capabilities;
      this.lifecycle.move("ready");
      this.#scheduleRenewal();
      return this.snapshot();
    } catch (error) {
      child.kill("SIGTERM");
      this.#readiness = null;
      this.#capabilities = [];
      this.#errorCode = normalizedErrorCode(error);
      if (this.lifecycle.current !== "degraded") {
        this.lifecycle.move("degraded");
      }
      return this.snapshot();
    } finally {
      this.#bootstrapChild = null;
    }
  }

  async #recoverOnce(errorCode: string): Promise<void> {
    this.#errorCode = errorCode;
    if (this.lifecycle.current !== "degraded") {
      this.lifecycle.move("degraded");
    }
    if (this.#recoveryUsed) {
      return;
    }
    this.#recoveryUsed = true;
    this.#clearRenewal();
    this.#readiness = null;
    this.#capabilities = [];
    await this.start();
  }

  #scheduleRenewal(): void {
    this.#clearRenewal();
    if (!this.#readiness) {
      return;
    }
    const renewInMs = Math.min(
      2_147_483_647,
      Math.max(1_000, Date.parse(this.#readiness.expires_at) - Date.now() - 60_000),
    );
    this.#renewalTimer = setTimeout(() => {
      void this.#renew().catch(() => this.#recoverOnce("lease_renewal_failed"));
    }, renewInMs);
    this.#renewalTimer.unref();
  }

  async #renew(): Promise<void> {
    if (!this.#readiness) {
      return;
    }
    const expiresAt = await renewLease(this.#readiness, this.#capabilities);
    this.#readiness = { ...this.#readiness, expires_at: expiresAt };
    this.#scheduleRenewal();
  }

  #clearRenewal(): void {
    if (this.#renewalTimer) {
      clearTimeout(this.#renewalTimer);
      this.#renewalTimer = null;
    }
  }
}

function bootstrapArguments(options: DaemonSupervisorOptions): string[] {
  const args: string[] = [];
  if (options.homeRoot) {
    args.push("--home-root", options.homeRoot);
  }
  if (options.dataRoot) {
    args.push("--data-root", options.dataRoot);
  }
  if (options.configPath) {
    args.push("--config", options.configPath);
  }
  args.push("daemon", "desktop-bootstrap", "--fd", "3");
  return args;
}

function collectBounded(stream: Readable | null, limit: number): Promise<Buffer> {
  if (!stream) {
    return Promise.reject(new Error("bootstrap_pipe_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.length;
      if (total > limit) {
        stream.destroy();
        reject(new Error("bootstrap_output_too_large"));
        return;
      }
      chunks.push(value);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function childExitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("bootstrap_timeout"));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseReadinessRecord(value: Buffer): DesktopClientReady {
  const text = value.toString("utf-8");
  const lines = text.split("\n");
  if (lines.length !== 2 || lines[0].length === 0 || lines[1] !== "") {
    throw new Error("malformed_readiness_record");
  }
  return validateReadiness(JSON.parse(lines[0]));
}

function bootstrapErrorCode(stderr: Buffer): string {
  const match = stderr.toString("utf-8").match(/^desktop bootstrap failed: ([a-z0-9_]+)\s*$/);
  return match?.[1] ?? "daemon_bootstrap_failed";
}

function normalizedErrorCode(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "malformed_readiness_record";
  }
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return "daemon_bootstrap_failed";
}

function daemonUrl(readiness: DesktopClientReady, path: string): string {
  const host = readiness.host === "::1" ? "[::1]" : readiness.host;
  return `http://${host}:${readiness.port}${path}`;
}

async function fetchCapabilities(readiness: DesktopClientReady): Promise<string[]> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      daemonUrl(readiness, "/v1/client/capabilities"),
      {
        method: "GET",
        headers: clientHeaders(readiness.client_token),
      },
      resolve,
    );
    request.setTimeout(15_000, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    request.end();
  });
  const payload = await boundedJson(response);
  if (
    response.statusCode !== 200 ||
    payload.ok !== true ||
    payload.daemon_version !== readiness.daemon_version ||
    payload.config_id !== readiness.config_id ||
    payload.protocol_min !== 1 ||
    payload.protocol_max !== 1 ||
    payload.protocol !== 1 ||
    !Array.isArray(payload.capabilities) ||
    payload.capabilities.length !== DESKTOP_CAPABILITIES.length ||
    !payload.capabilities.every((value, index) => value === DESKTOP_CAPABILITIES[index])
  ) {
    throw new Error("daemon_capability_mismatch");
  }
  return payload.capabilities;
}

async function fetchHealth(readiness: DesktopClientReady): Promise<void> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      daemonUrl(readiness, "/v1/health"),
      { method: "GET", headers: clientHeaders(readiness.client_token) },
      resolve,
    );
    request.setTimeout(2_000, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    request.end();
  });
  const payload = await boundedJson(response);
  if (response.statusCode !== 200 || payload.ok !== true) {
    throw new Error("daemon_unhealthy");
  }
}

async function renewLease(readiness: DesktopClientReady, capabilities: string[]): Promise<string> {
  const body = "{}";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const headers = clientHeaders(readiness.client_token, true);
    headers["Content-Length"] = Buffer.byteLength(body).toString();
    const request = httpRequest(
      daemonUrl(readiness, "/v1/client/leases/renew"),
      {
        method: "POST",
        headers,
      },
      resolve,
    );
    request.setTimeout(15_000, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    request.end(body);
  });
  const payload = await boundedJson(response);
  const lease = payload.lease;
  const leaseRecord =
    lease && typeof lease === "object" && !Array.isArray(lease)
      ? (lease as Record<string, unknown>)
      : null;
  const issuedAt =
    typeof leaseRecord?.issued_at === "string" ? Date.parse(leaseRecord.issued_at) : Number.NaN;
  const expiresAt =
    typeof leaseRecord?.expires_at === "string" ? Date.parse(leaseRecord.expires_at) : Number.NaN;
  if (
    response.statusCode !== 200 ||
    payload.ok !== true ||
    !leaseRecord ||
    Object.keys(leaseRecord).length !== 6 ||
    !["client_id", "protocol", "issued_at", "expires_at", "config_id", "capabilities"].every(
      (key) => key in leaseRecord,
    ) ||
    "client_token" in leaseRecord ||
    leaseRecord.client_id !== readiness.client_id ||
    leaseRecord.config_id !== readiness.config_id ||
    leaseRecord.protocol !== 1 ||
    !Array.isArray(leaseRecord.capabilities) ||
    leaseRecord.capabilities.length !== capabilities.length ||
    !leaseRecord.capabilities.every((value, index) => value === capabilities[index]) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt <= issuedAt
  ) {
    throw new Error("lease_renewal_failed");
  }
  return leaseRecord.expires_at as string;
}

async function revokeLease(readiness: DesktopClientReady): Promise<void> {
  const body = "{}";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const headers = clientHeaders(readiness.client_token, true);
    headers["Content-Length"] = Buffer.byteLength(body).toString();
    const request = httpRequest(
      daemonUrl(readiness, "/v1/client/leases/current"),
      {
        method: "DELETE",
        headers,
      },
      resolve,
    );
    request.setTimeout(2_000, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    request.end(body);
  });
  const payload = await boundedJson(response);
  if (response.statusCode !== 200 || payload.ok !== true || payload.revoked !== true) {
    throw new Error("lease_revocation_failed");
  }
}

async function boundedJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new Error("daemon_response_too_large");
    }
    chunks.push(value);
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_daemon_response");
  }
  return payload as Record<string, unknown>;
}
