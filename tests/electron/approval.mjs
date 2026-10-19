import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { runCommand } from "../../dist/src/main/installation.js";

const executable =
  process.env.OPENMINION_APPROVAL_E2E_EXECUTABLE ?? process.env.OPENMINION_EXECUTABLE;
if (!executable) {
  throw new Error(
    "Set OPENMINION_APPROVAL_E2E_EXECUTABLE to the OpenMinion executable under test.",
  );
}

const root = await mkdtemp(join(tmpdir(), "openminion-approval-electron-"));
const marker = join(root, "approval-proof.txt");
const args = [
  "--home-root",
  root,
  "--data-root",
  join(root, "data"),
  "--config",
  join(root, "agents.json"),
];
let toolResult = "";
let toolIssued = false;
let offeredTools = [];
let responseCount = 0;

const provider = createServer((request, response) => {
  let input = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    input += chunk;
  });
  request.on("end", () => {
    const body = JSON.parse(input);
    offeredTools = [
      ...new Set([
        ...offeredTools,
        ...(body.tools?.map((tool) => tool.function?.name).filter(Boolean) ?? []),
      ]),
    ];
    const toolMessage = body.messages?.find(
      (message) => message.role === "tool" && message.tool_call_id === "approval-proof-call",
    );
    if (toolMessage) toolResult = String(toolMessage.content ?? "");

    const requiredTool = body.tool_choice?.function?.name;
    const submitOutput = body.tools?.find(
      (tool) => tool.function?.name === "submit_output",
    )?.function;
    const toolRequest = body.tools?.find((tool) => tool.function?.name === "tool_request")?.function
      ?.name;
    const fileWrite = body.tools?.find((tool) => tool.function?.name === "file_write")?.function
      ?.name;
    const message =
      requiredTool === "submit_output" && submitOutput
        ? toolCall(
            `submit-output-${++responseCount}`,
            "submit_output",
            structuredOutput(submitOutput.parameters),
          )
        : !toolIssued && toolRequest
          ? toolCall("activate-file-write", toolRequest, {
              name: "file.write",
              terminal_after_success: true,
            })
          : !toolIssued && fileWrite
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "approval-proof-call",
                    type: "function",
                    function: {
                      name: fileWrite,
                      arguments: JSON.stringify({
                        path: "approval-proof.txt",
                        content: "approved through Desktop\n",
                      }),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content:
                  "APPROVAL_HOST_PROOF_OK\n\n" +
                  '<finalization_status>{"status":"final_answer","reasoning":"approval host proof complete"}</finalization_status>',
              };
    toolIssued ||= Boolean(fileWrite);
    sendOpenAiResponse(response, body, message);
  });
});

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const port = provider.address().port;

app.setPath("userData", root);
process.chdir(root);
process.env.OPENMINION_DESKTOP_HOME = root;
process.env.OPENMINION_EXECUTABLE = executable;

const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("Approval host proof timed out");
  void finish(1);
}, 180_000);
let finishing = false;

