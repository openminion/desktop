// Opt-in paid-provider acceptance. The selected profile is read, never edited.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, dialog } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_PYPI_EXECUTABLE;
const profilePath = process.env.OPENMINION_E2E_PROFILE;
if (!executable || !profilePath)
  throw new Error(
    "Set OPENMINION_PYPI_EXECUTABLE and OPENMINION_E2E_PROFILE for an authorized live-provider test.",
  );
const originalProfile = await readFile(profilePath, "utf8");
const profile = JSON.parse(originalProfile);
const agentId = profile.default_agent;
assert.equal(typeof agentId, "string");
const root = await mkdtemp(join(tmpdir(), "desktop-live-profile-"));
app.setPath("userData", root);
process.env.OPENMINION_DESKTOP_HOME = root;
process.env.OPENMINION_EXECUTABLE = executable;
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
const loaded = new Promise((resolve) =>
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  }),
);
let finishing = false;
const timeout = setTimeout(() => {
  console.error("Live-profile GUI test timed out");
  void finish(1);
}, 300_000);
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
await import("../../dist/src/main/bootstrap.js");
void check();
async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Live GUI condition did not settle: ${source}`);
    };
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#profile-import').disabled",
    );
    const picker = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [profilePath] });
      await evaluate("document.querySelector('#profile-import').click()");
      await waitFor(
        "document.querySelector('#profile-status').textContent.startsWith('Saved and applied')",
      );
    } finally {
      dialog.showOpenDialog = picker;
    }
    const settings = await evaluate("window.openminion.profiles.read()");
    assert.equal(settings.ok, true);
    assert.equal(settings.value.defaultAgent, agentId);
    assert.equal(settings.value.agents.find((agent) => agent.id === agentId).keyConfigured, true);
    assert.equal(await evaluate("document.querySelector('#profile-key').value"), "");
    await evaluate("document.querySelector('#close-settings').click()");
    const send = async (text, count) => {
      await evaluate(
        `document.querySelector('#composer').value = ${JSON.stringify(text)}; document.querySelector('#composer').dispatchEvent(new Event('input'))`,
      );
      await waitFor("!document.querySelector('#send').disabled");
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        `document.querySelectorAll('.message.assistant').length === ${count} && document.querySelector('#cancel').hidden && document.querySelector('#composer').value === ''`,
      );
      return evaluate(
        "[...document.querySelectorAll('.message.assistant .message-body')].at(-1).textContent",
      );
    };
    const first = await send(
      "Remember LANTERN-482 for this conversation. What is 17 multiplied by 23? Reply with only the result. Do not use tools.",
      1,
    );
    assert.match(first, /\b391\b/);
    const sessions = await evaluate("window.openminion.sessions.list({})");
    assert.equal(sessions.ok, true);
    assert.equal(sessions.value.sessions.length, 1);
    const sessionId = sessions.value.sessions[0].sessionId;
    window.webContents.reload();
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    await waitFor(
      "document.querySelector('#connection-label').textContent === 'Connected' && document.querySelectorAll('#session-list button').length > 0",
    );
    await evaluate("document.querySelector('#session-list button').click()");
    await waitFor(
      "document.querySelectorAll('.message.assistant').length === 1 && !document.querySelector('#composer').disabled",
    );
    const second = await send(
      "What code did I ask you to remember? Reply with just that code. Do not use tools.",
      2,
    );
    assert.match(second, /LANTERN-482/);
    const shown = await runCommand(
      executable,
      [...args, "sessions", "show", sessionId, "--json"],
      30_000,
    );
    assert.equal(shown.exitCode, 0);
    assert.equal(JSON.parse(shown.stdout).agent, agentId);
    const transcript = await runCommand(
      executable,
      [...args, "export", "transcript", "--session-id", sessionId, "--format", "md"],
      30_000,
    );
    assert.equal(transcript.exitCode, 0);
    assert.match(transcript.stdout, /391/);
    assert.match(transcript.stdout, /LANTERN-482/);
    assert.ok((await readFile(profilePath, "utf8")) === originalProfile, "Source profile changed");
    const artifacts = process.env.OPENMINION_E2E_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, "live-profile-chat.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    console.log(
      `PASS: live ${agentId} profile import, private key readback, arithmetic reply, renderer reload, same-session recall and independent CLI transcript/agent verification. Source profile unchanged.`,
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}
