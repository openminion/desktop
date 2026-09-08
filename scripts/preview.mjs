// Launch the real renderer with explicit in-memory UI fixtures, without a daemon or native bridge.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { build } from "esbuild";
import {
  registerAppProtocol,
  registerPrivilegedSchemes,
  resolveAppAssets,
} from "../dist/src/main/protocol.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "openminion-ui-preview-"));
app.setPath("userData", temporaryRoot);
registerPrivilegedSchemes();
await build({
  absWorkingDir: root,
  entryPoints: ["tests/fixtures/ui-preview.ts"],
  outfile: join(temporaryRoot, "app.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome150",
});
app.whenReady().then(async () => {
  const appSession = session.fromPartition("preview");
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerAppProtocol(appSession, {
    ...resolveAppAssets(join(root, "dist/src/main")),
    script: join(temporaryRoot, "app.js"),
  });
  const window = new BrowserWindow({
    title: "OpenMinion — UI preview",
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#202020",
    icon: join(root, "assets/icon.png"),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: appSession,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL("openminion://app/");
  window.setTitle("OpenMinion — UI preview (sample data)");
});
app.on("window-all-closed", () => app.quit());
app.on("quit", () => rmSync(temporaryRoot, { recursive: true, force: true }));
