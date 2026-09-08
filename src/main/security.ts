import {
  CLIENT_TOKEN_HEADER,
  PROTOCOL_HOST,
  type DaemonStatus,
  type DesktopClientReady,
} from "../shared/contracts.js";

const readinessKeys = new Set([
  "schema_version",
  "event",
  "host",
  "port",
  "protocol_min",
  "protocol_max",
  "daemon_version",
  "config_id",
  "client_id",
  "client_token",
  "expires_at",
]);

export type AppAssetKey = "index" | "script" | "styles" | "logo";
export type CapturePreviewRequest = {
  kind: "candidates" | "frames";
  id: string;
};

export function privilegedSchemeOptions() {
  return {
    scheme: "openminion",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
      bypassCSP: false,
    },
  };
}

export function validateReadiness(payload: unknown): DesktopClientReady {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("daemon readiness must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== readinessKeys.size ||
    Object.keys(record).some((key) => !readinessKeys.has(key))
  ) {
    throw new Error("daemon readiness fields do not match schema version 1");
  }
  if (record.schema_version !== 1 || record.event !== "desktop.client.ready") {
    throw new Error("daemon readiness schema is not supported");
  }
  if (record.host !== "127.0.0.1" && record.host !== "::1") {
    throw new Error("daemon readiness host must be loopback");
  }
  if (!Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65_535) {
    throw new Error("daemon readiness port is invalid");
  }
  if (record.protocol_min !== 1 || record.protocol_max !== 1) {
    throw new Error("daemon protocol is not supported");
  }
  if (
    typeof record.daemon_version !== "string" ||
    record.daemon_version.length === 0 ||
    typeof record.client_id !== "string" ||
    record.client_id.length === 0
  ) {
    throw new Error("daemon readiness identity is invalid");
  }
  if (typeof record.config_id !== "string" || !/^[0-9a-f]{64}$/.test(record.config_id)) {
    throw new Error("daemon config identity is invalid");
  }
  if (typeof record.client_token !== "string" || record.client_token.length < 43) {
    throw new Error("daemon client token is invalid");
  }
  if (
    typeof record.expires_at !== "string" ||
    !Number.isFinite(Date.parse(record.expires_at)) ||
    Date.parse(record.expires_at) <= Date.now()
  ) {
    throw new Error("daemon client lease is expired");
  }
  return record as DesktopClientReady;
}

export function validateAppRequest(request: Request): AppAssetKey | null {
  const url = new URL(request.url);
  if (url.protocol !== "openminion:" || url.host !== PROTOCOL_HOST) {
    return null;
  }
  if (request.method !== "GET" || url.search || url.hash) {
    return null;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return "index";
  }
  if (url.pathname === "/app.js") {
    return "script";
  }
  if (url.pathname === "/styles.css") {
    return "styles";
  }
  if (url.pathname === "/logo.png") {
    return "logo";
  }
  return null;
}

export function validateCapturePreviewRequest(request: Request): CapturePreviewRequest | null {
  const url = new URL(request.url);
  if (
    url.protocol !== "openminion:" ||
    url.host !== PROTOCOL_HOST ||
    request.method !== "GET" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const match = /^\/capture\/(candidates|frames)\/([0-9a-f]{48})$/.exec(url.pathname);
  return match ? { kind: match[1] as CapturePreviewRequest["kind"], id: match[2] } : null;
}

export function clientHeaders(token: string, jsonBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [CLIENT_TOKEN_HEADER]: token,
  };
  if (jsonBody) {
    headers["Content-Type"] = "application/json; charset=utf-8";
  }
  return headers;
}

export function publicStatus(
  state: DaemonStatus["state"],
  readiness: DesktopClientReady | null,
  capabilities: string[],
  errorCode: string | null,
): DaemonStatus {
  return {
    state,
    reachable: state === "ready",
    daemonVersion: readiness?.daemon_version ?? null,
    protocol: readiness ? 1 : null,
    configId: readiness?.config_id ?? null,
    capabilities: [...capabilities],
    errorCode,
  };
}
