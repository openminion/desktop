import { describe, expect, it } from "vitest";
import { isCaptureWorkerConfig, isCaptureWorkerEvent } from "../../src/shared/capture-worker.js";

const id = "a".repeat(48);

describe("capture worker contract", () => {
  it("accepts only the exact bounded configuration", () => {
    const config = {
      schemaVersion: 1,
      kind: "configure",
      captureId: id,
      generation: 1,
      region: { xBps: 0, yBps: 100, widthBps: 5000, heightBps: 5000 },
      cadenceMs: 2000,
      maxWidth: 1920,
      maxHeight: 1080,
      jpegQuality: 0.8,
      maxBytes: 2_097_152,
    };
    expect(isCaptureWorkerConfig(config)).toBe(true);
    expect(isCaptureWorkerConfig({ ...config, interval: 100 })).toBe(false);
    expect(isCaptureWorkerConfig({ ...config, region: { ...config.region, widthBps: 0 } })).toBe(
      false,
    );
    expect(isCaptureWorkerConfig({ ...config, maxBytes: Infinity })).toBe(false);
  });

  it("validates exact phase and bounded frame events", () => {
    expect(isCaptureWorkerEvent({ schemaVersion: 1, kind: "ready" })).toBe(true);
    expect(
      isCaptureWorkerEvent({
        schemaVersion: 1,
        kind: "configured",
        captureId: id,
        generation: 1,
      }),
    ).toBe(true);
    const frame = {
      schemaVersion: 1,
      kind: "frame",
      captureId: id,
      generation: 1,
      sourceWidth: 2560,
      sourceHeight: 1440,
      width: 1920,
      height: 1080,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    expect(isCaptureWorkerEvent(frame)).toBe(true);
    expect(isCaptureWorkerEvent({ ...frame, height: 1081 })).toBe(false);
    expect(isCaptureWorkerEvent({ ...frame, bytes: new Uint8Array(2_097_153) })).toBe(false);
    expect(isCaptureWorkerEvent({ ...frame, extra: true })).toBe(false);
  });

  it("rejects arrays, prototypes, and malformed identities", () => {
    expect(isCaptureWorkerEvent([])).toBe(false);
    expect(isCaptureWorkerEvent(Object.create({ schemaVersion: 1, kind: "ready" }))).toBe(false);
    expect(
      isCaptureWorkerEvent({
        schemaVersion: 1,
        kind: "ended",
        captureId: "native-source-id",
        generation: 1,
        reason: "track_ended",
      }),
    ).toBe(false);
  });
});
