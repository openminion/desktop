// Exact private contract between Electron main and the sandboxed capture worker.

export const CAPTURE_WORKER_CONFIG_CHANNEL = "openminion:capture-worker-config";
export const CAPTURE_WORKER_EVENT_CHANNEL = "openminion:capture-worker-event";

export type CaptureWorkerRegionV1 = {
  xBps: number;
  yBps: number;
  widthBps: number;
  heightBps: number;
};

export type CaptureWorkerConfigV1 = {
  schemaVersion: 1;
  kind: "configure";
  captureId: string;
  generation: number;
  region: CaptureWorkerRegionV1 | null;
  cadenceMs: 2000;
  maxWidth: 1920;
  maxHeight: 1080;
  jpegQuality: 0.8;
  maxBytes: 2097152;
};

export type CaptureWorkerEventV1 =
  | { schemaVersion: 1; kind: "ready" }
  | {
      schemaVersion: 1;
      kind: "configured";
      captureId: string;
      generation: number;
    }
  | {
      schemaVersion: 1;
      kind: "stream_ready";
      captureId: string;
      generation: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | {
      schemaVersion: 1;
      kind: "frame";
      captureId: string;
      generation: number;
      sourceWidth: number;
      sourceHeight: number;
      width: number;
      height: number;
      bytes: Uint8Array;
    }
  | {
      schemaVersion: 1;
      kind: "ended";
      captureId: string;
      generation: number;
      reason: "track_ended" | "worker_error";
    };

const captureIdPattern = /^[0-9a-f]{48}$/;

export function isCaptureWorkerConfig(value: unknown): value is CaptureWorkerConfigV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "captureId",
      "generation",
      "region",
      "cadenceMs",
      "maxWidth",
      "maxHeight",
      "jpegQuality",
      "maxBytes",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    value.kind === "configure" &&
    captureId(value.captureId) &&
    positiveInteger(value.generation) &&
    (value.region === null || isRegion(value.region)) &&
    value.cadenceMs === 2000 &&
    value.maxWidth === 1920 &&
    value.maxHeight === 1080 &&
    value.jpegQuality === 0.8 &&
    value.maxBytes === 2_097_152
  );
}

export function isCaptureWorkerEvent(value: unknown): value is CaptureWorkerEventV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "ready") return exactKeys(value, ["schemaVersion", "kind"]);
  if (value.kind === "configured") {
    return (
      exactKeys(value, ["schemaVersion", "kind", "captureId", "generation"]) &&
      captureId(value.captureId) &&
      positiveInteger(value.generation)
    );
  }
  if (value.kind === "stream_ready") {
    return (
      exactKeys(value, [
        "schemaVersion",
        "kind",
        "captureId",
        "generation",
        "sourceWidth",
        "sourceHeight",
      ]) && identityAndSourceSize(value)
    );
  }
  if (value.kind === "frame") {
    return (
      exactKeys(value, [
        "schemaVersion",
        "kind",
        "captureId",
        "generation",
        "sourceWidth",
        "sourceHeight",
        "width",
        "height",
        "bytes",
      ]) &&
      identityAndSourceSize(value) &&
      boundedDimension(value.width, 1_920) &&
      boundedDimension(value.height, 1_080) &&
      value.bytes instanceof Uint8Array &&
      value.bytes.byteLength > 0 &&
      value.bytes.byteLength <= 2_097_152
    );
  }
  return (
    value.kind === "ended" &&
    exactKeys(value, ["schemaVersion", "kind", "captureId", "generation", "reason"]) &&
    captureId(value.captureId) &&
    positiveInteger(value.generation) &&
    (value.reason === "track_ended" || value.reason === "worker_error")
  );
}

function identityAndSourceSize(value: Record<string, unknown>): boolean {
  return (
    captureId(value.captureId) &&
    positiveInteger(value.generation) &&
    positiveInteger(value.sourceWidth) &&
    positiveInteger(value.sourceHeight)
  );
}

function isRegion(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["xBps", "yBps", "widthBps", "heightBps"])) {
    return false;
  }
  const { xBps, yBps, widthBps, heightBps } = value;
  return (
    basis(xBps) &&
    basis(yBps) &&
    positiveBasis(widthBps) &&
    positiveBasis(heightBps) &&
    Number(xBps) + Number(widthBps) <= 10_000 &&
    Number(yBps) + Number(heightBps) <= 10_000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function captureId(value: unknown): boolean {
  return typeof value === "string" && captureIdPattern.test(value);
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedDimension(value: unknown, maximum: number): boolean {
  return positiveInteger(value) && Number(value) <= maximum;
}

function basis(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function positiveBasis(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 10_000;
}
