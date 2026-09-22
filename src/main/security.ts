import { PROTOCOL_HOST } from "../shared/contracts.js";

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
