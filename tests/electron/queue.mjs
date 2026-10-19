import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runCommand } from "../../dist/src/main/installation.js";

const executable = process.env.OPENMINION_QUEUE_E2E_EXECUTABLE ?? process.env.OPENMINION_EXECUTABLE;
assert.ok(executable, "Set OPENMINION_QUEUE_E2E_EXECUTABLE to the OpenMinion executable.");

const initialPrompt = "Keep this response open while I queue follow-ups.";
const activePrompt = "Keep this second response open until I run the queued effect.";
const effectPrompt = "Create the queue effect proof file.";
const removedPrompt = "Remove this queued prompt.";

if (!process.versions.electron) {
  await runOuter();
} else {
  void runPhase();
}

async function runOuter() {
  const root = mkdtempSync(join(tmpdir(), "openminion-queue-electron-"));
  const args = rootArguments(root);
  const marker = join(root, "queue-effect.txt");
  let effectToolCalls = 0;
  let toolResultObserved = false;
  let holdInitial = true;
  let activeDelayUsed = false;
  const initialReplies = [];
  const provider = createServer((request, response) => {
    let input = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      input += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(input);
      const transcript = JSON.stringify(body.messages ?? []);
      const isEffect = transcript.includes(effectPrompt);
      const toolMessage = body.messages?.find(
        (message) => message.role === "tool" && message.tool_call_id === "queue-effect-call",
      );
      if (toolMessage) toolResultObserved = true;
      const reply = () => {
        if (response.destroyed) return;
        sendOpenAiResponse(
          response,
          body,
          providerMessage(body, isEffect, toolResultObserved, () => {
            effectToolCalls += 1;
          }),
        );
      };
      let delay = 0;
      const isBrainTurn = input.includes("[TASK HEADER]");
      if (holdInitial && input.includes(initialPrompt)) {
        initialReplies.push(reply);
        return;
      } else if (!activeDelayUsed && isBrainTurn && input.includes(activePrompt)) {
        activeDelayUsed = true;
        delay = 30_000;
      }
      if (delay) setTimeout(reply, delay);
      else reply();
    });
  });

  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  let failed = true;
  try {
    process.env.OPENAI_API_KEY = "local-fixture-key";
    await configureCore(root, args, provider.address().port);
    const started = await runCommand(executable, [...args, "daemon", "start"], 30_000);
    assert.equal(started.exitCode, 0, started.stderr || started.stdout);
    await waitForDaemon(args);
    const { default: electron } = await import("electron");
    for (const phase of ["queue", "recover"]) {
      const result = await promisify(execFile)(electron, [fileURLToPath(import.meta.url), phase], {
        env: {
          ...process.env,
          OPENAI_API_KEY: "local-fixture-key",
          OPENMINION_DESKTOP_HOME: root,
          OPENMINION_EXECUTABLE: executable,
          OPENMINION_QUEUE_TEST_ROOT: root,
        },
        timeout: 180_000,
      });
      process.stdout.write(result.stdout);
      if (phase === "queue") {
        assert.ok(initialReplies.length, "the first slow provider request must still be active");
        holdInitial = false;
        for (const reply of initialReplies.splice(0)) reply();
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
    }
    assert.equal(readFileSync(marker, "utf8"), "queue effect ran once\n");
    assert.equal(effectToolCalls, 1, "the fixture must issue one file.write call");
    assert.equal(toolResultObserved, true, "the provider must receive the tool result");
    const state = JSON.parse(readFileSync(join(root, "queue-state.json"), "utf8"));
    const transcript = await runCommand(
      executable,
      [
        ...args,
        "export",
        "transcript",
        "--session-id",
        state.sessionId,
        "--format",
        "jsonl",
        "--include-events",
      ],
      30_000,
    );
    assert.equal(transcript.exitCode, 0, transcript.stderr);
    const completedEffects = transcript.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) => entry.event_type === "turn.outcome" && entry.payload?.tool_completed_count === 1,
      );
    assert.equal(completedEffects.length, 1, transcript.stdout);
    console.log(
      "PASS: native Desktop preserved the Core queue and draft across a process restart, removed the exact queued prompt, and ran one queued file effect exactly once.",
    );
    failed = false;
  } finally {
    await runCommand(executable, [...args, "daemon", "stop"], 30_000).catch(() => undefined);
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (failed) console.error(`Queue evidence retained at ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

async function configureCore(root, args, providerPort) {
  const initialized = await runCommand(
    executable,
    [...args, "config", "init", "--provider", "echo"],
    30_000,
  );
  assert.equal(initialized.exitCode, 0, initialized.stderr || initialized.stdout);
  const configPath = join(root, "agents.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const ipcPort = await availablePort();
  config.agents.openminion.provider = "openai";
  for (const scope of [config, config.system]) {
    scope.providers.openai = {
      ...scope.providers.openai,
      api_key: "",
      api_key_env: "OPENAI_API_KEY",
      base_url: `http://127.0.0.1:${providerPort}/v1`,
      model: "queue-fixture",
      timeout_seconds: 30,
      tool_call_strategy: "hybrid",
    };
    scope.runtime = {
      ...scope.runtime,
      demo_mode: false,
      ipc_host: "127.0.0.1",
      ipc_port: ipcPort,
      ipc_token: randomBytes(32).toString("base64url"),
      tool_workspace_root: root,
      tool_selection: {
        ...scope.runtime.tool_selection,
        mode: "typed",
        max_tools_per_turn: 200,
        tool_prompt_token_budget: 100_000,
        schema_exposure: "full",
      },
    };
  }
  config.system.runtime.ipc_token = config.runtime.ipc_token;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function waitForDaemon(args) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await runCommand(executable, [...args, "daemon", "status", "--json"], 10_000);
    if (status.exitCode === 0 && JSON.parse(status.stdout).reachable === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The external OpenMinion daemon did not become ready.");
}

