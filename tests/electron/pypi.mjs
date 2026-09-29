import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { app, clipboard, dialog, shell } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";
import { DESKTOP_ALIASES, DESKTOP_COMMANDS } from "../../dist/src/renderer/app.js";

const executable = process.env.OPENMINION_PYPI_EXECUTABLE;
if (!executable)
  throw new Error("Set OPENMINION_PYPI_EXECUTABLE to an isolated PyPI installation.");
const root = await mkdtemp(join(tmpdir(), "openminion-pypi-electron-"));
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
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("PyPI GUI test timed out");
  void finish(1);
}, 360_000);
let finishing = false;
let provider = null;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  try {
    await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  } finally {
    if (provider) {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    }
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
    const waitFor = async (source, attempts = 300) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `GUI condition did not settle: ${source}; ${await evaluate("document.querySelector('#chat-status').textContent + ' / ' + document.querySelector('#profile-status').textContent + ' / command: ' + document.querySelector('#command-title').textContent + ' / ' + document.querySelector('#command-result').textContent.slice(0, 500) + ' / open: ' + !document.querySelector('#command-panel').hidden + ' / timeline: ' + document.querySelector('#timeline').textContent.slice(-1800)")}`,
      );
    };
    const click = async (id) => {
      const point = await evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        element.scrollIntoView({block:'nearest'});
        const rect = element.getBoundingClientRect();
        return {x:Math.round(rect.x + rect.width / 2), y:Math.round(rect.y + rect.height / 2)};
      })()`);
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...point,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...point,
      });
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
    };
    const fill = async (text) =>
      evaluate(
        `document.querySelector('#composer').value = ${JSON.stringify(text)}; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#composer').focus()`,
      );
    const key = async (keyCode, modifiers = []) => {
      app.focus({ steal: true });
      window.focus();
      window.webContents.focus();
      await waitFor("document.hasFocus()");
      await evaluate("document.querySelector('#composer').focus()");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (keyCode === "Return" && (!modifiers.length || modifiers.includes("shift")))
        window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const command = async (text, title) => {
      await fill(text);
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        `document.querySelector('#command-title').textContent === ${JSON.stringify(title)}`,
      );
      await evaluate("document.querySelector('#close-command').click()");
    };
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'", 900);
    await waitFor(
      "document.querySelector('#profile-dialog').open && document.querySelector('#setup-provider').options.length > 0 && !document.querySelector('#setup-demo').disabled",
    );
    await evaluate("document.querySelector('#setup-demo').click()");
    await waitFor("!document.querySelector('#profile-dialog').open");
    const inspectDaemon = async (kind) => {
      await evaluate(
        "if (document.querySelector('#diagnostics-dialog').open) document.querySelector('#close-diagnostics').click()",
      );
      await evaluate("document.querySelector('#connection-details').open = true");
      if (!(await evaluate("document.querySelector('#profile-dialog').open")))
        await click("show-runtime-settings");
      await waitFor("!document.querySelector('#close-settings').disabled");
      await click("settings-runtime-button");
      await click(`show-daemon-${kind}`);
      await waitFor(
        "!document.querySelector('#show-daemon-status').disabled && !!document.querySelector('.diagnostic-output')",
      );
      return evaluate("document.querySelector('.diagnostic-output').textContent");
    };
    const chatBeforeDiagnostics = await evaluate(`({
      content:document.querySelector('#conversation').innerHTML,
      scroll:document.querySelector('#conversation').scrollTop,
      draft:document.querySelector('#composer').value
    })`);
    const cliStatus = await runCommand(executable, [...args, "daemon", "status"], 30_000);
    assert.equal(cliStatus.exitCode, 0);
    assert.equal(await inspectDaemon("status"), cliStatus.stdout.trim());
    const cliFacts = JSON.parse(
      (await runCommand(executable, [...args, "daemon", "status", "--json"], 30_000)).stdout,
    );
    await appendFile(cliFacts.log_file, "\nDesktop diagnostic fixture <literal>\n");
    assert.match(await inspectDaemon("logs"), /Desktop diagnostic fixture <literal>/);
    assert.equal(await evaluate("document.querySelector('.diagnostic-output').children.length"), 0);
    await appendFile(cliFacts.log_file, "Desktop refresh fixture\n");
    await evaluate(
      "[...document.querySelectorAll('#diagnostics-result button')].find(button => button.textContent === 'Refresh').click()",
    );
    await waitFor(
      "document.querySelector('.diagnostic-output')?.textContent.includes('Desktop refresh fixture')",
    );
    await evaluate(
      "[...document.querySelectorAll('#diagnostics-result button')].find(button => button.textContent === 'Copy').click()",
    );
    await waitFor(
      "[...document.querySelectorAll('#diagnostics-result button')].some(button => button.textContent === 'Copied')",
    );
    assert.equal(
      clipboard.readText(),
      await evaluate("document.querySelector('.diagnostic-output').textContent"),
    );
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1800, 1000],
    ]) {
      window.setContentSize(width, height);
      await waitFor(`innerWidth === ${width}`);
      const diagnostics = await evaluate(`(() => {
        const dialog = document.querySelector('#diagnostics-dialog');
        const output = dialog.querySelector('.diagnostic-output');
        const bounds = dialog.getBoundingClientRect();
        output.scrollTop = output.scrollHeight;
        const actions = dialog.querySelector('.diagnostic-actions').getBoundingClientRect();
        const close = document.querySelector('#close-diagnostics').getBoundingClientRect();
        return {modal:dialog.matches(':modal'), outsideChat:!document.querySelector('#conversation').contains(output),
          fits:bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          controlsVisible:actions.top >= bounds.top && actions.bottom <= bounds.bottom && close.top >= bounds.top,
          scrollable:getComputedStyle(output).overflowY === 'auto',
          buttons:[...document.querySelectorAll('.daemon-actions .diagnostic-control')].map(button => ({
            height:button.getBoundingClientRect().height,fontSize:getComputedStyle(button).fontSize
          }))};
      })()`);
      assert.equal(diagnostics.modal, true);
      assert.equal(diagnostics.outsideChat, true);
      assert.equal(diagnostics.fits, true);
      assert.equal(diagnostics.controlsVisible, true);
      assert.equal(diagnostics.scrollable, true);
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `diagnostics-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      assert.equal(diagnostics.buttons.length, 2);
      assert.ok(
        diagnostics.buttons.every(
          (button) => button.height >= 30 && button.height <= 34 && button.fontSize === "12px",
        ),
      );
    }
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
      await writeFile(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "daemon-logs.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await evaluate(
      "document.querySelector('#close-diagnostics').click(); document.querySelector('#connection-details').open = false",
    );
    assert.equal(await evaluate("document.querySelector('#diagnostics-dialog').open"), false);
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      chatBeforeDiagnostics.draft,
    );
    assert.equal(
      await evaluate("document.querySelector('#conversation').scrollTop"),
      chatBeforeDiagnostics.scroll,
    );
    assert.equal(
      await evaluate("document.querySelector('#conversation').innerHTML"),
      chatBeforeDiagnostics.content,
    );
    await inspectDaemon("status");
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    await waitFor("document.hasFocus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor("!document.querySelector('#diagnostics-dialog').open");
    assert.equal(await evaluate("document.querySelector('#profile-dialog').open"), true);
    assert.equal(await evaluate("document.querySelector('#settings-runtime').hidden"), false);
    await waitFor("document.activeElement.id === 'show-daemon-status'");
    console.log(
      "PASS: separate modal daemon diagnostics match CLI output; Refresh, Copy, Close, Escape, compact buttons and chat preservation pass at three sizes.",
    );
    await evaluate("document.querySelector('#close-settings').click()");
    await waitFor("!document.querySelector('#profile-dialog').open");
    await fill("   ");
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    await fill("First line");
    await key("Return", ["shift"]);
    assert.equal(await evaluate("document.querySelectorAll('#session-list button').length"), 0);
    assert.equal(await evaluate("document.querySelector('#composer').value"), "First line\n");
    await command("/help", "Focus commands — partial integration");
    await command("/permissions readonly", "Command unavailable");
    assert.equal((await evaluate("window.openminion.sessions.list({})")).value.sessions.length, 0);
    await fill("");
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
    const catalog = await runCommand(
      join(dirname(executable), "python"),
      [
        "-c",
        "import json; from dataclasses import asdict; from openminion.cli.presentation.slash_commands import SLASH_COMMANDS; print(json.dumps([asdict(command) for command in SLASH_COMMANDS]))",
      ],
      30_000,
    );
    assert.equal(catalog.exitCode, 0);
    const focusCommands = JSON.parse(catalog.stdout);
    for (const command of DESKTOP_COMMANDS)
      assert.ok(
        focusCommands.some((item) => item.name === command.name),
        command.name,
      );
    for (const [alias, name] of Object.entries(DESKTOP_ALIASES))
      assert.ok(focusCommands.find((item) => item.name === name)?.aliases.includes(alias), alias);
    const missingCommands = focusCommands.filter(
      (item) => !DESKTOP_COMMANDS.some((command) => command.name === item.name),
    );
    console.log(
      `PARTIAL: Desktop lists ${DESKTOP_COMMANDS.length}/${focusCommands.length} installed Focus commands; ${missingCommands.length} are not in the Desktop menu. This catalog check does not verify argument or effect parity.`,
    );
    const parityContract = await readFile(
      new URL("../../docs/focus-parity.md", import.meta.url),
      "utf8",
    );
    for (const command of focusCommands)
      assert.ok(
        parityContract.includes(`\`${command.name}\``),
        `Track Focus command ${command.name}`,
      );
    const reportCommand = async (text, title) => {
      await fill(text);
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        `document.querySelector('#command-title').textContent === ${JSON.stringify(title)} && !/Loading from OpenMinion|Preparing the saved conversation/.test(document.querySelector('#command-result').textContent)`,
      );
      return evaluate("document.querySelector('#command-result').textContent");
    };
    const agents = await evaluate("window.openminion.reports.read({kind:'agents'})");
    assert.equal(agents.ok, true, JSON.stringify(agents));
    assert.ok(agents.value.agents.length > 0);
    const agentId = agents.value.agents[0].id;
    assert.ok((await reportCommand(`/agent ${agentId}`, "Agents")).includes(agentId));
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      // Resize can move later content below the fold; reveal it through the chat scroll area.
      await evaluate("document.querySelector('#command-panel').scrollIntoView({block:'end'})");
      const layout = await evaluate(`(() => {
        const result = document.querySelector('#command-panel');
        const bounds = result.getBoundingClientRect();
        const composer = document.querySelector('#composer-form').getBoundingClientRect();
        const timeline = document.querySelector('#timeline').getBoundingClientRect();
        return {popover:result.hasAttribute('popover'), hidden:result.hidden, top:bounds.top,
          bottom:bounds.bottom, width:bounds.width, composerTop:composer.top, composerWidth:composer.width,
          timelineBottom:timeline.bottom, scrollbarWidth:document.querySelector('#conversation').offsetWidth-document.querySelector('#conversation').clientWidth, inConversation:document.querySelector('#conversation').contains(result), overflow:document.documentElement.scrollWidth > innerWidth};
      })()`);
      assert.equal(layout.popover, false);
      assert.equal(layout.hidden, false);
      assert.equal(layout.overflow, false);
      assert.equal(layout.inConversation, true);
      assert.ok(
        layout.top >= layout.timelineBottom && layout.bottom <= layout.composerTop,
        JSON.stringify(layout),
      );
      assert.ok(
        Math.abs(layout.width + layout.scrollbarWidth - layout.composerWidth) < 1,
        JSON.stringify(layout),
      );
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `inline-agents-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    assert.equal(
      await reportCommand("/agents missing-test-agent", "Agents"),
      "No matching agents.",
    );
    const tools = await evaluate("window.openminion.reports.read({kind:'tools'})");
    assert.equal(tools.ok, true, JSON.stringify(tools));
    const cliTools = await runCommand(executable, [...args, "tools", "list"], 30_000);
    assert.equal(cliTools.exitCode, 0);
    assert.deepEqual(
      tools.value.tools.map((tool) => tool.name).sort(),
      JSON.parse(cliTools.stdout)
        .tools.map((tool) => tool.name)
        .sort(),
    );
    assert.ok((await reportCommand("/tool", "Tools")).includes(tools.value.tools[0].name));
    const cliSkills = await runCommand(executable, [...args, "skill", "list", "--json"], 30_000);
    assert.equal(cliSkills.exitCode, 0);
    const skillIds = JSON.parse(cliSkills.stdout).skills.map((skill) => skill.skill_id);
    const skillText = await reportCommand("/skills", "Skills");
    if (skillIds.length) {
      assert.ok(skillText.includes(skillIds[0]));
      assert.ok((await reportCommand(`/skills ${skillIds[0]}`, "Skills")).includes(skillIds[0]));
    } else assert.equal(skillText, "(no skills)");
    const mcpText = await reportCommand("/mcp", "MCP");
    assert.ok(mcpText.startsWith("MCP:\n"));
    assert.ok(mcpText.includes("configured"));
    assert.ok(mcpText.includes("registered"));
    const graphHelp = await runCommand(executable, [...args, "graph", "--help"], 30_000);
    assert.equal(graphHelp.exitCode, 0);
    assert.equal(await reportCommand("/graph", "Graph viewer"), graphHelp.stdout);
    const tokens = await runCommand(
      executable,
      [...args, "status", "tokens", "--session-id", sessionId],
      30_000,
    );
    const tokenText = await reportCommand("/tokens", "Token usage");
    if (tokens.exitCode === 0) assert.equal(tokenText, tokens.stdout);
    else {
      assert.equal(tokens.exitCode, 2);
      assert.ok(tokens.stderr.includes(`Session '${sessionId}' was not found.`));
      assert.ok(tokenText.includes("could not read saved token usage"));
      console.log(
        "LIMITATION: pinned CLI token reporting cannot find the daemon-created session; Desktop reports it unavailable.",
      );
    }
    const saveDialog = dialog.showSaveDialog;
    try {
      const exportPath = join(root, "conversation.md");
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
      assert.equal(await reportCommand("/export", "Export conversation"), "Conversation saved.");
      const exported = await runCommand(
        executable,
        [...args, "export", "transcript", "--session-id", sessionId, "--format", "md"],
        30_000,
      );
      assert.equal(exported.exitCode, 0);
      assert.equal(
        (await readFile(exportPath, "utf8")).replace(/^Generated: .*\n/m, ""),
        exported.stdout.replace(/^Generated: .*\n/m, ""),
      );
      dialog.showSaveDialog = async () => ({ canceled: true });
      await evaluate("document.querySelector('#close-command').click()");
      await fill("/export");
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        "document.querySelector('#command-result').textContent === 'Export cancelled.'",
      );
    } finally {
      dialog.showSaveDialog = saveDialog;
    }
    await evaluate("document.querySelector('#close-command').click()");
    console.log(
      "PASS: Desktop subset names/aliases exist in installed Focus; daemon tools, canonical tokens, and native transcript export checked.",
    );
    await fill("/tasks");
    await evaluate("document.querySelector('#send').click()");
    await waitFor("document.querySelector('#schedule-name') !== null");
    await evaluate(`document.querySelector('#schedule-name').value = 'GUI scheduled work';
      document.querySelector('#schedule-instruction').value = 'Isolated future acceptance task. Do not contact external systems.';
      document.querySelector('#schedule-value').value = '2099-02-01T12:00';
      document.querySelector('.schedule-form').requestSubmit()`);
    await waitFor(
      "[...document.querySelectorAll('.runtime-task h3')].some(node => node.textContent === 'GUI scheduled work')",
    );
    const guiWork = await runCommand(
      executable,
      [...args, "tasks", "list", "--session", sessionId, "--json"],
      30_000,
    );
    assert.equal(guiWork.exitCode, 0);
    const guiScheduled = JSON.parse(guiWork.stdout).tasks.find(
      (task) => task.title === "GUI scheduled work",
    );
    assert.ok(guiScheduled, "GUI-created schedule must exist in canonical CLI inventory");
    assert.match(guiScheduled.due_at, /^2099-02-/);
    await evaluate(
      `[...document.querySelectorAll('.runtime-task')].find(node => node.querySelector('h3').textContent === 'GUI scheduled work').querySelectorAll('button')[1].click()`,
    );
    await waitFor("document.querySelector('.runtime-task')?.textContent.includes('paused')");
    const guiPaused = await runCommand(
      executable,
      [...args, "tasks", "show", guiScheduled.id, "--session", sessionId, "--json"],
      30_000,
    );
    assert.equal(JSON.parse(guiPaused.stdout).task.lifecycle_state, "paused");
    await evaluate("document.querySelector('#close-command').click()");
    console.log(
      "PASS: DGUI-16 GUI schedule creation and pause match canonical CLI state without executing future work.",
    );
    const scheduled = await runCommand(
      executable,
      [
        ...args,
        "tools",
        "run",
        "task.schedule",
        "--runtime-source",
        "inproc",
        "--session",
        sessionId,
        "--confirm",
        "--json",
        JSON.stringify({
          instruction: "Isolated Desktop task-control acceptance fixture.",
          name: "Desktop work controls",
          schedule: { kind: "at", at: "2099-01-01T00:00:00Z" },
        }),
      ],
      30_000,
    );
    assert.equal(scheduled.exitCode, 0, scheduled.stdout || scheduled.stderr);
    const work = await evaluate(
      `window.openminion.tasks.control({sessionId:${JSON.stringify(sessionId)},action:'list'})`,
    );
    assert.equal(work.ok, true, JSON.stringify(work));
    assert.ok(work.value.tasks.length > 0, scheduled.stdout);
    const taskId = work.value.tasks.find((task) => task.title === "Desktop work controls").id;
    const workCommand = async (text, state) => {
      await fill(text);
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        `[...document.querySelectorAll('.runtime-task')].find(node => node.textContent.includes(${JSON.stringify(taskId)}))?.textContent.includes(${JSON.stringify(state)})`,
      );
    };
    await command("/tasks pause", "Task command");
    await workCommand("/tasks", taskId);
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await waitFor(`window.innerWidth === ${width}`);
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
        true,
      );
      const artifactRoot = process.env.OPENMINION_E2E_ARTIFACTS;
      if (artifactRoot) {
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(
          join(artifactRoot, `work-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }

    await evaluate(
      "Array.from(document.querySelectorAll('.runtime-task')).find(node => node.querySelector('h3').textContent === 'Desktop work controls').querySelectorAll('button')[1].click()",
    );
    await waitFor(
      "[...document.querySelectorAll('.runtime-task')].find(node => node.querySelector('h3').textContent === 'Desktop work controls')?.textContent.includes('paused')",
    );
    await workCommand(`/task resume ${taskId}`, "active");
    await workCommand(`/tasks cancel ${taskId}`, "cancelled");
    const canonicalWork = await runCommand(
      executable,
      [...args, "tasks", "show", taskId, "--session", sessionId, "--json"],
      30_000,
    );
    assert.equal(canonicalWork.exitCode, 0);
    assert.equal(JSON.parse(canonicalWork.stdout).task.lifecycle_state, "cancelled");
    await evaluate("document.querySelector('#close-command').click()");
    assert.equal(
      (await evaluate(`window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`))
        .value.messages.length,
      2,
    );
    console.log(
      "PASS: public CLI creates work; Desktop lists, pauses, resumes and cancels; CLI confirms durable state without extra model turns.",
    );
    await waitFor("document.querySelector('.message-profile') !== null");
    const savedReply = (
      await evaluate(`window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`)
    ).value.messages.find((message) => message.role === "assistant");
    assert.equal(
      await evaluate("document.querySelector('.message-profile').textContent"),
      savedReply.profileName,
    );
    const prefix = `${savedReply.profileName}: `;
    assert.equal(
      await evaluate("document.querySelector('.message.assistant .message-body').textContent"),
      savedReply.body.startsWith(prefix) ? savedReply.body.slice(prefix.length) : savedReply.body,
    );
    assert.equal(await evaluate("document.querySelector('#chat-status').textContent"), "");
    await fill("/status");
    await evaluate("document.querySelector('#send').click()");
    await waitFor("document.querySelector('#command-title').textContent === 'Task status'");
    const statusLayout = await evaluate(`(() => {
      const result = document.querySelector('#command-panel');
      const history = document.querySelector('#timeline');
      return {sameScroll:result.parentElement === history.parentElement,
        gap:result.getBoundingClientRect().top-history.getBoundingClientRect().bottom,
        border:getComputedStyle(result).borderTopWidth};
    })()`);
    assert.equal(statusLayout.sameScroll, true);
    assert.ok(
      statusLayout.gap >= 0 && statusLayout.gap <= 32,
      "Status directly follows chat messages",
    );
    assert.equal(statusLayout.border, "0px");
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await writeFile(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "status-after-chat.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await evaluate("document.querySelector('#close-command').click()");
    console.log(
      "PASS: status follows real chat messages in the shared scroll area without an overlay.",
    );

    console.log(
      "PASS: empty/whitespace draft, real Enter, help, unsupported command, first click send.",
    );
    await fill("Unsent draft for first task");
    await evaluate("document.querySelector('#new-session').click()");
    await waitFor(
      "document.querySelector('#chat-status').textContent.includes('Send a message to start')",
    );
    assert.equal(await evaluate("document.querySelector('#composer').value"), "");
    await fill("Second task via keyboard");
    await key("Return");
    await waitFor(
      "document.querySelectorAll('.message').length === 2 && document.querySelector('#cancel').hidden",
    );
    const multiple = await evaluate("window.openminion.sessions.list({})");
    assert.equal(multiple.value.sessions.length, 2);
    const secondId = multiple.value.sessions.find((item) => item.sessionId !== sessionId).sessionId;
    await fill("Unsent draft for second task");
    await evaluate("document.querySelectorAll('#session-list button')[1].click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Published runtime GUI proof')",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Unsent draft for first task",
    );
    await evaluate("document.querySelectorAll('#session-list button')[0].click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Second task via keyboard')",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Unsent draft for second task",
    );
    await click("session-search");
    await window.webContents.insertText(sessionId.toUpperCase());
    await waitFor("document.querySelectorAll('#session-list button').length === 1");
    assert.equal(await evaluate("document.activeElement.id"), "session-search");
    assert.equal(
      await evaluate("document.querySelector('#session-search-count').textContent"),
      "1 of 2 tasks",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Unsent draft for second task",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#timeline').textContent.includes('Second task via keyboard')",
      ),
      true,
    );
    // Tab past Clear to the matching task and open it with native keyboard input.
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    await waitFor("document.hasFocus()");
    await click("session-search");
    for (const selector of ["#clear-session-search", "#session-list button"]) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await waitFor(`document.activeElement.matches(${JSON.stringify(selector)})`);
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Published runtime GUI proof')",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Unsent draft for first task",
    );
    await fill("Continue task found by sidebar search");
    await key("Return");
    await waitFor(
      "document.querySelectorAll('.message').length === 4 && document.querySelector('#cancel').hidden",
    );
    const searchTranscript = await runCommand(
      executable,
      [...args, "export", "transcript", "--session-id", sessionId, "--format", "jsonl"],
      30000,
    );
    assert.equal(searchTranscript.exitCode, 0);
    assert.match(searchTranscript.stdout, /Continue task found by sidebar search/);
    assert.equal((await evaluate("window.openminion.sessions.list({})")).value.sessions.length, 2);
    assert.equal(
      await evaluate("document.querySelector('#session-search').value"),
      sessionId.toUpperCase(),
    );
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      await writeFile(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "task-search.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await click("clear-session-search");
    assert.equal(await evaluate("document.activeElement.id"), "session-search");
    await evaluate("document.querySelectorAll('#session-list button')[0].click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Second task via keyboard')",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Unsent draft for second task",
    );
    console.log(
      "PASS: native sidebar ID search, keyboard selection, preserved drafts, same-session continuation and CLI transcript readback.",
    );
    await command("/clear", "Chat cleared");
    assert.equal(await evaluate("document.querySelectorAll('.message').length"), 0);
    assert.equal(
      (await evaluate(`window.openminion.sessions.load({sessionId:${JSON.stringify(secondId)}})`))
        .value.messages.length,
      2,
    );
    await command("/sessions", "Choose a task");
    await evaluate("document.querySelectorAll('#session-list button')[1].click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Published runtime GUI proof')",
    );
    console.log(
      "PASS: keyboard send, two task histories, task-local drafts, clear without deleting saved messages.",
    );
    // Provision exact renderer sizes without the host's visible-window work-area clamp.
    window.hide();
    try {
      for (const [width, height] of [
        [760, 560],
        [1180, 800],
        [1800, 1000],
      ]) {
        window.setContentSize(width, height);
        await waitFor(`innerWidth === ${width} && innerHeight === ${height}`);
        const bounds = await evaluate(
          `(() => {const box=document.querySelector('#composer-form').getBoundingClientRect();return {right:box.right,bottom:box.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
        );
        assert.equal(bounds.overflow, false);
        assert.ok(bounds.right <= bounds.width && bounds.bottom <= bounds.height);
      }
    } finally {
      window.show();
    }
    console.log("PASS: populated renderer layout at exact minimum, normal and wide sizes.");
    await fill("Draft preserved across outage");
    assert.equal((await runCommand(executable, [...args, "daemon", "stop"], 30_000)).exitCode, 0);
    await evaluate("document.querySelector('#show-connection').click()");
    await waitFor("document.querySelector('#connection-label').textContent === 'Not connected'");
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Draft preserved across outage",
    );
    const stoppedStatus = await runCommand(executable, [...args, "daemon", "status"], 30_000);
    assert.equal(stoppedStatus.exitCode, 1);
    assert.equal(await inspectDaemon("status"), stoppedStatus.stdout.trim());
    const stoppedLogs = await runCommand(
      executable,
      [...args, "daemon", "logs", "--lines", "200"],
      30_000,
    );
    assert.equal(stoppedLogs.exitCode, 0);
    assert.equal(await inspectDaemon("logs"), stoppedLogs.stdout.trim());
    assert.equal((await runCommand(executable, [...args, "daemon", "status"], 30_000)).exitCode, 1);
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Draft preserved across outage",
    );
    await click("close-diagnostics");
    await click("close-settings");
    await waitFor("!document.querySelector('#profile-dialog').open");
    console.log(
      "PASS: GUI diagnostics work during an outage without restarting the daemon or changing the draft.",
    );
    await evaluate("document.querySelector('#retry').click()");
    await waitFor(
      "document.querySelector('#connection-label').textContent === 'Connected' && !document.querySelector('#retry').disabled",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Draft preserved across outage",
    );
    await evaluate("document.querySelector('#connection-details').open = false");
    console.log(
      "PASS: opening connection details detects an outage; reconnect preserves the draft.",
    );
    const reloaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    window.reload();
    await reloaded;
    await waitFor("document.querySelectorAll('#session-list button').length === 2");
    await evaluate("document.querySelectorAll('#session-list button')[1].click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Published runtime GUI proof')",
    );
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /Published runtime GUI proof/,
    );
    const after = await evaluate("window.openminion.sessions.list({})");
    assert.ok(after.value.sessions.some((item) => item.sessionId === sessionId));
    await evaluate(`
      window.historyFlashes = 0;
      window.historyObserver = new MutationObserver(() => {
        if (!document.querySelector('.message') || document.querySelector('.timeline-empty')) window.historyFlashes++;
      });
      window.historyObserver.observe(document.querySelector('#timeline'), {childList:true, subtree:true});
    `);
    await evaluate(
      `document.querySelector('#composer').value = 'GUI follow-up after restart'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()`,
    );
    await waitFor(
      "document.querySelectorAll('.message').length === 4 && document.querySelector('#cancel').hidden && document.querySelector('#timeline').getAttribute('aria-busy') === 'false'",
    );
    await evaluate("window.historyObserver.disconnect()");
    assert.equal(await evaluate("window.historyFlashes"), 0);
    console.log(
      "PASS: conversation stays visible throughout the reply and canonical history refresh.",
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
    await fill("Closed task must not accept this");
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    await key("Return", ["meta"]);
    assert.equal(
      (await evaluate(`window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`))
        .value.messages.length,
      4,
    );
    // Only this isolated test config talks to this local controlled provider.
    let providerMode = "hold";
    let providerText = "Local fixture response";
    let providerCalls = 0;
    let rejectedRequests = 0;
    const providerAuthorizations = [];
    const providerModels = [];
    provider = createServer((req, res) => {
      let input = "";
      req.on("data", (chunk) => {
        input += chunk;
      });
      req.on("end", () => {
        providerCalls += 1;
        providerAuthorizations.push(req.headers.authorization);
        const body = JSON.parse(input);
        providerModels.push(body.model);
        const reply = () => {
          if (providerMode === "error") {
            rejectedRequests += 1;
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "E2E provider rejected the request",
                  type: "invalid_request_error",
                  code: "invalid_api_key",
                },
              }),
            );
          } else if (body.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(
              `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", model: "e2e-fixture", choices: [{ index: 0, delta: { content: providerText }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "e2e", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            );
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "e2e",
                object: "chat.completion",
                model: "e2e-fixture",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: providerText },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            );
          }
        };
        if (providerMode === "hold" && providerCalls === 1) {
          const timer = setTimeout(reply, 10_000);
          res.once("close", () => clearTimeout(timer));
        } else reply();
      });
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = provider.address().port;
    const configPath = join(root, "agents.json");
    const configBeforeProfiles = JSON.parse(await readFile(configPath, "utf8"));
    const importPath = join(root, "test-profile.json");
    await writeFile(
      importPath,
      JSON.stringify({
        agents: { openminion: { name: "openminion", provider: "openai" } },
        default_agent: "openminion",
        providers: {
          openai: {
            base_url: `http://127.0.0.1:${port}/v1`,
            model: "e2e-fixture",
            api_key: "",
            api_key_env: "E2E_API_KEY",
            timeout_seconds: 30,
          },
        },
        runtime: {
          env: { E2E_API_KEY: "e2e-import-key", TAVILY_API_KEY: "e2e-search-key" },
        },
      }),
      { mode: 0o600 },
    );
    await evaluate("document.querySelector('#show-settings').click()");
    await waitFor("!document.querySelector('#profile-import').disabled");
    const nativePicker = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPath] });
    await evaluate("document.querySelector('#profile-import').click()");
    await waitFor(
      "document.querySelector('#profile-status').textContent.startsWith('Saved and applied')",
    );
    dialog.showOpenDialog = nativePicker;
    assert.equal(await evaluate("document.querySelector('#profile-key').value"), "");
    assert.match(await evaluate("document.querySelector('#profile-key').placeholder"), /^Set/);
    assert.equal(await evaluate("document.querySelector('#profile-model').value"), "e2e-fixture");
    const safeProfiles = await evaluate("window.openminion.profiles.read()");
    assert.equal(safeProfiles.ok, true);
    assert.ok(!JSON.stringify(safeProfiles).includes("e2e-import-key"));
    assert.ok(!JSON.stringify(safeProfiles).includes("e2e-search-key"));
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1800, 1000],
    ]) {
      window.setContentSize(width, height);
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
      const bounds = await evaluate(`(() => {
        document.querySelector('.settings-tools').open = true;
        const dialog = document.querySelector('#profile-dialog');
        const save = document.querySelector('#profile-save');
        save.scrollIntoView({block:'nearest'});
        const rect = dialog.getBoundingClientRect();
        return { fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          overflow: dialog.scrollWidth > dialog.clientWidth, reachable: save.getBoundingClientRect().bottom <= innerHeight };
      })()`);
      assert.deepEqual(bounds, { fits: true, overflow: false, reachable: true });
    }
    window.setContentSize(1180, 800);
    await evaluate(`document.querySelector('#profile-model').value = 'e2e-edited';
      document.querySelector('#profile-key').value = 'e2e-edited-key';
      document.querySelector('#profile-save').click()`);
    await waitFor(
      "document.querySelector('#profile-status').textContent.startsWith('Saved and applied') && !document.querySelector('#profile-save').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#profile-key').value"), "");
    const configAfterProfiles = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(configAfterProfiles.runtime.ipc_token, configBeforeProfiles.runtime.ipc_token);
    assert.equal(configAfterProfiles.runtime.ipc_port, configBeforeProfiles.runtime.ipc_port);
    assert.deepEqual(configAfterProfiles.storage, configBeforeProfiles.storage);
    assert.equal(configAfterProfiles.runtime.env.TAVILY_API_KEY, "e2e-search-key");
    assert.equal(
      configAfterProfiles.agents.openminion.provider_config_overrides.api_key,
      "e2e-edited-key",
    );
    await evaluate("document.querySelector('#close-settings').click()");
    assert.ok(
      (await evaluate("window.openminion.sessions.list({})")).value.sessions.some(
        (item) => item.sessionId === sessionId,
      ),
    );
    console.log(
      "PASS: profile import, edit, key privacy, restart, preserved conversations, and responsive Settings.",
    );
    await evaluate("document.querySelector('#new-session').click()");
    await waitFor(
      "document.querySelector('#chat-status').textContent.includes('Send a message to start')",
    );
    await fill("Test cancellation of a delayed request");
    const idleComposerTop = await evaluate(
      "document.querySelector('#composer-form').getBoundingClientRect().top",
    );
    const cancellationSession = (
      await evaluate("window.openminion.sessions.list({})")
    ).value.sessions.find((session) => session.isDraft).sessionId;
    await key("Return", ["meta"]);
    await waitFor(
      "!document.querySelector('#cancel').hidden && !document.querySelector('#cancel').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#composer').value"), "");
    await waitFor(
      "!!document.querySelector('.session-item.selected .session-spinner:not([hidden])')",
    );
    const sidebarActivity = await evaluate(`(() => {
      const row = document.querySelector('.session-item.selected');
      const spinner = row.querySelector('.session-spinner');
      return {label:row.getAttribute('aria-label'), animation:getComputedStyle(spinner).animationName};
    })()`);
    assert.match(sidebarActivity.label, /Working/);
    assert.equal(sidebarActivity.animation, "session-spin");
    await click("session-search");
    await window.webContents.insertText("no matching task");
    await waitFor("document.querySelectorAll('.session-item').length === 0");
    assert.equal(await evaluate("document.querySelector('#cancel').disabled"), false);
    await click("clear-session-search");
    assert.equal(
      await evaluate(
        "!!document.querySelector('.session-item.selected .session-spinner:not([hidden])')",
      ),
      true,
    );
    await evaluate(
      "[...document.querySelectorAll('.session-item')].find(row => !row.classList.contains('selected')).click()",
    );
    await waitFor(
      "!document.querySelector('.session-item.selected .session-spinner:not([hidden])') && !!document.querySelector('.session-item:not(.selected) .session-spinner:not([hidden])')",
    );
    await evaluate(
      "document.querySelector('.session-spinner:not([hidden])').parentElement.click()",
    );
    await waitFor(
      "!document.querySelector('#cancel').disabled && !!document.querySelector('.session-item.selected .session-spinner:not([hidden])')",
    );
    await fill("Draft while waiting for the response");
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    const turnProgress = await evaluate(`(() => {
      const progress = document.querySelector('#chat-progress');
      const request = progress.previousElementSibling;
      const status = document.querySelector('#chat-status').getBoundingClientRect();
      const elapsed = document.querySelector('#chat-elapsed').getBoundingClientRect();
      return {inChat:progress.parentElement.id === 'timeline', hidden:progress.hidden,
        afterRequest:request?.classList.contains('user'),
        gap:progress.getBoundingClientRect().top-request.getBoundingClientRect().bottom,
        timerGap:elapsed.left-status.right,
        composerTop:document.querySelector('#composer-form').getBoundingClientRect().top};
    })()`);
    assert.equal(turnProgress.inChat, true);
    assert.equal(turnProgress.hidden, false);
    assert.equal(turnProgress.afterRequest, true);
    assert.ok(turnProgress.gap >= 0 && turnProgress.gap <= 32);
    assert.ok(turnProgress.timerGap >= 0 && turnProgress.timerGap <= 16);
    assert.equal(turnProgress.composerTop, idleComposerTop);
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await writeFile(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "progress-under-request.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    console.log(
      "PASS: live turn progress and elapsed time follow the request; the composer stays fixed.",
    );

    for (let attempt = 0; providerCalls === 0 && attempt < 100; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      providerCalls > 0,
      "The real daemon must reach the local provider before cancellation",
    );
    assert.equal(
      await evaluate("document.querySelector('#chat-progress').textContent.includes('[act]')"),
      false,
    );
    assert.equal(providerAuthorizations[0], "Bearer e2e-edited-key");
    assert.equal(providerModels[0], "e2e-edited");
    const runningSettings = (await evaluate("window.openminion.profiles.read()")).value;
    const busySave = await evaluate(
      `window.openminion.profiles.save(${JSON.stringify({ revision: "PLACEHOLDER", agentId: "openminion", model: "e2e-fixture", baseUrl: `http://127.0.0.1:${port}/v1`, makeDefault: true, credentials: {} }).replace("PLACEHOLDER", runningSettings.revision)})`,
    );
    assert.equal(busySave.error.code, "settings_busy");
    const busyTaskChange = await evaluate(
      `window.openminion.tasks.control({sessionId:${JSON.stringify(cancellationSession)},action:'pause',taskId:${JSON.stringify(taskId)}})`,
    );
    assert.equal(busyTaskChange.error.code, "session_turn_active");
    const busyTaskRead = await evaluate(
      `window.openminion.tasks.control({sessionId:${JSON.stringify(cancellationSession)},action:'list'})`,
    );
    assert.equal(busyTaskRead.ok, true);

    assert.equal(await evaluate("document.querySelector('#cancel').textContent.trim()"), "Stop");
    assert.equal(await evaluate("document.querySelector('#send').hidden"), true);
    await waitFor(
      "document.querySelector('#chat-elapsed').textContent !== '0s' && document.querySelector('#chat-elapsed').textContent.endsWith('s')",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer-form').getBoundingClientRect().top"),
      idleComposerTop,
    );
    assert.equal(
      await evaluate("document.querySelector('#chat-status').classList.contains('working')"),
      true,
    );
    await evaluate("document.querySelector('#cancel').click()");
    assert.equal(await evaluate("document.querySelector('#cancel').disabled"), true);
    await waitFor(
      "document.querySelector('#cancel').hidden && ['', 'Stopped.', 'Something went wrong. Check the reply before trying again.'].includes(document.querySelector('#chat-status').textContent)",
    );
    await waitFor("!document.querySelector('.session-spinner:not([hidden])')");
    console.log(
      "PASS: session spinner follows the running task across chat switches and clears after completion; progress excludes raw brain diagnostics.",
    );
    const cancellationHistory = await evaluate(
      `window.openminion.sessions.events({sessionId:${JSON.stringify(cancellationSession)}})`,
    );
    assert.equal(cancellationHistory.ok, true);
    assert.ok(
      cancellationHistory.value.events.some((event) => event.eventType === "run.cancel_requested"),
    );
    const terminalState = cancellationHistory.value.events.at(-1).state;
    assert.ok(["completed", "cancelled"].includes(terminalState));
    assert.equal(
      await evaluate("document.querySelector('#chat-status').textContent"),
      terminalState === "completed" ? "" : "Stopped.",
    );
    assert.equal(await evaluate("document.querySelector('#chat-elapsed').textContent"), "");
    assert.equal(await evaluate("document.querySelector('#send').hidden"), false);
    assert.equal(
      await evaluate("document.querySelector('#composer-form').getBoundingClientRect().top"),
      idleComposerTop,
    );
    if (terminalState === "completed")
      console.log(
        "LIMITATION: PyPI acknowledged Cancel but completed the in-flight provider request.",
      );
    console.log("PASS: cancellation request recorded; GUI matches the canonical terminal outcome.");
    providerMode = "error";
    await evaluate("document.querySelector('#new-session').click()");
    await waitFor(
      "document.querySelector('#chat-status').textContent.includes('Send a message to start')",
    );
    await fill("Test provider rejection");
    await evaluate("document.querySelector('#send').click()");
    await waitFor(
      "document.querySelector('#cancel').hidden && ['', 'Stopped.', 'Something went wrong. Check the reply before trying again.'].includes(document.querySelector('#chat-status').textContent)",
    );
    const rejectionText = await evaluate(
      "[...document.querySelectorAll('.message.assistant .message-body')].map(node => node.textContent).join('\\n')",
    );
    console.log("Provider rejection feedback:", rejectionText);
    assert.ok(rejectedRequests > 0);
    assert.match(rejectionText, /401|unauthorized|api.key|error|fail/i);
    providerMode = "success";
    await evaluate("document.querySelector('#new-session').click()");
    await waitFor(
      "document.querySelector('#chat-status').textContent.includes('Send a message to start')",
    );
    await fill("Test successful recovery after provider rejection");
    await evaluate("document.querySelector('#send').click()");
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('#timeline').textContent.includes('Local fixture response')",
    );
    console.log(
      "PASS: provider failure and recovery through the real daemon and a local controlled provider; no paid provider call.",
    );
    providerText =
      "# Readable reply\n\n**Bold** and `inline code`.\n\n- First item\n- Second item\n\n| Item | Value |\n| --- | --- |\n| Result | 391 |\n\n```js\nconst answer = '<script>bad()</script>';\n```\n\n[Documentation](https://example.com/docs)\n\n<script>window.markdownExecuted = true</script>\n\n[Unsafe](javascript:alert(1))\n\n![Remote](https://example.com/tracker.png)";
    await fill("Render the next fixture reply");
    await waitFor("!document.querySelector('#send').disabled");
    await evaluate("document.querySelector('#send').click()");
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('.message.assistant h1')?.textContent === 'Readable reply'",
    );
    const markdownResult = await evaluate(`(() => {
      const body = document.querySelector('.message.assistant:last-of-type .message-body');
      return { headings: body.querySelectorAll('h1').length, strong: body.querySelector('strong')?.textContent,
        code: body.querySelector('pre code')?.textContent, rows: body.querySelectorAll('tr').length,
        scripts: body.querySelectorAll('script').length, images: body.querySelectorAll('img').length,
        hrefs: [...body.querySelectorAll('a')].map(a => a.getAttribute('href')), executed: window.markdownExecuted === true };
    })()`);
    assert.equal(markdownResult.headings, 1);
    assert.equal(markdownResult.strong, "Bold");
    assert.match(markdownResult.code, /<script>bad/);
    assert.equal(markdownResult.rows, 2);
    assert.equal(markdownResult.scripts, 0);
    assert.equal(markdownResult.images, 0);
    assert.equal(markdownResult.executed, false);
    assert.ok(markdownResult.hrefs.every((url) => url.startsWith("https://")));
    assert.equal(
      await evaluate("document.querySelectorAll('.message .message-copy').length"),
      await evaluate("document.querySelectorAll('.message').length"),
    );
    await evaluate("[...document.querySelectorAll('.message.user .message-copy')].at(-1).click()");
    await waitFor(
      "[...document.querySelectorAll('.message.user .message-copy')].at(-1).textContent === 'Copied'",
    );
    assert.equal(clipboard.readText(), "Render the next fixture reply");
    await evaluate(
      "[...document.querySelectorAll('.message.assistant .message-copy')].at(-1).click()",
    );
    await waitFor(
      "[...document.querySelectorAll('.message.assistant .message-copy')].at(-1).textContent === 'Copied'",
    );
    assert.equal(clipboard.readText(), providerText);
    await waitFor(
      "[...document.querySelectorAll('.message.assistant .message-copy')].at(-1).textContent === 'Copy'",
    );
    console.log(
      "PASS: every user/reply message has Copy; native clipboard matches the selected message, preserves Markdown and omits profile labels.",
    );
    await waitFor("document.querySelector('#timeline').getAttribute('aria-busy') === 'false'");
    const usageSessions = await evaluate("window.openminion.sessions.list({})");
    const usageSessionId = usageSessions.value.sessions[0].sessionId;
    const usageTranscript = await runCommand(
      executable,
      [...args, "export", "transcript", "--session-id", usageSessionId, "--format", "jsonl"],
      30000,
    );
    assert.equal(usageTranscript.exitCode, 0);
    const usageRecord = usageTranscript.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === "message" && ["outbound", "assistant"].includes(row.role))
      .at(-1);
    assert.ok(usageRecord.body.includes("Readable reply"));
    const savedStats = usageRecord.stats ?? JSON.parse(usageRecord.metadata.run_stats_json);
    const expectedUsage = `${Math.floor(savedStats.duration_ms / 1000)}s · ${savedStats.input_tokens + savedStats.output_tokens} tokens`;
    await waitFor(
      `[...document.querySelectorAll('.message-usage')].at(-1)?.textContent === ${JSON.stringify(expectedUsage)}`,
    );
    const usageSessionIndex = await evaluate(
      "[...document.querySelectorAll('#session-list button')].findIndex(button => button.getAttribute('aria-current') === 'true')",
    );
    window.webContents.reload();
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    await waitFor(
      `document.querySelectorAll('#session-list button').length > ${usageSessionIndex}`,
    );
    await evaluate(
      `document.querySelectorAll('#session-list button')[${usageSessionIndex}].click()`,
    );
    await waitFor(
      `[...document.querySelectorAll('.message-usage')].at(-1)?.textContent === ${JSON.stringify(expectedUsage)}`,
    );
    assert.equal(
      await evaluate("[...document.querySelectorAll('.message-usage')].at(-1).hidden"),
      false,
    );
    console.log(
      "PASS: reply duration and tokens match the public CLI transcript and persist after renderer reload.",
    );
    const openedLinks = [];
    const originalOpenExternal = shell.openExternal;
    shell.openExternal = async (url) => {
      openedLinks.push(url);
    };
    await evaluate("document.querySelector('.message.assistant:last-of-type a').click()");
    await waitFor("document.activeElement !== null");
    for (let attempt = 0; !openedLinks.length && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    shell.openExternal = originalOpenExternal;
    assert.deepEqual(openedLinks, ["https://example.com/docs"]);
    await evaluate(`(() => {
      const body = document.querySelector('.message.assistant:last-of-type .message-body');
      window.preservedMessage = body;
      document.activeElement?.blur();
      const range = document.createRange(); range.selectNodeContents(body.querySelector('strong'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
    })()`);
    assert.equal(await evaluate("getSelection().toString()"), "Bold");
    await evaluate(
      "document.querySelector('#composer').value = 'Unsent draft'; document.querySelector('#composer').dispatchEvent(new Event('input'))",
    );
    assert.equal(
      await evaluate(
        "window.preservedMessage === document.querySelector('.message.assistant:last-of-type .message-body')",
      ),
      true,
    );
    assert.equal(await evaluate("getSelection().toString()"), "Bold");
    await waitFor("document.querySelector('#timeline').getAttribute('aria-busy') === 'false'");
    assert.equal(
      await evaluate(
        "window.preservedMessage === document.querySelector('.message.assistant:last-of-type .message-body')",
      ),
      true,
    );
    assert.equal(await evaluate("getSelection().toString()"), "Bold");
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1800, 1000],
    ]) {
      window.setContentSize(width, height);
      await waitFor(`innerWidth === ${width}`);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      const canScroll = await evaluate(`(() => {
        const chat = document.querySelector('#conversation');
        return chat.scrollHeight - chat.clientHeight > 48;
      })()`);
      if (canScroll) {
        await evaluate("document.querySelector('#conversation').scrollTop = 0");
        await waitFor("!document.querySelector('#jump-latest').hidden");
        await fill("Keep reading earlier messages");
        assert.equal(await evaluate("document.querySelector('#conversation').scrollTop"), 0);
        await evaluate("document.querySelector('#jump-latest').click()");
        await waitFor("document.querySelector('#jump-latest').hidden");
        assert.equal(
          await evaluate(`(() => {
          const chat = document.querySelector('#conversation');
          return chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 1;
        })()`),
          true,
        );
        assert.equal(await evaluate("document.activeElement.id"), "composer");
        assert.equal(
          await evaluate("document.querySelector('#composer').value"),
          "Keep reading earlier messages",
        );
      }
      const artifacts = process.env.OPENMINION_E2E_ARTIFACTS;
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          join(artifacts, `markdown-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    await command("/sessions", "Choose a task");
    const activeId = (await evaluate("window.openminion.sessions.list({})")).value.sessions[0]
      .sessionId;
    await waitFor("!document.querySelector('#close-session').disabled");
    await fill("/close");
    await evaluate("document.querySelector('#send').click()");
    await waitFor(
      "document.querySelector('#chat-status').textContent.includes('closed') || document.querySelector('#current-title').textContent === 'New task'",
    );
    const slashClosed = await runCommand(
      executable,
      [...args, "sessions", "show", activeId, "--json"],
      30_000,
    );
    assert.equal(slashClosed.exitCode, 0);
    assert.equal(JSON.parse(slashClosed.stdout).status, "closed");
    console.log(
      "PASS: DGUI-05 Markdown/code/table safety, explicit link opening, stable message DOM/selection, three window sizes; DGUI-03/04 session selection and close through UI with CLI readback.",
    );
    console.log(
      "PyPI GUI passed: production main/preload/renderer, first send, keyboard controls, commands, task switching, drafts, resize, outage/restart recovery, canonical close, cancellation request, provider failure/recovery, unavailable attachments.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}
