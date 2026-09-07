import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";
import { protocol } from "electron";
import { PROTOCOL_SCHEME } from "../shared/contracts.js";
import type { CaptureService } from "./capture.js";
import {
  privilegedSchemeOptions,
  validateAppRequest,
  validateCapturePreviewRequest,
} from "./security.js";

export type AppAssetPaths = {
  index: string;
  script: string;
  styles: string;
  workerHtml: string;
  workerScript: string;
};

const contentTypes: Record<keyof AppAssetPaths, string> = {
  index: "text/html; charset=utf-8",
  script: "text/javascript; charset=utf-8",
  styles: "text/css; charset=utf-8",
  workerHtml: "text/html; charset=utf-8",
  workerScript: "text/javascript; charset=utf-8",
};

const workerCsp =
  "default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([privilegedSchemeOptions()]);
}

export function resolveAppAssets(mainModuleDir: string): AppAssetPaths {
  const packageRoot = join(mainModuleDir, "../../..");
  const rendererRoot = join(packageRoot, "dist/src/renderer");
  return {
    index: join(rendererRoot, "index.html"),
    script: join(rendererRoot, "app.js"),
    styles: join(rendererRoot, "styles.css"),
    workerHtml: join(rendererRoot, "capture-worker.html"),
    workerScript: join(rendererRoot, "capture-worker.js"),
  };
}

export function registerAppProtocol(
  appSession: Session,
  assets = resolveAppAssets(import.meta.dirname),
  capture?: Pick<CaptureService, "preview">,
): void {
  appSession.protocol.handle(PROTOCOL_SCHEME, async (request) => {
    const previewRequest = validateCapturePreviewRequest(request);
    if (previewRequest) {
      const preview = capture?.preview(previewRequest.kind, previewRequest.id);
      if (!preview) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(preview.bytes), {
        status: 200,
        headers: {
          "Content-Type": preview.contentType,
          "Content-Length": String(preview.bytes.length),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    }
    const asset = validateAppRequest(request);
    const workerAsset = captureAssetKey(request);
    if (!asset && !workerAsset) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const key: keyof AppAssetPaths = workerAsset ?? (asset as keyof AppAssetPaths);
      const content = await readFile(assets[key]);
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[key],
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(key === "workerHtml" ? { "Content-Security-Policy": workerCsp } : {}),
        },
      });
    } catch {
      return new Response("Asset unavailable", { status: 503 });
    }
  });
}

function captureAssetKey(request: Request): "workerHtml" | "workerScript" | null {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search || url.hash || url.host !== "app") return null;
  if (url.pathname === "/capture-worker.html") return "workerHtml";
  if (url.pathname === "/capture-worker.js") return "workerScript";
  return null;
}
