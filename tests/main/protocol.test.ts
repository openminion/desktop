import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
}));
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged },
}));

import {
  registerAppProtocol,
  registerPrivilegedSchemes,
  resolveAppAssets,
} from "../../src/main/protocol.js";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe("local app protocol", () => {
  it("registers a secure stable origin", () => {
    registerPrivilegedSchemes();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: "openminion" }),
    ]);
  });

  it("resolves every renderer asset from the built application tree", () => {
    const root = join(tmpdir(), "openminion-package");

    expect(resolveAppAssets(join(root, "dist/src/main"))).toEqual({
      index: join(root, "dist/src/renderer/index.html"),
      script: join(root, "dist/src/renderer/app.js"),
      styles: join(root, "dist/src/renderer/styles.css"),
      logo: join(root, "dist/src/renderer/logo.png"),
      workerHtml: join(root, "dist/src/renderer/capture-worker.html"),
      workerScript: join(root, "dist/src/renderer/capture-worker.js"),
    });
  });

  it("serves only named local assets and never proxies daemon routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openminion-assets-"));
    cleanup.push(root);
    const assets = {
      index: join(root, "index.html"),
      script: join(root, "app.js"),
      styles: join(root, "styles.css"),
      logo: join(root, "logo.png"),
      workerHtml: join(root, "capture-worker.html"),
      workerScript: join(root, "capture-worker.js"),
    };
    await Promise.all([
      writeFile(assets.index, "<main>OpenMinion</main>"),
      writeFile(assets.script, "export {};"),
      writeFile(assets.styles, "body {}"),
      writeFile(assets.logo, Buffer.from([137, 80, 78, 71])),
      writeFile(assets.workerHtml, "<video></video>"),
      writeFile(assets.workerScript, "export {};"),
    ]);
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const appSession = {
      protocol: {
        handle: vi.fn((_scheme: string, value: typeof handler) => {
          handler = value;
        }),
      },
    };
    registerAppProtocol(appSession as never, assets);

    const index = await handler!(new Request("openminion://app/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("Cache-Control")).toBe("no-store");
    expect(await index.text()).toContain("OpenMinion");
    const logo = await handler!(new Request("openminion://app/logo.png"));
    expect(logo.status).toBe(200);
    expect(logo.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await logo.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]));
    expect((await handler!(new Request("openminion://app/v1/health"))).status).toBe(404);
    expect((await handler!(new Request("openminion://evil/app.js"))).status).toBe(404);
    const worker = await handler!(new Request("openminion://app/capture-worker.html"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("Content-Security-Policy")).toContain("media-src 'self' blob:");
    expect((await handler!(new Request("openminion://app/capture-worker.js"))).status).toBe(200);
    expect((await handler!(new Request("openminion://app/capture-worker.js?x=1"))).status).toBe(
      404,
    );
  });

  it("serves only current bounded capture previews with no-store headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openminion-capture-assets-"));
    cleanup.push(root);
    const assets = {
      index: join(root, "index.html"),
      script: join(root, "app.js"),
      styles: join(root, "styles.css"),
      logo: join(root, "logo.png"),
      workerHtml: join(root, "capture-worker.html"),
      workerScript: join(root, "capture-worker.js"),
    };
    await Promise.all(Object.values(assets).map((path) => writeFile(path, "asset")));
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const appSession = {
      protocol: {
        handle: vi.fn((_scheme: string, value: typeof handler) => {
          handler = value;
        }),
      },
    };
    const id = "b".repeat(48);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const capture = {
      preview: vi.fn((kind: string, value: string) =>
        kind === "frames" && value === id ? { bytes, contentType: "image/jpeg" as const } : null,
      ),
    };
    registerAppProtocol(appSession as never, assets, capture as never);

    const response = await handler!(new Request(`openminion://app/capture/frames/${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await handler!(new Request(`openminion://app/capture/candidates/${id}`))).status).toBe(
      404,
    );
  });
});
