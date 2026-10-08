import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable =
  process.env.OPENMINION_DELEGATION_E2E_EXECUTABLE ?? process.env.OPENMINION_EXECUTABLE;
if (!executable)
  throw new Error(
    "Set OPENMINION_DELEGATION_E2E_EXECUTABLE to the OpenMinion executable under test.",
  );

const root = await mkdtemp(join(tmpdir(), "openminion-delegation-electron-"));
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
const artifacts = process.env.OPENMINION_E2E_ARTIFACTS;
app.setPath("userData", root);
process.chdir(root);
process.env.OPENMINION_DESKTOP_HOME = root;
process.env.OPENMINION_EXECUTABLE = executable;

const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
let finishing = false;
const timeout = setTimeout(() => {
  console.error("Delegation Electron check timed out");
  void finish(1);
}, 180_000);

await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (condition, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Delegation condition did not settle: ${condition}; ${await evaluate("document.querySelector('#command-result')?.textContent.slice(-2000)")}`,
      );
    };
    const submit = async (text, condition) => {
      await evaluate(`(() => {
        const composer = document.querySelector('#composer');
        composer.value = ${JSON.stringify(text)};
        composer.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('#send').click();
      })()`);
      await waitFor(condition);
    };
    const cli = async (...commandArgs) => {
      const result = await runCommand(executable, [...args, ...commandArgs], 30_000);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };

    await waitFor(
      "document.querySelector('#connection-label').textContent === 'Connected'",
      90_000,
    );
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#setup-demo').disabled",
    );
    await evaluate("document.querySelector('#setup-demo').click()");
    await waitFor("!document.querySelector('#profile-dialog').open");
    await submit(
      "Create the provider-free delegation test conversation.",
      "document.querySelectorAll('.message.assistant').length === 1 && document.querySelector('#cancel').hidden",
    );
    const sessions = await evaluate("window.openminion.sessions.list({})");
    assert.equal(sessions.ok, true);
    assert.equal(sessions.value.sessions.length, 1);
    const sessionId = sessions.value.sessions[0].sessionId;
    const loadedSession = await evaluate(
      `window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`,
    );
    assert.equal(loadedSession.ok, true);
    const parentAgentId = loadedSession.value.session.activeAgentId;
    assert.equal(parentAgentId, "openminion");

    const cliStarted = await cli(
      "agent",
      "delegate",
      "--mode",
      "async",
      "--target-agent-id",
      "agent.worker",
      "--instruction",
      "CLI to Desktop provider-free fixture PRIVATE-CLI-INSTRUCTION",
      "--parent-agent-id",
      parentAgentId,
      "--session-id",
      sessionId,
      "--json",
    );
    assert.equal(cliStarted.ok, true);
    const cliTaskId = cliStarted.task_id;
    await submit(
      `/delegate inspect ${cliTaskId}`,
      "document.querySelector('#command-title').textContent === 'Delegation' && document.querySelector('.delegation-inspection')",
    );
    const cliToDesktop = await evaluate(`(() => ({
      text: document.querySelector('#command-result').textContent,
      task: document.querySelector('.delegation-node-details').textContent,
      groupRole: document.querySelector('.delegation-tree').getAttribute('role'),
      groupLabel: document.querySelector('.delegation-tree').getAttribute('aria-label'),
      nodes: [...document.querySelectorAll('.delegation-tree button')].map(item => ({text:item.textContent, pressed:item.getAttribute('aria-pressed')})),
      messages: document.querySelectorAll('.message').length
    }))()`);
    assert.equal(cliToDesktop.groupRole, "group");
    assert.match(cliToDesktop.groupLabel, /participants/i);
    assert.equal(cliToDesktop.nodes.length, 2);
    assert.ok(cliToDesktop.nodes.some((node) => node.pressed === "true"));
    assert.match(cliToDesktop.task, new RegExp(cliTaskId));
    assert.doesNotMatch(cliToDesktop.text, /PRIVATE-CLI-INSTRUCTION/);
    assert.match(cliToDesktop.text, /Child conversation: not_recorded/);
    assert.equal(cliToDesktop.messages, 2, "Native delegation inspection must not submit a turn");

    const timelineControl = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(item => item.textContent === 'Show protocol timeline');
      button.scrollIntoView({block: 'nearest'});
      return {tag: button.tagName, tabIndex: button.tabIndex};
    })()`);
    assert.deepEqual(timelineControl, { tag: "BUTTON", tabIndex: 0 });
    await evaluate(`([...document.querySelectorAll('button')]
      .find(item => item.textContent === 'Show protocol timeline')).click()`);
    await waitFor("!document.querySelector('.delegation-timeline').hidden");
    const timelineText = await evaluate(
      "document.querySelector('.delegation-timeline').textContent",
    );
    assert.match(timelineText, /job\.start/);
    assert.doesNotMatch(timelineText, /PRIVATE-CLI-INSTRUCTION/);

    let terminal;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      terminal = await cli(
        "agent",
        "delegate-result",
        "--task-id",
        cliTaskId,
        "--parent-agent-id",
        parentAgentId,
        "--session-id",
        sessionId,
        "--json",
      );
      if (!["pending", "running"].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(terminal?.status, "completed");
    await submit(
      `/delegate inspect ${cliTaskId}`,
      "document.querySelector('.delegation-node-details')?.textContent.includes('State: SUCCESS')",
    );
    assert.doesNotMatch(
      await evaluate("document.querySelector('#command-result').textContent"),
      /PRIVATE-CLI-INSTRUCTION/,
    );
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, "desktop-delegation.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }

    await submit(
      "/delegate async agent.worker Desktop to CLI provider-free fixture PRIVATE-DESKTOP-INSTRUCTION",
      "document.querySelector('#command-title').textContent === 'Delegation' && /Delegation [0-9a-f-]+ · running/.test(document.querySelector('#command-result').textContent)",
    );
    const desktopText = await evaluate("document.querySelector('#command-result').textContent");
    const desktopTaskId = desktopText.match(/Delegation ([0-9a-f-]+) · running/)?.[1];
    assert.ok(desktopTaskId, desktopText);
    const cliInspected = await cli(
      "agent",
      "delegate-inspect",
      "--task-id",
      desktopTaskId,
      "--parent-agent-id",
      parentAgentId,
      "--session-id",
      sessionId,
      "--json",
    );
    assert.equal(cliInspected.ok, true);
    assert.equal(cliInspected.outputs.task.task_id, desktopTaskId);
    assert.equal(cliInspected.outputs.authority, "session_task_owner");
    assert.ok(cliInspected.outputs.timeline.length >= 2);
    assert.doesNotMatch(JSON.stringify(cliInspected), /PRIVATE-DESKTOP-INSTRUCTION/);

    await submit(
      "/delegate inspect missing-delegation-task",
      "document.querySelector('#command-title').textContent === 'Delegation' && document.querySelector('#command-result').textContent.includes('UPSTREAM_ERROR')",
    );
    assert.match(
      await evaluate("document.querySelector('#command-result').textContent"),
      /UPSTREAM_ERROR/,
    );
    await submit(
      "/help /delegate",
      "document.querySelector('#command-result').textContent.includes('/delegate —')",
    );
    assert.match(
      await evaluate("document.querySelector('#command-result').textContent"),
      /inspect <task-id>/,
    );

    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth > innerWidth"),
        false,
        `Delegation UI overflows at ${width}x${height}`,
      );
    }

    console.log(
      "PASS: same-root CLI-to-Desktop and Desktop-to-CLI delegation start/inspect, owner scope, structural timeline, typed error, keyboard focus, discoverability, privacy, and responsive layout.",
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
    else console.error(`Delegation evidence retained at ${root}`);
    app.exit(code);
  }
}
