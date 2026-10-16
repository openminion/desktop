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
}, 300_000);
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
    const configured = await runCommand(executable, [...args, "config", "show"], 30_000);
    assert.equal(configured.exitCode, 0, configured.stderr);
    const agentIds = Object.keys(JSON.parse(configured.stdout).agents);
    assert.equal(agentIds.length, 1);
    const defaultAgent = agentIds[0];
    await submit("/agents");
    await waitFor(
      "document.querySelector('#command-title').textContent === 'Agents' && !document.querySelector('#command-result p').textContent.includes('Loading from OpenMinion')",
    );
    const unselectedAgents = await evaluate(
      "document.querySelector('#command-result p').textContent",
    );
    assert.equal(unselectedAgents.includes("●"), false);
    assert.deepEqual(
      unselectedAgents.split("\n").map((line) => line.split(" — ")[0]),
      agentIds,
    );
    const capabilities = await runCommand(
      executable,
      [...args, "status", "capabilities", "--runtime-source", "daemon", "--json"],
      30_000,
    );
    assert.equal(capabilities.exitCode, 0, capabilities.stderr);
    const capabilityReport = JSON.parse(capabilities.stdout);
    assert.equal(capabilityReport.source, "daemon");
    const exposure = capabilityReport.capabilities.tools.mcp_exposure;
    assert.deepEqual(exposure.configured_servers, []);
    assert.deepEqual(exposure.exposed_servers, []);
    assert.deepEqual(capabilityReport.capabilities.mcp.failed_servers, {});
    const mcpFacts = [
      "  configured  (none)",
      "  exposed     (none)",
      `  tools       ${exposure.exposed_runtime_tool_count} exposed · ${exposure.registered_runtime_tool_count} registered`,
    ];
    await submit("/mcp");
    await waitFor(
      "document.querySelector('#command-title').textContent === 'MCP' && document.querySelector('#command-result p').textContent.startsWith('MCP:')",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-result p').textContent"),
      ["MCP:", ...mcpFacts].join("\n"),
    );
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 0);
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
    const snapshotClipboard = async () =>
      Promise.all(
        (await clipboard.read()).map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
              ),
            ),
        ),
      );
    const previousClipboard = await snapshotClipboard();
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
    const skillPath = join(root, "SKILL.md");
    const seedSkill = async (id, agentId) => {
      await writeFile(
        skillPath,
        `---\nname: ${id}\nid: ${id}\nrisk: low\nverification:\n  - Confirm the catalog entry.\n---\n\n# Procedure\nRead the literal native proof <b>${id}</b>.\n\n# Verification\nConfirm the catalog entry.\n`,
      );
      const ingested = await runCommand(
        executable,
        [
          ...args,
          "skill",
          "ingest",
          "--file",
          skillPath,
          "--scope",
          agentId ? "agent" : "global",
          ...(agentId ? ["--agent-id", agentId] : []),
          "--config",
          join(root, "agents.json"),
        ],
        30_000,
      );
      assert.equal(ingested.exitCode, 0, ingested.stderr || ingested.stdout);
      const staged = JSON.parse(ingested.stdout);
      assert.equal(staged.skill_id, id);
      const admitted = await runCommand(
        executable,
        [
          ...args,
          "skill",
          "admit",
          "--skill-id",
          id,
          "--version-hash",
          staged.version_hash,
          "--expected-active-version-hash",
          "none",
          "--target-status",
          "verified",
          "--reason",
          "Native catalog fixture",
          "--config",
          join(root, "agents.json"),
        ],
        30_000,
      );
      assert.equal(admitted.exitCode, 0, admitted.stderr || admitted.stdout);
    };
    for (let index = 1; index <= 21; index += 1)
      await seedSkill(`desktop-proof-${String(index).padStart(2, "0")}`);
    const skills = await runCommand(
      executable,
      [...args, "skill", "list", "--json", "--config", join(root, "agents.json")],
      30_000,
    );
    assert.equal(skills.exitCode, 0, skills.stderr);
    const skillIds = JSON.parse(skills.stdout).skills.map((skill) => skill.skill_id);
    assert.equal(skillIds.length, 21);
    await submit("/skills");
    await waitFor("document.querySelectorAll('.skill-catalog button').length === 21");
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      "Global skill catalog",
    );
    assert.deepEqual(
      await evaluate(
        "[...document.querySelectorAll('.skill-catalog button')].map(button => button.textContent)",
      ),
      skillIds,
    );
    const catalogText = `Global skill catalog:\n${skillIds.join("\n")}`;
    const skillsClipboard = await snapshotClipboard();
    try {
      await evaluate("document.querySelector('[aria-label=\"Copy command result\"]').click()");
      await waitFor(
        "document.querySelector('[aria-label=\"Copy command result\"]').textContent === 'Copied'",
      );
      assert.equal(await clipboard.readText(), catalogText);
      for (const [width, height] of [
        [760, 560],
        [1180, 800],
      ]) {
        window.setContentSize(width, height);
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        await evaluate(
          "document.querySelector('.skill-catalog button:last-child').scrollIntoView({ block: 'end' })",
        );
        assert.equal(await evaluate("document.querySelector('#jump-latest').hidden"), true);
        assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
        assert.equal(
          await evaluate(`(() => {
          const last = document.querySelector('.skill-catalog button:last-child').getBoundingClientRect();
          const composer = document.querySelector('#composer-form').getBoundingClientRect();
          return last.top >= 0 && last.bottom <= composer.top + 0.5;
        })()`),
          true,
        );
        if (process.env.OPENMINION_E2E_ARTIFACTS)
          await writeFile(
            join(process.env.OPENMINION_E2E_ARTIFACTS, `skills-catalog-${width}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
      }
      await evaluate(`(() => {
        const composer = document.querySelector('#composer');
        composer.value = 'Keep this unsent skills draft';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.skill-catalog button:nth-last-child(2)').focus();
      })()`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await waitFor(
        "document.activeElement === document.querySelector('.skill-catalog button:last-child')",
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await waitFor(
        "[...document.querySelectorAll('#command-result button')].some(button => button.textContent === 'Back to catalog')",
      );
      assert.equal(
        await evaluate("document.querySelector('#command-title').textContent"),
        "Skill details",
      );
      const skillDetail = await runCommand(
        executable,
        [...args, "skill", "show", skillIds[20], "--config", join(root, "agents.json")],
        30_000,
      );
      assert.equal(skillDetail.exitCode, 0, skillDetail.stderr);
      const skill = JSON.parse(skillDetail.stdout).skill;
      const detailText = await evaluate("document.querySelector('#command-result p').textContent");
      assert.equal(
        detailText,
        [
          `Skill: ${skill.name}`,
          `  id       ${skill.skill_id}`,
          `  status   ${skill.status}`,
          `  scope    ${skill.scope}`,
          `  risk     ${skill.risk_class}`,
          `  version  ${skill.version_hash}`,
          "",
          "Procedure:",
          skill.sections.procedure.trim(),
          "",
          "Verification:",
          skill.sections.verification.trim(),
        ].join("\n"),
      );
      assert.equal(await evaluate("document.querySelector('#command-result b') === null"), true);
      assert.equal(
        await evaluate("document.querySelector('#composer').value"),
        "Keep this unsent skills draft",
      );
      await evaluate("document.querySelector('[aria-label=\"Copy command result\"]').click()");
      await waitFor(
        "document.querySelector('[aria-label=\"Copy command result\"]').textContent === 'Copied'",
      );
      assert.equal(await clipboard.readText(), detailText);
      await evaluate(
        "[...document.querySelectorAll('#command-result button')].find(button => button.textContent === 'Back to catalog').click()",
      );
      await waitFor("document.querySelectorAll('.skill-catalog button').length === 21");
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.skill-catalog button')].map(button => button.textContent)",
        ),
        skillIds,
      );
      assert.equal(
        await evaluate("document.querySelector('#composer').value"),
        "Keep this unsent skills draft",
      );
      assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 0);
    } finally {
      await clipboard.write(skillsClipboard);
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
    assert.equal(active.agent, defaultAgent);
    await submit("/agents");
    await waitFor(
      "document.querySelector('#command-title').textContent === 'Agents' && !document.querySelector('#command-result p').textContent.includes('Loading from OpenMinion')",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-result p').textContent"),
      `● ${unselectedAgents}`,
    );
    await submit("/mcp");
    await waitFor(
      "document.querySelector('#command-title').textContent === 'MCP' && document.querySelector('#command-result p').textContent.startsWith('MCP:')",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-result p').textContent"),
      ["MCP:", `  agent       ${active.agent}`, ...mcpFacts].join("\n"),
    );
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);
    await seedSkill("desktop-scoped-matching", active.agent);
    await seedSkill("desktop-scoped-other", `${active.agent}-other`);
    const scopedSkills = await runCommand(
      executable,
      [
        ...args,
        "skill",
        "list",
        "--agent-id",
        active.agent,
        "--json",
        "--config",
        join(root, "agents.json"),
      ],
      30_000,
    );
    assert.equal(scopedSkills.exitCode, 0, scopedSkills.stderr);
    const scopedIds = JSON.parse(scopedSkills.stdout).skills.map((skill) => skill.skill_id);
    assert.equal(scopedIds.length, 22);
    assert.ok(scopedIds.includes("desktop-scoped-matching"));
    assert.equal(scopedIds.includes("desktop-scoped-other"), false);
    await submit("/skills");
    await waitFor("document.querySelectorAll('.skill-catalog button').length === 22");
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      `Stored skills for ${active.agent}`,
    );
    assert.deepEqual(
      await evaluate(
        "[...document.querySelectorAll('.skill-catalog button')].map(button => button.textContent)",
      ),
      scopedIds,
    );
    await evaluate(`(() => {
      const composer = document.querySelector('#composer');
      composer.value = 'Keep this unsent scoped skills draft';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.skill-catalog button')].find(button => button.textContent === 'desktop-scoped-matching').click();
    })()`);
    await waitFor(
      "document.querySelector('#command-result p')?.textContent.includes('id       desktop-scoped-matching')",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      "Skill details",
    );
    assert.ok(
      (await evaluate("document.querySelector('#command-result p').textContent")).includes(
        "scope    agent",
      ),
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Keep this unsent scoped skills draft",
    );
    await evaluate(
      "[...document.querySelectorAll('#command-result button')].find(button => button.textContent === 'Back to catalog').click()",
    );
    await waitFor("document.querySelectorAll('.skill-catalog button').length === 22");
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      `Stored skills for ${active.agent}`,
    );
    assert.deepEqual(
      await evaluate(
        "[...document.querySelectorAll('.skill-catalog button')].map(button => button.textContent)",
      ),
      scopedIds,
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "Keep this unsent scoped skills draft",
    );
    assert.equal(await evaluate("document.querySelectorAll('.message.assistant').length"), 2);
    await evaluate("document.querySelector('#close-command').click()");
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
      "PASS: real Core default-agent marker and no-server MCP inventory with CLI readback, graph readiness/clipboard, complete 21-skill global catalog/detail/back/copy with keyboard selection and draft preservation, selected-agent stored skills with other-agent exclusion and detail/back draft preservation, custom-command discovery/render/send, expansion refusal, tool activation/status/deactivation, scoped delegation list, fresh CLI session metadata, keyboard session selection, and responsive native UI. Provider-free evidence only; no nondefault live MCP exposure proof.",
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
