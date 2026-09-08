import { describe, expect, it } from "vitest";
import {
  clientHeaders,
  privilegedSchemeOptions,
  publicStatus,
  validateAppRequest,
  validateCapturePreviewRequest,
  validateReadiness,
} from "../../src/main/security.js";
import { CLIENT_TOKEN_HEADER } from "../../src/shared/contracts.js";

const validReadiness = {
  schema_version: 1,
  event: "desktop.client.ready",
  host: "127.0.0.1",
  port: 49152,
  protocol_min: 1,
  protocol_max: 1,
  daemon_version: "0.0.9",
  config_id: "a".repeat(64),
  client_id: "client-1",
  client_token: "x".repeat(43),
  expires_at: "2999-08-16T12:00:00Z",
} as const;

describe("security helpers", () => {
  it("uses the required privileged scheme options", () => {
    expect(privilegedSchemeOptions()).toEqual({
      scheme: "openminion",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
        bypassCSP: false,
      },
    });
  });

  it("validates the exact readiness contract", () => {
    expect(validateReadiness(validReadiness)).toEqual(validReadiness);
    expect(() => validateReadiness({ ...validReadiness, host: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => validateReadiness({ ...validReadiness, protocol_max: 2 })).toThrow(/protocol/);
    expect(() =>
      validateReadiness({ ...validReadiness, expires_at: "2000-01-01T00:00:00Z" }),
    ).toThrow(/expired/);
    expect(() => validateReadiness({ ...validReadiness, extra: true })).toThrow(/fields/);
  });

  it("admits only exact local asset requests", () => {
    expect(validateAppRequest(new Request("openminion://app/"))).toBe("index");
    expect(validateAppRequest(new Request("openminion://app/app.js"))).toBe("script");
    expect(validateAppRequest(new Request("openminion://app/styles.css"))).toBe("styles");
    expect(validateAppRequest(new Request("openminion://app/logo.png"))).toBe("logo");
    expect(validateAppRequest(new Request("openminion://app/logo.png?file=other"))).toBeNull();
    expect(validateAppRequest(new Request("openminion://evil/logo.png"))).toBeNull();
    expect(validateAppRequest(new Request("openminion://evil/"))).toBeNull();
    expect(validateAppRequest(new Request("openminion://app/admin"))).toBeNull();
    expect(validateAppRequest(new Request("openminion://app/?route=/v1/health"))).toBeNull();
    expect(validateAppRequest(new Request("openminion://app/", { method: "POST" }))).toBeNull();
  });

  it("admits only opaque fixed capture preview routes", () => {
    const id = "a".repeat(48);
    expect(
      validateCapturePreviewRequest(new Request(`openminion://app/capture/candidates/${id}`)),
    ).toEqual({ kind: "candidates", id });
    expect(
      validateCapturePreviewRequest(new Request(`openminion://app/capture/frames/${id}`)),
    ).toEqual({ kind: "frames", id });
    expect(
      validateCapturePreviewRequest(new Request(`openminion://app/capture/frames/native-id`)),
    ).toBeNull();
    expect(
      validateCapturePreviewRequest(
        new Request(`openminion://app/capture/frames/${id}?token=secret`),
      ),
    ).toBeNull();
    expect(
      validateCapturePreviewRequest(
        new Request(`openminion://app/capture/frames/${id}`, { method: "POST" }),
      ),
    ).toBeNull();
  });

  it("keeps the client credential in main-only request headers", () => {
    const headers = clientHeaders("secret-token", true);
    expect(headers[CLIENT_TOKEN_HEADER]).toBe("secret-token");
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("projects no endpoint or credential into renderer status", () => {
    const status = publicStatus("ready", validReadiness, ["daemon.health"], null);
    const serialized = JSON.stringify(status);
    expect(status.reachable).toBe(true);
    expect(status.configId).toBe(validReadiness.config_id);
    expect(serialized).not.toContain(validReadiness.client_token);
    expect(serialized).not.toContain(validReadiness.host);
    expect(serialized).not.toContain(validReadiness.port.toString());
  });
});
