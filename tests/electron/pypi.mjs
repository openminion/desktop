import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_PYPI_EXECUTABLE;
if (!executable)
  throw new Error("Set OPENMINION_PYPI_EXECUTABLE to an isolated PyPI installation.");
const root = await mkdtemp(join(tmpdir(), "openminion-pypi-electron-"));
app.setPath("userData", root);
process.env.OPENMINION_EXECUTABLE = executable;
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("PyPI GUI test timed out");
  void finish(1);
}, 120_000);
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  try {
    await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  } finally {
    await rm(root, { recursive: true, force: true });
    app.exit(code);
  }
}
await import("../../dist/src/main/index.js");
void check();
async function check() {
  try {
    const window = await loaded;
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `GUI condition did not settle: ${source}; ${await evaluate("document.querySelector('#chat-status').textContent")}`,
      );
    };
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
    assert.equal(await evaluate("typeof window.require"), "undefined");
    assert.match(
      await evaluate("document.querySelector('#chat-status').textContent"),
      /Send a message/,
    );
    assert.equal(await evaluate("document.querySelector('#attach-image').disabled"), true);
    await evaluate(
      `document.querySelector('#composer').value = 'Published runtime GUI proof'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()`,
    );
    await waitFor(
      "document.querySelectorAll('.message').length === 2 && document.querySelector('#cancel').hidden",
    );
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /Published runtime GUI proof/,
    );
    const before = await evaluate("window.openminion.sessions.list({})");
    assert.equal(before.ok, true);
    assert.equal(before.value.sessions.length, 1);
    const sessionId = before.value.sessions[0].sessionId;
    for (const action of ["stop", "start"]) {
      const result = await runCommand(executable, [...args, "daemon", action], 30_000);
      assert.equal(result.exitCode, 0, `daemon ${action}`);
    }
    const reloaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    window.reload();
    await reloaded;
    await waitFor("document.querySelectorAll('.message').length === 2");
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /Published runtime GUI proof/,
    );
    const after = await evaluate("window.openminion.sessions.list({})");
    assert.equal(after.value.sessions[0].sessionId, sessionId);
    await evaluate(
      `document.querySelector('#composer').value = 'GUI follow-up after restart'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()`,
    );
    await waitFor(
      "document.querySelectorAll('.message').length === 4 && document.querySelector('#cancel').hidden",
    );
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /Published runtime GUI proof/,
    );
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /GUI follow-up after restart/,
    );
    await evaluate("document.querySelector('#close-session').click()");
    await waitFor("document.querySelector('#close-session').disabled");
    const closed = await evaluate(
      `window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`,
    );
    assert.equal(closed.value.session.status, "closed");
    console.log(
      "PyPI GUI passed: production main/preload/renderer, local draft, echo turn, durable history after daemon restart and renderer reload, same-session follow-up, canonical close, unavailable attachments.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}
