import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_PYPI_EXECUTABLE;
if (!executable) throw new Error("Set OPENMINION_PYPI_EXECUTABLE to the isolated PyPI executable.");
const root = await mkdtemp(join(tmpdir(), "desktop-onboarding-"));
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
}, 180_000);
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
await import("../../dist/src/main/index.js");
void check();
async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (code) => window.webContents.executeJavaScript(code);
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
    assert.equal((await evaluate("window.openminion.profiles.read()")).value.setupRequired, true);
    await evaluate(
      "document.querySelector('#setup-provider').value='minimax'; document.querySelector('#setup-provider').dispatchEvent(new Event('change'))",
    );
    assert.equal(await evaluate("document.querySelector('#setup-model').value"), "MiniMax-M2.7");
    assert.equal(
      await evaluate("document.querySelector('#setup-endpoint').value"),
      "https://api.minimax.io/v1",
    );
    await evaluate("document.querySelector('#profile-save').click()");
    assert.equal(
      await evaluate("document.querySelector('#setup-key').validity.valueMissing"),
      true,
    );
    await evaluate(
      `document.querySelector('#setup-provider').value='custom-openai-compatible'; document.querySelector('#setup-provider').dispatchEvent(new Event('change')); document.querySelector('#setup-model').value='fixture-model'; document.querySelector('#setup-endpoint').value=${JSON.stringify(endpoint)}; document.querySelector('#setup-key').value='onboarding-private-key'`,
    );
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      window.setContentSize(760, 560);
      await waitFor("window.innerWidth === 760");
      // Capture before entering any real credentials; this is a synthetic fixture key.
      await writeFile(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "onboarding.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await evaluate("document.querySelector('#profile-save').click()");
    await waitFor(
      "document.querySelector('#profile-status').textContent.startsWith('Saved and applied')",
    );
    assert.equal(requests.length, 0, "Saving must not make a provider request.");
    const settings = (await evaluate("window.openminion.profiles.read()")).value;
    assert.equal(settings.setupRequired, false);
    assert.equal(settings.agents[0].keyConfigured, true);
    assert.ok(!JSON.stringify(settings).includes("onboarding-private-key"));
    assert.equal(await evaluate("document.querySelector('#setup-key').value"), "");
    await evaluate("document.querySelector('#close-settings').click()");
    await evaluate(
      "document.querySelector('#composer').value='First configured chat'; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()",
    );
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('#timeline').textContent.includes('Desktop onboarding reply')",
    );
    assert.equal(requests[0].authorization, "Bearer onboarding-private-key");
    console.log(
      "PASS: first launch onboarding, CLI MiniMax defaults, missing-key validation, canonical setup, private key persistence and first real-provider-protocol chat.",
    );

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
    await evaluate(
      "document.querySelector('#profile-key').value='replacement-private-key'; document.querySelector('#profile-save').click()",
    );
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
