import { describe, expect, it } from "vitest";
import {
  privilegedSchemeOptions,
  validateAppRequest,
  validateCapturePreviewRequest,
} from "../../src/main/security.js";

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
});
