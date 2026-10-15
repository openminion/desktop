import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, ClipboardItem, clipboard } from "electron";
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
    await submit("/graph");
    await waitFor(
      "[...document.querySelectorAll('#command-result button')].some(button => button.textContent === 'Check readiness')",
    );
    await evaluate(`(() => {
      const composer = document.querySelector('#composer');
      composer.value = 'Keep this unsent graph draft';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#command-result button')].find(button => button.textContent === 'Check readiness').focus();
    })()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('GraphFakos installed:')",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      "Graph status",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Keep this unsent graph draft",
    );
    const graph = await runCommand(executable, [...args, "graph", "status"], 30_000);
    assert.equal(graph.exitCode, 0, graph.stderr);
    assert.equal(
      await evaluate("document.querySelector('#command-result p').textContent"),
      graph.stdout,
    );
    const previousClipboard = await Promise.all(
      (await clipboard.read()).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
    try {
      await evaluate("document.querySelector('#command-result button').click()");
      await waitFor("document.querySelector('#command-result button').textContent === 'Copied'");
      assert.equal(await clipboard.readText(), graph.stdout);
    } finally {
      await clipboard.write(previousClipboard);
    }
    for (const width of [760, 1180]) {
      window.setContentSize(width, 800);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await evaluate(
        "document.querySelector('#command-result button').scrollIntoView({ block: 'end' })",
      );
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      if (process.env.OPENMINION_E2E_ARTIFACTS)
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `graph-status-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
    }
    await evaluate("document.querySelector('#close-command').click()");
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
        return form.bottom <= composer.top + 0.5 && form.top >= 0;
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
    await submit("/sessions");
    await waitFor("!!document.querySelector('.session-option[aria-current=true]')");
    const listed = await runCommand(executable, [...args, "sessions", "list", "--json"], 30_000);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const catalog = JSON.parse(listed.stdout);
    const activeId = await evaluate(
      "document.querySelector('.session-option[aria-current=true] > span').textContent",
    );
    const active = catalog.find((item) => item.id === activeId);
    assert.ok(active);
    const facts = await evaluate(
      "document.querySelector('.session-option[aria-current=true] small').textContent",
    );
    assert.ok(facts.includes(`Channel: ${active.channel}`));
    assert.ok(facts.includes(`Messages: ${active.turns}`));
    assert.ok(facts.includes(`Agent: ${active.agent}`));
    await evaluate("document.querySelector('.session-option[aria-current=true]').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await waitFor(
      "document.querySelector('#command-panel').hidden && document.querySelector('#timeline').getAttribute('aria-busy') === 'false'",
    );
    const changed = await runCommand(
      executable,
      [...args, "sessions", "set-status", activeId, "paused"],
      30_000,
    );
    assert.equal(changed.exitCode, 0, changed.stderr);
    const detail = await runCommand(
      executable,
      [...args, "sessions", "show", activeId, "--json"],
      30_000,
    );
    assert.equal(detail.exitCode, 0, detail.stderr);
    const persisted = JSON.parse(detail.stdout);
    await submit("/status");
    await waitFor(
      "document.querySelector('#command-result').textContent.includes('State: paused')",
    );
    const report = await evaluate("document.querySelector('#command-result').textContent");
    assert.ok(report.includes(`Messages: ${persisted.turns}`));
    assert.ok(report.includes(`Updated: ${persisted.updated_at}`));
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);
    await submit("/sessions");
    await waitFor("!!document.querySelector('.session-option[aria-current=true]')");
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await evaluate("document.querySelector('.session-option').scrollIntoView({ block: 'end' })");
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      assert.equal(
        await evaluate(`(() => {
        const option = document.querySelector('.session-option').getBoundingClientRect();
        const composer = document.querySelector('#composer-form').getBoundingClientRect();
        return option.top >= 0 && option.bottom <= composer.top;
      })()`),
        true,
      );
      if (process.env.OPENMINION_E2E_ARTIFACTS)
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `sessions-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
    }
    console.log(
      "PASS: real Core graph readiness/clipboard, custom-command discovery/render/send, expansion refusal, tool activation/status/deactivation, scoped delegation list, fresh CLI session metadata, keyboard session selection, and responsive native UI. Provider-free evidence only.",
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
