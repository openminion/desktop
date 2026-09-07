import { contextBridge, ipcRenderer } from "electron";
import {
  CAPTURE_WORKER_CONFIG_CHANNEL,
  CAPTURE_WORKER_EVENT_CHANNEL,
  isCaptureWorkerConfig,
  isCaptureWorkerEvent,
  type CaptureWorkerConfigV1,
  type CaptureWorkerEventV1,
} from "../shared/capture-worker.js";

type CaptureWorkerBridge = {
  configure(listener: (config: CaptureWorkerConfigV1) => void): void;
  send(event: CaptureWorkerEventV1): void;
};

let configureListener: ((config: CaptureWorkerConfigV1) => void) | null = null;

ipcRenderer.on(CAPTURE_WORKER_CONFIG_CHANNEL, (_event, value: unknown) => {
  if (isCaptureWorkerConfig(value)) configureListener?.(value);
});

const bridge: CaptureWorkerBridge = {
  configure(listener) {
    if (typeof listener === "function") configureListener = listener;
  },
  send(event) {
    if (!isCaptureWorkerEvent(event)) {
      overwriteBytes(event);
      return;
    }
    try {
      ipcRenderer.send(CAPTURE_WORKER_EVENT_CHANNEL, event);
    } finally {
      if (event.kind === "frame") event.bytes.fill(0);
    }
  },
};

contextBridge.exposeInMainWorld("openminionCaptureBridge", bridge);

function overwriteBytes(value: unknown): void {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { bytes?: unknown }).bytes instanceof Uint8Array
  ) {
    (value as { bytes: Uint8Array }).bytes.fill(0);
  }
}