await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(source)) return;
        if (
          await evaluate(
            "document.querySelector('#timeline').textContent.includes('stream ended unexpectedly')",
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Approval condition did not settle: ${source}; offered tools: ${offeredTools.join(", ")}; ${await evaluate("document.querySelector('#timeline').textContent.slice(-2000)")}`,
      );
    };
    const clickText = async (selector, text) => {
      const point = await evaluate(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
        if (!element || element.disabled) return null;
        element.scrollIntoView({block: "nearest"});
        const rect = element.getBoundingClientRect();
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
      })()`);
      assert.ok(point, `${text} must be visible and enabled`);
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
    };

    await waitFor(
      "document.querySelector('#connection-label').textContent === 'Connected'",
      90_000,
    );
    const settings = await evaluate("window.openminion.profiles.read()");
    assert.equal(settings.ok, true);
    assert.equal(settings.value.setupRequired, true);
    const setup = await evaluate(
      `window.openminion.profiles.setup(${JSON.stringify({
        revision: "REVISION",
        presetId: "custom-openai-compatible",
        model: "approval-fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "local-fixture-key",
        checkProvider: false,
      }).replace("REVISION", settings.value.revision)})`,
    );
    assert.equal(setup.ok, true, JSON.stringify(setup));
    const configPath = join(root, "agents.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.runtime.tool_workspace_root = root;
    config.runtime.tool_selection = {
      mode: "typed",
      max_tools_per_turn: 200,
      tool_prompt_token_budget: 100_000,
      schema_exposure: "full",
    };
    config.system.runtime.tool_workspace_root = root;
    config.system.runtime.tool_selection = config.runtime.tool_selection;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const configured = await evaluate("window.openminion.profiles.read()");
    assert.equal(configured.ok, true);
    const saved = await evaluate(
      `window.openminion.profiles.save(${JSON.stringify({
        revision: "REVISION",
        agentId: "AGENT",
        model: "approval-fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        makeDefault: true,
        credentials: {},
      })
        .replace("REVISION", configured.value.revision)
        .replace("AGENT", configured.value.defaultAgent)})`,
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    await waitFor(
      "document.querySelector('#connection-label').textContent === 'Connected'",
      90_000,
    );
    await evaluate(
      "if (document.querySelector('#profile-dialog').open) document.querySelector('#close-settings').click()",
    );
    await waitFor("!document.querySelector('#profile-dialog').open");

    await evaluate(`document.querySelector('#composer').value = 'Create the approval proof file.';
      document.querySelector('#composer').dispatchEvent(new Event('input'));
      document.querySelector('#send').click()`);
    await waitFor(
      "[...document.querySelectorAll('.approval-card')].some(card => card.textContent.includes('approval-proof.txt') && card.textContent.includes('Allow once'))",
      90_000,
    );
    assert.equal(existsSync(marker), false, "the tool must not run before approval");
    await clickText(".approval-card button", "Allow once");
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('#timeline').textContent.includes('APPROVAL_HOST_PROOF_OK')",
      90_000,
    );

    assert.equal(await readFile(marker, "utf8"), "approved through Desktop\n");
    assert.match(toolResult, /approval-proof\.txt|approved through Desktop|"ok":\s*true/);
    assert.match(
      await evaluate("document.querySelector('#timeline').textContent"),
      /Approval.*file\.write[\s\S]*(applied|allowed)/i,
    );
    console.log(
      "PASS: real daemon approval reached built Electron, Allow once executed file.write, and the local provider received its tool result.",
    );
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
}

function sendOpenAiResponse(response, body, message) {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!body.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "approval-fixture",
        object: "chat.completion",
        model: "approval-fixture",
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "approval-fixture",
      object: "chat.completion.chunk",
      model: "approval-fixture",
      choices: [{ index: 0, delta: message, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "approval-fixture",
      object: "chat.completion.chunk",
      model: "approval-fixture",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage,
    })}\n\ndata: [DONE]\n\n`,
  );
  response.end();
}

function toolCall(id, name, arguments_) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(arguments_) },
      },
    ],
  };
}

function structuredOutput(schema) {
  const properties = schema?.properties ?? {};
  if (Object.hasOwn(properties, "items")) return { items: [] };
  if (Object.hasOwn(properties, "time_sensitive")) {
    return {
      intent: "create one local proof file",
      domain: "coding",
      time_sensitive: false,
      needs_live_data: false,
      needs_sources: false,
      needs_exact_date: false,
      answer_mode: "local_only",
      reason: "local deterministic fixture",
      confidence: 1,
    };
  }
  if (Object.hasOwn(properties, "satisfied")) {
    return {
      satisfied: toolResult.length > 0,
      reason: toolResult.length > 0 ? "tool result observed" : "tool has not run",
      next_action: toolResult.length > 0 ? "close" : "continue",
      final_answer: toolResult.length > 0 ? "APPROVAL_HOST_PROOF_OK" : null,
      memory_use_refs: [],
      mutation_claimed: toolResult.length > 0,
    };
  }
  throw new Error(`Unsupported structured fixture schema: ${JSON.stringify(schema)}`);
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  try {
    await runCommand(executable, [...args, "daemon", "stop"], 30_000);
  } finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (code === 0) await rm(root, { recursive: true, force: true });
    else console.error(`Approval host evidence retained at ${root}`);
    app.exit(code);
  }
}
