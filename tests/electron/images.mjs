import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_EXECUTABLE;
assert.ok(executable, "Set OPENMINION_EXECUTABLE to the Core source runtime under test.");
const root = await mkdtemp(join(tmpdir(), "openminion-images-electron-"));
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
const requests = [];
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const reader = JSON.stringify(body.messages).includes("Read the selected images in order");
  const refs = [...new Set(JSON.stringify(body.messages).match(/image:\/\/[0-9a-f-]{36}/g) ?? [])];
  const answer = reader
    ? JSON.stringify(
        refs.map((image_ref) => ({
          image_ref,
          visible_text: "",
          observations: ["OpenMinion icon fixture"],
          uncertainties: [],
        })),
      )
    : "OpenMinion icon fixture received.";
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      id: "fixture",
      object: "chat.completion",
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const daemonPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
await writeFile(
  join(root, "agents.json"),
  JSON.stringify({
    runtime: { ipc_port: daemonPort, ipc_token: "fixture-ipc-token" },
    default_agent: "vision",
    agents: {
      vision: {
        name: "vision",
        provider: "openai",
        provider_config_overrides: { model: "vision-fixture", enable_vision_input: true },
        image_input: { mode: "native" },
        model_connections: {
          vision: {
            provider: "openai",
            models: ["vision-fixture"],
            image_input: { "vision-fixture": "supported" },
            provider_config_overrides: { enable_vision_input: true },
          },
        },
      },
    },
    providers: {
      openai: {
        base_url: `http://127.0.0.1:${provider.address().port}/v1`,
        model: "vision-fixture",
        api_key: "fixture-only",
        enable_vision_input: true,
      },
    },
  }),
  { mode: 0o600 },
);
app.setPath("userData", root);
process.env.OPENMINION_DESKTOP_HOME = root;
const loaded = new Promise((resolve) =>
  app.once("browser-window-created", (_event, window) =>
    window.webContents.once("did-finish-load", () => resolve(window)),
  ),
);
const nativePicker = dialog.showOpenDialog;
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [fileURLToPath(new URL("../../assets/icon.png", import.meta.url))],
});
let exitCode = 1;
const timeout = setTimeout(() => {
  console.error("Image Electron check timed out");
  void finish(1);
}, 180_000);
await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      const until = Date.now() + 45_000;
      while (Date.now() < until) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Did not settle: ${source}; ${await evaluate("document.body.innerText")}`);
    };
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
    for (const mode of ["native", "separate"]) {
      if (mode === "separate") {
        await evaluate("document.querySelector('#show-settings').click()");
        await waitFor("!document.querySelector('#profile-save').disabled");
        await evaluate(
          "document.querySelector('#profile-image-mode').value = 'separate'; document.querySelector('#profile-image-mode').dispatchEvent(new Event('change')); document.querySelector('#profile-save').click()",
        );
        await waitFor(
          "document.querySelector('#profile-status').textContent.includes('Saved and applied') && document.querySelector('#connection-label').textContent === 'Connected'",
        );
        await evaluate("document.querySelector('#close-settings').click()");
        assert.equal(
          JSON.parse(await readFile(join(root, "agents.json"), "utf8")).agents.vision.image_input
            .mode,
          "separate",
        );
      }
      await evaluate("document.querySelector('#new-session').click()");
      await waitFor("!document.querySelector('#attach-image').disabled");
      const mark = requests.length;
      await evaluate("document.querySelector('#attach-image').click()");
      await waitFor(
        "document.querySelector('.attachment-chip img')?.complete && document.querySelector('.attachment-chip img').naturalWidth > 0",
      );
      assert.equal(requests.length, mark, "Selection must not call the model");
      assert.ok(
        await evaluate(`(() => {
          const chip = document.querySelector('.attachment-chip').getBoundingClientRect();
          const list = document.querySelector('#attachments').getBoundingClientRect();
          return chip.top >= list.top && chip.bottom <= list.bottom;
        })()`),
        "Selected image preview and removal control must not be clipped",
      );
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `images-${mode}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      await evaluate("document.querySelector('.attachment-remove').click()");
      await waitFor("document.querySelectorAll('.attachment-chip').length === 0");
      assert.equal(requests.length, mark, "Removal must not call the model");
      await evaluate("document.querySelector('#attach-image').click()");
      await waitFor(
        "document.querySelector('.attachment-chip img')?.naturalWidth > 0 && !document.querySelector('#send').disabled",
      );
      await evaluate("document.querySelector('#send').click()");
      await waitFor(
        "document.querySelectorAll('.message.assistant').length > 0 && document.querySelector('#cancel').hidden",
      );
      const sent = requests.slice(mark);
      const imageRequests = sent.filter((body) =>
        JSON.stringify(body).includes('"type":"image_url"'),
      );
      assert.ok(imageRequests.length > 0, "Provider must receive the selected image");
      if (mode === "separate") {
        assert.equal(imageRequests.length, 1, "Only the reader receives image bytes");
        assert.ok(
          sent.slice(1).some((body) => JSON.stringify(body).includes("OpenMinion icon fixture")),
        );
      }
      assert.equal(await evaluate("document.querySelectorAll('.attachment-chip').length"), 0);
    }
    console.log(
      "PASS: source Core + native Electron selection, normalized preview, removal without inference, image-only native send, settings switch, and separate reader send. Controlled HTTP provider; no live-model or released-package claim.",
    );
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    await finish(exitCode);
  }
}

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  dialog.showOpenDialog = nativePicker;
  await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  if (code === 0) await rm(root, { recursive: true, force: true });
  else console.error(`Image evidence retained at ${root}`);
  app.exit(code);
}
