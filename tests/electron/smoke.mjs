import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const temporaryRoot = mkdtempSync(join(tmpdir(), "openminion-electron-check-"));
app.setPath("userData", temporaryRoot);
process.env.OPENMINION_ODF_EXECUTABLE = join(temporaryRoot, "missing-openminion");
const preloadErrors = [];
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.on("preload-error", (_event, _path, error) => {
      preloadErrors.push(error.message);
    });
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("Electron startup check timed out");
  app.exit(1);
}, 20000);

await import("../../dist/src/main/index.js");
void check();

async function check() {
  let exitCode = 0;
  try {
    const window = await loaded;
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    assert.deepEqual(preloadErrors, []);
    assert.equal(await evaluate("typeof window.openminion?.daemon.status"), "function");
    assert.equal(await evaluate("typeof window.require"), "undefined");
    const preferences = window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate("!document.querySelector('#retry').hidden")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate("document.querySelector('#retry').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#composer').disabled"), false);
    assert.equal(await evaluate("document.querySelector('#new-session').disabled"), false);
    await evaluate("document.querySelector('#new-session').click()");
    assert.equal(await evaluate("document.activeElement.id"), "composer");
    await evaluate(`
    document.querySelector('#composer').value = 'A local draft while disconnected';
    document.querySelector('#composer').dispatchEvent(new Event('input'));
    document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', metaKey:true}));
  `);
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "A local draft while disconnected",
    );
    for (const panel of ["context-panel", "screen-panel", "attachment-menu"]) {
      await evaluate(`document.querySelector('[popovertarget="${panel}"]').click()`);
      assert.equal(
        await evaluate(`document.querySelector('#${panel}').matches(':popover-open')`),
        true,
      );
      await evaluate(`document.querySelector('#${panel}').hidePopover()`);
    }
    const widths = [];
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1800, 1000],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const bounds = await evaluate(`(() => {
      const composer = document.querySelector('#composer-form').getBoundingClientRect();
      const send = document.querySelector('#send').getBoundingClientRect();
      return {width:composer.width, right:composer.right, bottom:composer.bottom, sendBottom:send.bottom,
        overflow:document.documentElement.scrollWidth > innerWidth, viewportWidth:innerWidth, viewportHeight:innerHeight};
    })()`);
      assert.equal(bounds.overflow, false);
      assert.ok(bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight);
      assert.ok(bounds.sendBottom <= bounds.viewportHeight);
      widths.push(bounds.width);
    }
    assert.ok(widths[2] > widths[1] + 400, "Composer must grow with a wider window");

    const worker = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: window.webContents.session,
        preload: fileURLToPath(new URL("../../dist/src/preload/capture.cjs", import.meta.url)),
      },
    });
    worker.webContents.on("preload-error", (_event, _path, error) =>
      preloadErrors.push(error.message),
    );
    await worker.loadURL("openminion://app/capture-worker.html");
    assert.equal(
      await worker.webContents.executeJavaScript(
        "typeof window.openminionCaptureBridge?.configure",
      ),
      "function",
    );
    assert.equal(
      await worker.webContents.executeJavaScript("typeof window.openminionCaptureWorker?.start"),
      "function",
    );
    assert.deepEqual(preloadErrors, []);
    worker.destroy();
    console.log(
      "Electron check passed: real app/preloads, isolated bridge, offline draft, popovers, and fluid composer.",
    );
    clearTimeout(timeout);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    exitCode = 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
