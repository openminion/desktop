import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { DesktopStore } from "./desktop-store.js";
import { createDesktopSupervisor, launchDesktop, registerQuitLifecycle } from "./index.js";

try {
  const legacyRoot = app.getPath("userData");
  const override = process.env.OPENMINION_DESKTOP_HOME;
  const root = override ?? join(app.getPath("home"), ".openminion", "desktop");
  if (!isAbsolute(root)) throw new Error("OPENMINION_DESKTOP_HOME must be an absolute path.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  app.setPath("userData", root);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    const store = new DesktopStore(root, override ? undefined : legacyRoot);
    mkdirSync(store.browserHome, { recursive: true, mode: 0o700 });
    app.setPath("sessionData", store.browserHome);
    app.setAppLogsPath(join(root, "logs"));
    app.once("will-quit", () => store.close());
    app.on("second-instance", () => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window?.isMinimized()) window.restore();
      window?.focus();
    });
    app.on("window-all-closed", () => app.quit());
    void app
      .whenReady()
      .then(async () => {
        const supervisor = createDesktopSupervisor(store.runtimeHome, store);
        registerQuitLifecycle(app, supervisor);
        await launchDesktop(supervisor, store);
      })
      .catch((error: Error) => {
        dialog.showErrorBox("OpenMinion could not start", error.message);
        app.quit();
      });
  }
} catch (error) {
  dialog.showErrorBox("OpenMinion could not open Desktop data", (error as Error).message);
  app.quit();
}
