import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (!process.versions.electron) {
  const root = mkdtempSync(join(tmpdir(), "desktop-storage-e2e-"));
  try {
    const { default: executable } = await import("electron");
    for (const phase of ["seed", "migrate", "restart", "cleared"]) {
      const result = await promisify(execFile)(
        executable,
        [fileURLToPath(import.meta.url), phase],
        {
          env: { ...process.env, OPENMINION_STORAGE_TEST_ROOT: root },
          timeout: 30000,
        },
      );
      process.stdout.write(result.stdout);
    }
    console.log(
      "PASS: native legacy-browser migration, saved names across app restarts, reset without resurrection, unsent composer drafts restored and cleared across process restarts, stable runtime paths and schema version.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  void checkStorage();
}

async function checkStorage() {
  const { app, BrowserWindow, protocol, session } = await import("electron");
  const root = process.env.OPENMINION_STORAGE_TEST_ROOT;
  if (!root) throw new Error("Run this check with Node.js so it creates an isolated installation.");
  const legacy = join(root, "legacy");
  const desktopRoot = join(root, ".openminion", "desktop");
  mkdirSync(legacy, { recursive: true });
  app.setPath("home", root);
  app.setPath("userData", legacy);
  delete process.env.OPENMINION_DESKTOP_HOME;
  process.env.OPENMINION_EXECUTABLE = join(root, "missing-openminion");
  const phase = process.argv[2];
  const timer = setTimeout(() => {
    console.error(`Storage ${phase} timed out`);
    app.exit(1);
  }, 25000);
  try {
    if (phase === "seed") {
      mkdirSync(join(legacy, "runtime"));
      writeFileSync(join(legacy, "runtime", "keep"), "existing environment");
      protocol.registerSchemesAsPrivileged([
        { scheme: "openminion", privileges: { standard: true, secure: true } },
      ]);
      await app.whenReady();
      const browser = session.fromPartition("persist:openminion");
      browser.protocol.handle(
        "openminion",
        () =>
          new Response("<html><body>Legacy storage</body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
      );
      const window = new BrowserWindow({
        show: false,
        webPreferences: { session: browser, sandbox: true, contextIsolation: true },
      });
      await window.loadURL("openminion://app/");
      await window.webContents.executeJavaScript(`
        localStorage.setItem('openminion.task-name:legacy-one', 'Legacy planning');
        localStorage.setItem('openminion.task-name:legacy-reset', 'Reset me');
      `);
      await browser.flushStorageData();
    } else {
      const loaded = new Promise((resolve) =>
        app.once("browser-window-created", (_event, window) => {
          window.webContents.once("did-finish-load", () => resolve(window));
        }),
      );
      await import("../../dist/src/main/bootstrap.js");
      const window = await loaded;
      const evaluate = (source) => window.webContents.executeJavaScript(source);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate("localStorage.getItem('openminion.task-name:legacy-one') === null"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const draftText = "Unsent before the runtime is ready\nKeep this exact draft.";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate("!document.querySelector('#composer').disabled")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(await evaluate("document.querySelector('#composer').disabled"), false);
      assert.equal(await evaluate("document.querySelector('#recovery').hidden"), false);
      assert.equal(
        await evaluate("document.querySelector('#composer').value"),
        phase === "restart" ? draftText : "",
      );
      if (phase !== "cleared") {
        window.show();
        window.focus();
        await evaluate("document.querySelector('#composer').focus()");
        if (phase === "migrate") {
          await window.webContents.insertText(draftText);
        } else {
          await evaluate("document.querySelector('#composer').select()");
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        }
        const expected = phase === "migrate" ? [{ sessionId: "", text: draftText }] : [];
        let saved;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          saved = await evaluate("window.openminion.drafts.load()");
          if (saved.ok && JSON.stringify(saved.value) === JSON.stringify(expected)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.deepEqual(
          saved,
          { ok: true, value: expected },
          "Wait for the main-process draft save before exiting",
        );
        assert.equal(
          await evaluate("document.querySelector('#composer').value"),
          phase === "migrate" ? draftText : "",
        );
      } else {
        assert.deepEqual(await evaluate("window.openminion.drafts.load()"), {
          ok: true,
          value: [],
        });
      }
      assert.equal(app.getPath("userData"), desktopRoot);
      assert.equal(app.getPath("sessionData"), legacy);
      assert.equal(await evaluate("localStorage.getItem('openminion.task-name:legacy-one')"), null);
      const names = await evaluate("window.openminion.chatNames.load([])");
      assert.deepEqual(names, {
        ok: true,
        value:
          phase === "migrate"
            ? [
                { sessionId: "legacy-one", title: "Legacy planning" },
                { sessionId: "legacy-reset", title: "Reset me" },
              ]
            : [{ sessionId: "legacy-one", title: "New planning" }],
      });
      if (phase === "migrate") {
        assert.deepEqual(await evaluate("window.openminion.presentation.load()"), {
          ok: true,
          value: { toolDisplay: "normal" },
        });
        assert.equal(
          (await evaluate("window.openminion.presentation.save({toolDisplay:'verbose'})")).ok,
          true,
        );
        assert.equal(
          (
            await evaluate(
              "window.openminion.chatNames.save({sessionId:'legacy-one',title:'New planning'})",
            )
          ).ok,
          true,
        );
        assert.equal(
          (
            await evaluate(
              "window.openminion.chatNames.save({sessionId:'legacy-reset',title:null})",
            )
          ).ok,
          true,
        );
        await evaluate("localStorage.setItem('openminion.task-name:legacy-reset','Stale name')");
      }
      assert.deepEqual(await evaluate("window.openminion.presentation.load()"), {
        ok: true,
        value: { toolDisplay: "verbose" },
      });
      const db = new DatabaseSync(join(desktopRoot, "desktop.sqlite"), { readOnly: true });
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
      assert.equal(db.prepare("SELECT runtime_home FROM installation").get().runtime_home, legacy);
      db.close();
      assert.equal(readFileSync(join(legacy, "runtime", "keep"), "utf8"), "existing environment");
      console.log(`PASS: native storage ${phase}`);
    }
    clearTimeout(timer);
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
