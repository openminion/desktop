import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_EXECUTABLE;
assert.ok(executable, "Set OPENMINION_EXECUTABLE to the Core runtime under test.");
const root = await mkdtemp(join(tmpdir(), "openminion-commands-electron-"));
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
await mkdir(join(root, "data", "commands"), { recursive: true });
await writeFile(
  join(root, "data", "commands", "desktop-proof.md"),
  "---\ndescription: Desktop command proof\n---\n//Keep spacing: $ARGUMENTS\n",
);
await writeFile(join(root, "data", "commands", "local-proof.md"), "Read @private.txt\n");
app.setPath("userData", root);
process.chdir(root);
process.env.OPENMINION_DESKTOP_HOME = root;
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
let finishing = false;
const timeout = setTimeout(() => {
  console.error("Command Electron check timed out");
  void finish(1);
}, 180_000);
await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (condition) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await evaluate(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Did not settle: ${condition}; ${await evaluate("document.querySelector('main').textContent")}`,
      );
    };
    const submit = async (text) => {
      await waitFor("document.querySelector('#timeline').getAttribute('aria-busy') === 'false'");
      await evaluate(`(() => {
      const composer = document.querySelector('#composer');
      composer.value = ${JSON.stringify(text)};
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      await waitFor("!document.querySelector('#send').disabled");
      await evaluate("document.querySelector('#composer-form').requestSubmit()");
    };
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#setup-demo').disabled",
    );
    await evaluate("document.querySelector('#setup-demo').click()");
    await waitFor("!document.querySelector('#profile-dialog').open");
    await submit("Create a provider-free command test conversation.");
    await waitFor(
      "document.querySelectorAll('.message.assistant').length === 1 && document.querySelector('#cancel').hidden",
    );
    await waitFor("document.querySelector('#timeline')?.getAttribute('aria-busy') === 'false'");
    await submit("/desktop-proof first  second");
    await waitFor(
      "document.querySelectorAll('.message.assistant').length === 2 && document.querySelector('#cancel').hidden",
    );
    const messages = await evaluate(
      "[...document.querySelectorAll('.message.user .message-body')].map(item => item.textContent)",
    );
    assert.ok(
      messages.some((text) => text.includes("//Keep spacing: first  second")),
      JSON.stringify(messages),
    );
    await submit("/local-proof");
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('terminal-local')",
    );
    assert.equal(await evaluate("document.querySelector('#composer').value"), "/local-proof");
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);

    await submit("/tools activate legacy_session_plan");
    await waitFor("!!document.querySelector('#command-result form')");
    assert.equal(
      await evaluate("document.querySelector('#command-result input[type=checkbox]').checked"),
      false,
    );
    for (const width of [760, 1180]) {
      window.setContentSize(width, 800);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      assert.equal(
        await evaluate(`(() => {
        const form = document.querySelector('#command-result form').getBoundingClientRect();
        const composer = document.querySelector('#composer-form').getBoundingClientRect();
        return form.bottom <= composer.top && form.top >= 0;
      })()`),
        true,
      );
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `tool-profile-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    await evaluate("document.querySelector('#command-result form').requestSubmit()");
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('Activated: legacy_session_plan')",
    );
    await submit("/tools status");
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('active  legacy_session_plan')",
    );
    await submit("/tools deactivate legacy_session_plan");
    await waitFor("!!document.querySelector('#command-result form')");
    await evaluate("document.querySelector('#command-result form').requestSubmit()");
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('Deactivated: legacy_session_plan')",
    );
    await submit("/delegate list");
    await waitFor(
      "document.querySelector('#command-title').textContent === 'Delegation' && document.querySelector('#command-result').textContent.includes('Delegation result')",
    );
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    console.log(
      "PASS: real Core custom-command discovery/render/send, expansion refusal, tool activation/status/deactivation, scoped delegation list, and responsive native UI. Provider-free evidence only.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  try {
    await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  } finally {
    if (code === 0) await rm(root, { recursive: true, force: true });
    else console.error(`Command evidence retained at ${root}`);
    app.exit(code);
  }
}
