import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_PYPI_EXECUTABLE;
if (!executable) throw new Error("Set OPENMINION_PYPI_EXECUTABLE to the isolated PyPI executable.");
const root = await mkdtemp(join(tmpdir(), "desktop-onboarding-"));
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
const requests = [];
const provider = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => {
    text += chunk;
  });
  req.on("end", () => {
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "onboarding-fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Desktop onboarding reply" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      }),
    );
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
const loaded = new Promise((resolve) =>
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  }),
);
let finishing = false;
const timeout = setTimeout(() => {
  console.error("Onboarding timed out");
  void finish(1);
}, 300_000);
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
  app.exit(code);
}
await import("../../dist/src/main/bootstrap.js");
void check();
async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    const capture = async (name) => {
      const directory = process.env.OPENMINION_E2E_ARTIFACTS;
      if (!directory) return;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), (await window.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code) => {
      for (let i = 0; i < 400; i++) {
        if (await evaluate(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Did not settle: ${code}; ${await evaluate("document.querySelector('#profile-status').textContent + ' / ' + document.querySelector('#chat-status').textContent + ' / ' + document.querySelector('#timeline').textContent")}`,
      );
    };
    await waitFor(
      "document.querySelector('#profile-dialog').open && document.querySelector('#setup-provider').options.length > 0 && !document.querySelector('#profile-save').disabled",
    );
    assert.equal(requests.length, 0);
    assert.equal(await evaluate("document.querySelector('#setup-check-provider').checked"), true);
    const initial = (await evaluate("window.openminion.profiles.read()")).value;
    assert.equal(initial.setupRequired, true);
    const initialConfig = await readFile(join(root, "agents.json"), "utf8");
    const referencePath = join(root, "cli-reference.json");
    const cliSetup = async (provider, options, environment) => {
      await writeFile(referencePath, initialConfig, { mode: 0o600 });
      const result = await runCommand(
        executable,
        [
          ...args.slice(0, -1),
          referencePath,
          "setup",
          "--no-chat",
          "--agent",
          initial.defaultAgent,
          "--provider",
          provider,
          ...options,
        ],
        30_000,
        environment,
      );
      assert.equal(result.exitCode, 0, "The independent CLI setup must succeed.");
      return JSON.parse(await readFile(referencePath, "utf8"));
    };
    window.setContentSize(760, 560);
    await waitFor("window.innerWidth === 760");
    await capture("01-welcome.png");
    assert.equal(await evaluate("document.querySelector('#settings-profiles').hidden"), false);
    await evaluate("document.querySelector('#setup-key').value='discarded-fixture-key'");
    for (const section of ["chat", "runtime", "profiles"]) {
      await evaluate(`document.querySelector('#settings-${section}-button').click()`);
      assert.equal(
        await evaluate("document.querySelector('#setup-key').value"),
        "discarded-fixture-key",
      );
    }
    await evaluate("document.querySelector('#close-settings').click()");
    await waitFor(
      "!document.querySelector('#profile-dialog').open && document.querySelector('#setup-key').value === ''",
    );
    assert.equal(await readFile(join(root, "agents.json"), "utf8"), initialConfig);
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
    assert.equal((await evaluate("window.openminion.sessions.list({})")).value.sessions.length, 0);
    await evaluate("document.querySelector('#show-settings').click()");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#profile-save').disabled",
    );
    await evaluate(
      "document.querySelector('#setup-provider').value='minimax'; document.querySelector('#setup-provider').dispatchEvent(new Event('change'))",
    );
    const minimax = await cliSetup("minimax", [], { MINIMAX_API_KEY: "unused-fixture-key" });
    const minimaxModel = minimax.providers[minimax.agents[initial.defaultAgent].provider];
    assert.equal(
      await evaluate("document.querySelector('#setup-model').value"),
      minimaxModel.model,
    );
    assert.equal(
      await evaluate("document.querySelector('#setup-endpoint').value"),
      minimaxModel.base_url,
    );
    assert.equal(requests.length, 0);
    await capture("02-minimax-defaults.png");
    await evaluate("document.querySelector('#profile-save').click()");
    assert.equal(
      await evaluate("document.querySelector('#setup-key').validity.valueMissing"),
      true,
    );
    assert.equal(await readFile(join(root, "agents.json"), "utf8"), initialConfig);
    await evaluate(
      `document.querySelector('#setup-provider').value='custom-openai-compatible'; document.querySelector('#setup-provider').dispatchEvent(new Event('change')); document.querySelector('#setup-model').value='fixture-model'; document.querySelector('#setup-endpoint').value=${JSON.stringify(endpoint)}; document.querySelector('#setup-key').value='onboarding-private-key'`,
    );
    await capture("03-model-setup.png");
    const reference = await cliSetup(
      "custom-openai-compatible",
      ["--model", "fixture-model", "--base-url", endpoint],
      { OPENAI_COMPATIBLE_API_KEY: "onboarding-private-key" },
    );
    await evaluate("document.querySelector('#profile-save').click()");
    await waitFor(
      "document.querySelector('#profile-status').textContent.startsWith('Connection verified')",
    );
    assert.equal(requests.length, 1, "Checked setup must make one provider request.");
    assert.equal(requests[0].authorization, "Bearer onboarding-private-key");
    assert.equal(requests[0].body.model, "fixture-model");
    const settings = (await evaluate("window.openminion.profiles.read()")).value;
    assert.equal(settings.setupRequired, false);
    assert.equal(settings.agents[0].keyConfigured, true);
    assert.ok(!JSON.stringify(settings).includes("onboarding-private-key"));
    assert.equal(await evaluate("document.querySelector('#setup-key').value"), "");
    const configured = JSON.parse(await readFile(join(root, "agents.json"), "utf8"));
    assert.deepEqual(configured.agents, reference.agents);
    assert.deepEqual(configured.providers, reference.providers);
    assert.equal(configured.default_agent, reference.default_agent);
    assert.equal((await stat(join(root, "agents.json"))).mode & 0o777, 0o600);
    await capture("04-setup-complete.png");
    await evaluate("document.querySelector('#close-settings').click()");
    await evaluate(
      "document.querySelector('#composer').value='First configured chat'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()",
    );
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('#timeline').textContent.includes('Desktop onboarding reply')",
    );
    assert.equal(requests[1].authorization, "Bearer onboarding-private-key");
    assert.equal(requests[1].body.model, "fixture-model");
    await capture("05-first-chat.png");
    console.log(
      "PASS: first launch, discard without writes, independent CLI MiniMax defaults, missing-key validation, checked provider setup, matching CLI-created model profiles, private key persistence and first configured chat.",
    );

    const originalSession = (await evaluate("window.openminion.sessions.list({})")).value
      .sessions[0];
    const requestsBeforeRename = requests.length;
    await evaluate("document.querySelector('#rename-session').click()");
    assert.equal(await evaluate("document.querySelector('#rename-dialog').open"), true);
    assert.equal(
      await evaluate("document.querySelector('#rename-session-id').textContent"),
      originalSession.sessionId,
    );
    await evaluate(
      "document.querySelector('#task-name').value='Discarded name'; document.querySelector('#rename-cancel').click()",
    );
    await waitFor("!document.querySelector('#rename-dialog').open");
    await evaluate(
      "document.querySelector('#rename-session').click(); document.querySelector('#task-name').value='Release planning'",
    );
    await capture("06-rename-chat.png");
    await evaluate("document.querySelector('#rename-form').requestSubmit()");
    await waitFor("document.querySelector('#current-title').textContent === 'Release planning'");
    assert.ok(
      await evaluate(
        "document.querySelector('#session-list').textContent.includes('Release planning')",
      ),
    );
    assert.equal(requests.length, requestsBeforeRename);
    const canonical = (await evaluate("window.openminion.sessions.list({})")).value.sessions[0];
    assert.equal(canonical.sessionId, originalSession.sessionId);
    assert.equal(canonical.title, originalSession.title);

    const seed = await runCommand(
      executable,
      [
        ...args,
        "agent",
        "--message",
        "Seed the CLI conversation",
        "--target",
        "cli-tools",
        "--session-id",
        "cli-handoff",
        "--json",
      ],
      30_000,
    );
    assert.equal(seed.exitCode, 0, "CLI could not seed its own session.");
    const details = await runCommand(
      executable,
      [...args, "sessions", "show", "cli-handoff", "--json"],
      30_000,
    );
    assert.equal(JSON.parse(details.stdout).target, "cli-tools");
    window.webContents.reload();
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    await waitFor("document.querySelectorAll('#session-list button').length >= 2");
    assert.equal(await evaluate("document.querySelector('#profile-dialog').open"), false);
    assert.ok(
      await evaluate(
        "document.querySelector('#session-list').textContent.includes('Release planning')",
      ),
    );
    // The CLI-created session is newest and is selected by Desktop on load.
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Seed the CLI conversation')",
    );
    await evaluate(
      "document.querySelector('#composer').value='Continue the CLI conversation'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()",
    );
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelectorAll('.message.assistant').length === 2",
    );
    const continued = (await evaluate("window.openminion.sessions.load({sessionId:'cli-handoff'})"))
      .value;
    assert.equal(continued.messages.length, 4);
    assert.ok(
      !(await evaluate(
        "document.querySelector('#chat-status').textContent.includes('belongs to target')",
      )),
    );
    const after = await runCommand(
      executable,
      [...args, "sessions", "show", "cli-handoff", "--json"],
      30_000,
    );
    assert.equal(JSON.parse(after.stdout).target, "cli-tools");
    console.log(
      "PASS: Desktop resumes a CLI-owned target without changing session identity; onboarding stays dismissed after configuration and reload.",
    );
    await evaluate(
      "Array.from(document.querySelectorAll('#session-list button')).find(button => button.textContent === 'Release planning').click()",
    );
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('First configured chat') && !document.querySelector('#close-session').disabled",
    );
    assert.equal(
      await evaluate("document.querySelector('#current-title').textContent"),
      "Release planning",
    );
    await evaluate(
      "document.querySelector('#rename-session').click(); document.querySelector('#rename-reset').click()",
    );
    await waitFor("!document.querySelector('#rename-dialog').open");
    assert.equal(
      await evaluate("document.querySelector('#current-title').textContent"),
      originalSession.title || "Untitled task",
    );
    await evaluate("document.querySelector('#session-list button').click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Continue the CLI conversation')",
    );
    console.log(
      "PASS: local chat rename, cancel, reset and reload preserve canonical session IDs, names and conversation history without provider calls.",
    );
    // A profile created by core setup must remain editable in Desktop Settings.
    const current = (await evaluate("window.openminion.profiles.read()")).value;
    const removed = await evaluate(
      `window.openminion.profiles.save(${JSON.stringify({
        revision: current.revision,
        agentId: current.defaultAgent,
        model: "edited-model",
        baseUrl: endpoint,
        makeDefault: true,
        apiKey: null,
        credentials: {},
      })})`,
    );
    assert.equal(removed.ok, true);
    window.webContents.reload();
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    await waitFor(
      "document.querySelector('#profile-dialog').open && document.querySelector('#profile-status').textContent.includes('Add the API key')",
    );
    assert.equal(await evaluate("document.querySelector('#profile-model').value"), "edited-model");
    await evaluate("document.querySelector('#profile-key').value='replacement-private-key'");
    for (const section of ["runtime", "chat", "profiles"]) {
      await evaluate(`document.querySelector('#settings-${section}-button').click()`);
      assert.equal(
        await evaluate("document.querySelector('#profile-key').value"),
        "replacement-private-key",
      );
      assert.equal(
        await evaluate("document.querySelector('#profile-model').value"),
        "edited-model",
      );
    }
    await evaluate("document.querySelector('#profile-save').click()");
    await waitFor(
      "document.querySelector('#profile-status').textContent.startsWith('Saved and applied')",
    );
    await evaluate("document.querySelector('#close-settings').click()");
    await waitFor(
      "document.querySelector('#timeline').textContent.includes('Continue the CLI conversation')",
    );
    const replyCount = await evaluate("document.querySelectorAll('.message.assistant').length");
    assert.equal(replyCount, 2);
    await evaluate(
      "document.querySelector('#composer').value='Chat with edited settings'; document.querySelector('#composer').dispatchEvent(new Event('input'))",
    );
    assert.equal(await evaluate("document.querySelector('#send').disabled"), false);
    await evaluate("document.querySelector('#send').click()");
    await waitFor(
      `document.querySelector('#cancel').hidden && document.querySelectorAll('.message.assistant').length === ${replyCount + 1}`,
    );
    assert.equal(requests.at(-1).authorization, "Bearer replacement-private-key");
    assert.equal(requests.at(-1).body.model, "edited-model");
    console.log(
      "PASS: missing-key startup guidance and editing a core-created profile affect actual provider requests.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}