async function runPhase() {
  const { app } = await import("electron");
  const root = process.env.OPENMINION_QUEUE_TEST_ROOT;
  assert.ok(root, "Run this check with Node.js so it can retain the Core daemon between phases.");
  const phase = process.argv[2];
  app.setPath("userData", root);
  process.chdir(root);
  const loaded = new Promise((resolve) => {
    app.once("browser-window-created", (_event, window) => {
      console.log(`Queue ${phase} window created.`);
      window.webContents.once("did-finish-load", () => resolve(window));
    });
  });
  let window = null;
  const timeout = setTimeout(async () => {
    const text = window
      ? await window.webContents
          .executeJavaScript("document.querySelector('main')?.textContent.slice(-3000)")
          .catch(() => "window unavailable")
      : "window not created";
    console.error(`Queue ${phase} timed out: ${text}`);
    app.exit(1);
  }, 120_000);
  let finished = false;
  app.on("ready", () => console.log(`Queue ${phase} app ready.`));
  app.on("will-quit", () => console.log(`Queue ${phase} app quitting.`));
  await import("../../dist/src/main/bootstrap.js");
  window = await loaded;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (source, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Queue condition did not settle: ${source}; ${await evaluate("document.querySelector('main').textContent.slice(-3000)")}`,
    );
  };
  const submit = async (text) => {
    await evaluate(`(() => {
      const composer = document.querySelector('#composer');
      composer.value = ${JSON.stringify(text)};
      composer.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await waitFor("!document.querySelector('#send').disabled");
    await evaluate("document.querySelector('#composer-form').requestSubmit()");
  };
  const click = async (selector) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    assert.equal(clicked, true, selector);
  };
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    app.exit(code);
  };

  try {
    await waitFor("document.querySelector('#connection-label').textContent === 'Connected'");
    await waitFor("!document.querySelector('#profile-dialog').open");
    if (phase === "queue") {
      console.log("Queue phase connected.");
      await submit(initialPrompt);
      await waitFor("!document.querySelector('#cancel').hidden");
      console.log("Slow turn active.");
      const sessionId = await evaluate(
        "document.querySelector('.session-item[aria-current=true]')?.dataset.sessionId",
      );
      assert.ok(sessionId);
      const queue = await evaluate(`(async () => {
        const turns = window.openminion.turns;
        const first = await turns.enqueue({sessionId:${JSON.stringify(sessionId)},agentId:'openminion',text:${JSON.stringify(effectPrompt)}});
        const second = await turns.enqueue({sessionId:${JSON.stringify(sessionId)},agentId:'openminion',text:${JSON.stringify(removedPrompt)}});
        if (!first.ok || !second.ok) return {first, second};
        const movedSecond = await turns.move({sessionId:${JSON.stringify(sessionId)},queueId:second.value.queueId,statusVersion:second.value.statusVersion,beforeQueueId:first.value.queueId});
        if (!movedSecond.ok) return {first, second, movedSecond};
        const movedFirst = await turns.move({sessionId:${JSON.stringify(sessionId)},queueId:first.value.queueId,statusVersion:first.value.statusVersion,beforeQueueId:second.value.queueId});
        return {first, second, movedSecond, movedFirst, final: await turns.listQueue({sessionId:${JSON.stringify(sessionId)}})};
      })()`);
      assert.equal(queue.first.ok, true, JSON.stringify(queue));
      assert.equal(queue.second.ok, true, JSON.stringify(queue));
      assert.equal(queue.movedSecond.ok, true, JSON.stringify(queue));
      assert.equal(queue.movedFirst.ok, true, JSON.stringify(queue));
      assert.equal(queue.final.ok, true, JSON.stringify(queue));
      assert.deepEqual(
        queue.final.value.map((entry) => entry.text),
        [effectPrompt, removedPrompt],
      );
      await evaluate(`(() => {
        const composer = document.querySelector('#composer');
        composer.value = 'Draft kept across Desktop restart';
        composer.dispatchEvent(new Event('input', {bubbles: true}));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(
        join(root, "queue-state.json"),
        JSON.stringify({
          sessionId,
          agentId: queue.final.value[0].agentId,
          queueIds: queue.final.value.map((entry) => entry.queueId),
        }),
      );
      console.log("PASS: queued and reordered two prompts before the Desktop process restart.");
      finish(0);
      return;
    }

    const state = JSON.parse(readFileSync(join(root, "queue-state.json"), "utf8"));
    await waitFor(
      `document.querySelector('#composer').value === 'Draft kept across Desktop restart'`,
    );
    const queue = await evaluate(
      `window.openminion.turns.listQueue({sessionId:${JSON.stringify(state.sessionId)}})`,
    );
    assert.equal(queue.ok, true, JSON.stringify(queue));
    assert.deepEqual(
      queue.value.map((entry) => entry.queueId),
      state.queueIds,
    );
    assert.deepEqual(
      queue.value.map((entry) => entry.text),
      [effectPrompt, removedPrompt],
    );
    await waitFor("document.querySelectorAll('#turn-queue-list li').length === 2");
    await click(`[aria-label=${JSON.stringify(`Remove: ${removedPrompt}`)}]`);
    await waitFor("document.querySelectorAll('#turn-queue-list li').length === 1");
    await submit(activePrompt);
    await waitFor(
      "!document.querySelector('#run-next').hidden && !document.querySelector('#run-next').disabled",
    );
    await click("#run-next");
    await waitFor(
      "[...document.querySelectorAll('.approval-card')].some(card => card.textContent.includes('queue-effect.txt') && card.textContent.includes('Allow once'))",
    );
    const approved = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.approval-card button')]
        .find(item => item.textContent.trim() === 'Allow once');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(approved, true);
    await waitFor(
      "document.querySelector('#cancel').hidden && document.querySelector('#timeline').textContent.includes('QUEUE_EFFECT_OK')",
    );
    assert.equal(existsSync(join(root, "queue-effect.txt")), true);
    const finalQueue = await evaluate(
      `window.openminion.turns.listQueue({sessionId:${JSON.stringify(state.sessionId)}})`,
    );
    assert.deepEqual(finalQueue, { ok: true, value: [] });
    console.log("PASS: recovered the same Core queue and executed its retained effect prompt.");
    finish(0);
  } catch (error) {
    console.error(error);
    finish(1);
  }
}

function providerMessage(body, isEffect, toolResultObserved, issued) {
  const requiredTool = body.tool_choice?.function?.name;
  const submitOutput = body.tools?.find(
    (tool) => tool.function?.name === "submit_output",
  )?.function;
  const toolRequest = body.tools?.find((tool) => tool.function?.name === "tool_request")?.function
    ?.name;
  const fileWrite = body.tools?.find((tool) => tool.function?.name === "file_write")?.function
    ?.name;
  if (requiredTool === "submit_output" && submitOutput) {
    return toolCall(
      `submit-output-${randomBytes(4).toString("hex")}`,
      "submit_output",
      structuredOutput(submitOutput.parameters, isEffect, toolResultObserved),
    );
  }
  if (isEffect && !toolResultObserved && toolRequest) {
    return toolCall("activate-file-write", toolRequest, {
      name: "file.write",
      terminal_after_success: true,
    });
  }
  if (isEffect && !toolResultObserved && fileWrite) {
    issued();
    return toolCall("queue-effect-call", fileWrite, {
      path: "queue-effect.txt",
      content: "queue effect ran once\n",
    });
  }
  return {
    role: "assistant",
    content:
      `${isEffect ? "QUEUE_EFFECT_OK" : "SLOW_TURN_OK"}\n\n` +
      '<finalization_status>{"status":"final_answer","reasoning":"deterministic queue fixture complete"}</finalization_status>',
  };
}

function structuredOutput(schema, isEffect, toolResultObserved) {
  const properties = schema?.properties ?? {};
  if (Object.hasOwn(properties, "items")) return { items: [] };
  if (Object.hasOwn(properties, "time_sensitive")) {
    return {
      intent: isEffect ? "create one local proof file" : "return one local fixture answer",
      domain: isEffect ? "coding" : "general",
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
    const satisfied = !isEffect || toolResultObserved;
    return {
      satisfied,
      reason: satisfied ? "fixture request complete" : "tool has not run",
      next_action: satisfied ? "close" : "continue",
      final_answer: satisfied ? (isEffect ? "QUEUE_EFFECT_OK" : "SLOW_TURN_OK") : null,
      memory_use_refs: [],
      mutation_claimed: isEffect && toolResultObserved,
    };
  }
  throw new Error(`Unsupported structured fixture schema: ${JSON.stringify(schema)}`);
}

function sendOpenAiResponse(response, body, message) {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!body.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "queue-fixture",
        object: "chat.completion",
        model: "queue-fixture",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "queue-fixture",
      object: "chat.completion.chunk",
      model: "queue-fixture",
      choices: [{ index: 0, delta: message, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "queue-fixture",
      object: "chat.completion.chunk",
      model: "queue-fixture",
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

function rootArguments(root) {
  return [
    "--home-root",
    root,
    "--data-root",
    join(root, "data"),
    "--config",
    join(root, "agents.json"),
  ];
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an IPC port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
