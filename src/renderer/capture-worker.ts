import type { CaptureWorkerConfigV1, CaptureWorkerEventV1 } from "../shared/capture-worker.js";

type CaptureWorkerBridge = {
  configure(listener: (config: CaptureWorkerConfigV1) => void): void;
  send(event: CaptureWorkerEventV1): void;
};

declare global {
  interface Window {
    openminionCaptureBridge: CaptureWorkerBridge;
    openminionCaptureWorker: { start(): boolean };
  }
}

let config: CaptureWorkerConfigV1 | null = null;
let started = false;
let ended = false;
let stream: MediaStream | null = null;
let cadenceTimer: ReturnType<typeof setTimeout> | null = null;

window.openminionCaptureBridge.configure((value) => {
  if (config || started) return;
  config = value;
  send({
    schemaVersion: 1,
    kind: "configured",
    captureId: value.captureId,
    generation: value.generation,
  });
});

window.openminionCaptureWorker = {
  start(): boolean {
    if (started || !config) return false;
    started = true;
    void startCapture();
    return true;
  },
};

send({ schemaVersion: 1, kind: "ready" });

async function startCapture(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track || stream.getAudioTracks().length !== 0) throw new Error("invalid stream");
    track.addEventListener("ended", () => finish("track_ended"), { once: true });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!positiveInteger(sourceWidth) || !positiveInteger(sourceHeight)) {
      throw new Error("invalid source dimensions");
    }
    send(identityEvent("stream_ready", sourceWidth, sourceHeight));
    await encodeNext(video);
  } catch {
    finish("worker_error");
  }
}

async function encodeNext(video: HTMLVideoElement): Promise<void> {
  if (ended || !config) return;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!positiveInteger(sourceWidth) || !positiveInteger(sourceHeight)) {
    finish("worker_error");
    return;
  }
  const crop = cropRect(config, sourceWidth, sourceHeight);
  if (crop.width < 64 || crop.height < 64) {
    finish("worker_error");
    return;
  }
  const output = outputSize(config, crop.width, crop.height);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    finish("worker_error");
    return;
  }
  context.drawImage(
    video,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    output.width,
    output.height,
  );
  try {
    const blob = await encodeJpeg(canvas, config.jpegQuality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (ended || bytes.byteLength === 0 || bytes.byteLength > config.maxBytes) {
      bytes.fill(0);
      finish("worker_error");
      return;
    }
    try {
      send({
        schemaVersion: 1,
        kind: "frame",
        captureId: config.captureId,
        generation: config.generation,
        sourceWidth,
        sourceHeight,
        width: output.width,
        height: output.height,
        bytes,
      });
    } finally {
      bytes.fill(0);
    }
  } catch {
    finish("worker_error");
    return;
  }
  if (!ended) cadenceTimer = setTimeout(() => void encodeNext(video), config.cadenceMs);
}

function cropRect(value: CaptureWorkerConfigV1, sourceWidth: number, sourceHeight: number) {
  if (!value.region) {
    return { left: 0, top: 0, width: sourceWidth, height: sourceHeight };
  }
  const left = Math.floor((value.region.xBps * sourceWidth) / 10_000);
  const top = Math.floor((value.region.yBps * sourceHeight) / 10_000);
  const right = Math.ceil(((value.region.xBps + value.region.widthBps) * sourceWidth) / 10_000);
  const bottom = Math.ceil(((value.region.yBps + value.region.heightBps) * sourceHeight) / 10_000);
  return { left, top, width: right - left, height: bottom - top };
}

function outputSize(value: CaptureWorkerConfigV1, width: number, height: number) {
  const ratio = Math.min(1, value.maxWidth / width, value.maxHeight / height);
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
  };
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type === "image/jpeg") resolve(blob);
        else reject(new Error("JPEG encoding failed"));
      },
      "image/jpeg",
      quality,
    );
  });
}

function identityEvent(
  kind: "stream_ready",
  sourceWidth: number,
  sourceHeight: number,
): CaptureWorkerEventV1 {
  const value = config as CaptureWorkerConfigV1;
  return {
    schemaVersion: 1,
    kind,
    captureId: value.captureId,
    generation: value.generation,
    sourceWidth,
    sourceHeight,
  };
}

function finish(reason: "track_ended" | "worker_error"): void {
  if (ended) return;
  ended = true;
  if (cadenceTimer) clearTimeout(cadenceTimer);
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  if (!config) return;
  send({
    schemaVersion: 1,
    kind: "ended",
    captureId: config.captureId,
    generation: config.generation,
    reason,
  });
}

function send(event: CaptureWorkerEventV1): void {
  window.openminionCaptureBridge.send(event);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
