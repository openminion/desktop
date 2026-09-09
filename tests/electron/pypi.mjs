import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, dialog } from "electron";
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
}, 240_000);
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
await import("../../dist/src/main/index.js");
void check();
async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `GUI condition did not settle: ${source}; ${await evaluate("document.querySelector('#chat-status').textContent + ' / ' + document.querySelector('#profile-status').textContent")}`,
      );
    };
    const fill = async (text) =>
      evaluate(
        `document.querySelector('#composer').value = ${JSON.stringify(text)}; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#composer').focus()`,
      );
    const key = async (keyCode, modifiers = []) => {
      window.focus();
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (keyCode === "Return" && (!modifiers.length || modifiers.includes("shift")))
        window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const command = async (text, title) => {
      await fill(text);
      await key("Return");
      await waitFor(
        `document.querySelector('#command-title').textContent === ${JSON.stringify(title)}`,
      );
      await evaluate("document.querySelector('#command-panel').hidePopover()");
    };
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
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
      await key("Return");
      await waitFor(
        `document.querySelector('.runtime-task')?.textContent.includes(${JSON.stringify(state)})`,
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
      "Array.from(document.querySelectorAll('.runtime-task button')).find(button => button.textContent === 'Pause').click()",
    );
    await waitFor("document.querySelector('.runtime-task')?.textContent.includes('paused')");
    await workCommand(`/task resume ${taskId}`, "active");
    await workCommand(`/tasks cancel ${taskId}`, "cancelled");
    const canonicalWork = await runCommand(
      executable,
      [...args, "tasks", "show", taskId, "--session", sessionId, "--json"],
      30_000,
    );
    assert.equal(canonicalWork.exitCode, 0);
    assert.equal(JSON.parse(canonicalWork.stdout).task.lifecycle_state, "cancelled");
    await evaluate("document.querySelector('#command-panel').hidePopover()");
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
    console.log("PASS: populated chat remains usable at minimum, normal and wide sizes.");
    await fill("Draft preserved across outage");
    assert.equal((await runCommand(executable, [...args, "daemon", "stop"], 30_000)).exitCode, 0);
    await evaluate("document.querySelector('#show-connection').click()");
    await waitFor("document.querySelector('#connection-label').textContent === 'Not connected'");
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Draft preserved across outage",
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
              `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", model: "e2e-fixture", choices: [{ index: 0, delta: { content: "Local fixture response" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "e2e", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
                    message: { role: "assistant", content: "Local fixture response" },
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
    for (let attempt = 0; providerCalls === 0 && attempt < 100; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      providerCalls > 0,
      "The real daemon must reach the local provider before cancellation",
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
    console.log(
      "PyPI GUI passed: production main/preload/renderer, first send, keyboard controls, commands, task switching, drafts, resize, outage/restart recovery, canonical close, cancellation request, provider failure/recovery, unavailable attachments.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}
