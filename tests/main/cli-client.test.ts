import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliClient } from "../../src/main/cli-client.js";
import { DesktopStore } from "../../src/main/desktop-store.js";
import { runCommand } from "../../src/main/installation.js";
import type { TurnEventV1 } from "../../src/shared/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("PyPI CLI client", () => {
  it("preserves canonical session catalog and detail metadata without inventing missing facts", async () => {
    let facts: Record<string, unknown> = { channel: "cli", turns: 0, age: "2m" };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        args[1] === "export"
          ? ""
          : JSON.stringify(
              args[1] === "list"
                ? [{ ...session("saved"), ...facts }]
                : { ...session("saved"), ...facts },
            ),
    }));
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    expect(await client.list({})).toMatchObject({
      ok: true,
      value: {
        sessions: [
          {
            channel: "cli",
            messageCount: 0,
            updatedLabel: "2m",
          },
        ],
      },
    });
    expect(await client.load({ sessionId: "saved" })).toMatchObject({
      ok: true,
      value: {
        session: {
          channel: "cli",
          messageCount: 0,
          updatedLabel: null,
          updatedAt: now,
        },
      },
    });
    facts = {};
    expect(await client.list({})).toMatchObject({
      ok: true,
      value: {
        sessions: [
          {
            channel: null,
            messageCount: null,
            updatedLabel: null,
          },
        ],
      },
    });
    for (const invalid of ["2", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      facts = { turns: invalid };
      expect(await client.list({})).toMatchObject({
        ok: false,
        error: { code: "invalid_daemon_response" },
      });
    }
    for (const invalid of [{ channel: 1 }, { age: false }]) {
      facts = invalid;
      expect(await client.list({})).toMatchObject({ ok: false });
    }
  });

  it("reads persisted status without exporting history and keeps draft status local", async () => {
    let row = { ...session("saved"), channel: "cli", turns: 8, metadata: { secret: "private" } };
    const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(row) }));
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    const result = await client.readReport({ kind: "status", sessionId: "saved" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "status",
        session: {
          sessionId: "saved",
          channel: "cli",
          messageCount: 8,
          updatedAt: now,
          model: { provider: null, modelId: null },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(
      "openminion",
      ["sessions", "show", "saved", "--json"],
      expect.any(Number),
    );
    const draft = await client.create({});
    if (!draft.ok) throw new Error("Draft not created");
    run.mockClear();
    expect(
      await client.readReport({ kind: "status", sessionId: draft.value.sessionId }),
    ).toMatchObject({ ok: true, value: { kind: "status", session: { isDraft: true } } });
    for (const input of [
      { kind: "status" },
      { kind: "status", sessionId: "--help" },
      { kind: "status", sessionId: "saved\0" },
      { kind: "status", sessionId: "saved", toolView: "status" },
      { kind: "status", sessionId: "saved", agentFilter: undefined },
    ])
      expect(await client.readReport(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    expect(run).not.toHaveBeenCalled();
    row = { ...row, id: "other" };
    expect(await client.readReport({ kind: "status", sessionId: "saved" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    row = { ...row, id: "saved", turns: -1 };
    expect(await client.readReport({ kind: "status", sessionId: "saved" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    run.mockResolvedValueOnce({ exitCode: 1, stderr: "Session unavailable", stdout: "" });
    expect(await client.readReport({ kind: "status", sessionId: "saved" })).toMatchObject({
      ok: false,
    });
  });

  it("uses authenticated session custom-command routes without exposing private fields", async () => {
    const requests: {
      path: string | undefined;
      token: string | string[] | undefined;
      body: string;
    }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ path: req.url, token: req.headers["x-ipc-token"], body });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            req.method === "GET"
              ? {
                  ok: true,
                  session_id: "saved",
                  commands: [
                    {
                      name: "/summarize",
                      description: "Summarize",
                      usage: "/summarize <text>",
                      private: "not exposed",
                    },
                  ],
                }
              : {
                  ok: true,
                  session_id: "saved",
                  name: "/summarize",
                  prompt: "Summarize first  second",
                  private: "not exposed",
                },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const run = vi.fn(async (_executable: string, args: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(
        args[0] === "daemon"
          ? { reachable: true, host: "127.0.0.1", port: address.port }
          : { runtime: { ipc_token: "private-test-token" } },
      ),
    }));
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    expect(await client.readReport({ kind: "commands", sessionId: "saved" })).toEqual({
      ok: true,
      value: {
        kind: "commands",
        commands: [{ name: "/summarize", description: "Summarize", usage: "/summarize <text>" }],
      },
    });
    expect(
      await client.readReport({
        kind: "command",
        sessionId: "saved",
        commandName: "/summarize",
        arguments: "first  second",
      }),
    ).toEqual({ ok: true, value: { kind: "command", prompt: "Summarize first  second" } });
    expect(requests).toEqual([
      { path: "/v1/sessions/saved/custom-commands", token: "private-test-token", body: "" },
      {
        path: "/v1/sessions/saved/custom-commands/summarize/render",
        token: "private-test-token",
        body: JSON.stringify({ arguments: "first  second" }),
      },
    ]);
    for (const invalid of [
      { kind: "command", sessionId: "saved", commandName: "../private", arguments: "" },
      { kind: "commands", sessionId: "saved", arguments: "hidden" },
      { kind: "tokens", sessionId: "saved", commandName: "/hidden" },
    ])
      expect(await client.readReport(invalid)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    expect(requests).toHaveLength(2);
  });

  it("changes tool exposure through scoped authenticated operations without implicit approval", async () => {
    const fixture = await executableFixture();
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    expect(
      await client.controlTools({
        sessionId: "saved",
        action: "activate",
        profileId: "web",
        targetId: "example.com",
        taskId: "work-1",
        ttlSeconds: 60,
        credentialScopes: ["search"],
        dependencies: ["network"],
        reason: "Research",
      }),
    ).toEqual({ ok: true, value: { text: "Activated: web (audit-1)" } });
    const activation = fixture.requests.find(
      (item) => item.path === "/v1/tools/exposure/activate",
    )!;
    expect(activation.body).toEqual({
      session_id: "saved",
      profile_id: "web",
      target_id: "example.com",
      task_id: "work-1",
      ttl_seconds: 60,
      credential_scopes: ["search"],
      dependencies: ["network"],
      activation_reason: "Research",
    });
    expect(activation.token).toBe("test-private-token");
    expect(
      await client.controlTools({
        sessionId: "saved",
        action: "deactivate",
        profileId: "web",
        targetId: "example.com",
        taskId: "work-1",
      }),
    ).toEqual({ ok: true, value: { text: "Deactivated: web" } });
    const before = fixture.requests.length;
    for (const input of [
      { action: "activate", approved: "true" },
      { action: "activate", credentialScopes: ["search", 42] },
      { action: "activate", ttlSeconds: -1 },
      { action: "deactivate", approved: true },
      { action: "activate", apiKey: "do not forward" },
    ])
      expect(
        await client.controlTools({ sessionId: "saved", profileId: "web", ...input }),
      ).toMatchObject({ ok: false });
    expect(fixture.requests).toHaveLength(before);
  });

  it("does not run delegation commands on a runtime without the scoped contract", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "--limit --json", stderr: "" });
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    const created = await client.create({ agentId: "writer" });
    if (!created.ok) throw new Error("No draft");
    expect(
      await client.controlDelegation({ sessionId: created.value.sessionId, action: "list" }),
    ).toMatchObject({ ok: false, error: { code: "delegation_unavailable" } });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "openminion",
      ["agent", "delegate-list", "--help"],
      30_000,
    );
    run.mockClear();
    expect(
      await client.controlDelegation({
        sessionId: created.value.sessionId,
        action: "resume",
        taskId: "task-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "all 25 skills",
      payload: {
        ok: true,
        skills: Array.from({ length: 25 }, (_, i) => ({
          skill_id: `skill-${i}`,
          private: "hidden",
        })),
      },
      expected: {
        ok: true,
        value: { kind: "skills", skills: Array.from({ length: 25 }, (_, i) => `skill-${i}`) },
      },
    },
    {
      label: "empty catalog",
      payload: { ok: true, skills: [] },
      expected: { ok: true, value: { kind: "skills", skills: [] } },
    },
    {
      label: "unavailable catalog",
      payload: { ok: false },
      expected: { ok: false, error: { code: "report_unavailable" } },
    },
    {
      label: "malformed skill",
      payload: { ok: true, skills: [{ skill_id: 7 }] },
      expected: { ok: false, error: { code: "invalid_daemon_response" } },
    },
  ])("reads $label without truncating or inventing records", async ({ payload, expected }) => {
    const fixture = await executableFixture("normal", {}, { list: payload });
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    expect(await client.readReport({ kind: "skills" })).toMatchObject(expected);
  });

  it("scopes stored skills to fresh session facts and the same draft default as chat", async () => {
    const fixture = await executableFixture();
    let row = session("saved");
    let failed = false;
    const run = vi.fn(async (executable: string, args: readonly string[], timeout: number) => {
      if (args[1] === "sessions")
        return failed
          ? { exitCode: 1, stderr: "Session unavailable", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(row) };
      return runCommand(executable, args, timeout);
    });
    const client = new CliClient(
      () => ({ executable: fixture.executable, args: fixture.args }),
      run,
    );
    for (const agent of ["writer", "reviewer+notes&scope=other"]) {
      row = { ...row, agent };
      expect(await client.readReport({ kind: "skills", sessionId: "saved" })).toMatchObject({
        ok: true,
        value: { kind: "skills", agentId: agent, skills: ["example"] },
      });
      expect(fixture.requests.at(-1)).toMatchObject({
        path: `/v1/skills?agent_id=${encodeURIComponent(agent)}`,
        token: "test-private-token",
      });
    }
    for (const agentId of [undefined, "draft-agent"]) {
      const draft = await client.create(agentId ? { agentId } : {});
      if (!draft.ok) throw new Error("Draft not created");
      run.mockClear();
      expect(
        await client.readReport({ kind: "skills", sessionId: draft.value.sessionId }),
      ).toMatchObject({
        ok: true,
        value: { agentId: agentId ?? "writer" },
      });
      expect(run.mock.calls.some(([, args]) => args[1] === "sessions")).toBe(false);
      expect(fixture.requests.at(-1)?.path).toBe(`/v1/skills?agent_id=${agentId ?? "writer"}`);
    }
    row = { ...row, id: "different" };
    const reads = fixture.requests.length;
    expect(await client.readReport({ kind: "skills", sessionId: "saved" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    failed = true;
    expect(await client.readReport({ kind: "skills", sessionId: "saved" })).toMatchObject({
      ok: false,
    });
    expect(fixture.requests).toHaveLength(reads);
    expect(run.mock.calls.some(([, args]) => args.includes("export"))).toBe(false);
  });

  it("rejects a different skill identity and unrelated skill report inputs", async () => {
    const fixture = await executableFixture(
      "normal",
      {},
      { detail: { ok: true, skill: { skill_id: "other" } } },
    );
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    expect(await client.readReport({ kind: "skills", skillId: "example" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    const reads = fixture.requests.length;
    for (const extra of [
      { sessionId: "session", skillId: "example" },
      { sessionId: "--help" },
      { sessionId: "saved\0" },
      { agentId: "writer" },
      { arguments: "extra" },
    ]) {
      expect(await client.readReport({ kind: "skills", ...extra })).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    expect(fixture.requests).toHaveLength(reads);
  });

  it("reads authenticated inventories and excludes private discovery fields", async () => {
    const fixture = await executableFixture();
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    expect(await client.readReport({ kind: "agents" })).toEqual({
      ok: true,
      value: { kind: "agents", agents: [{ id: "writer", label: "Writer" }] },
    });
    expect(await client.readReport({ kind: "agents", agentFilter: "Writer" })).toMatchObject({
      ok: true,
      value: { agents: [{ id: "writer" }] },
    });
    expect(await client.readReport({ kind: "agents", agentFilter: "other" })).toMatchObject({
      ok: true,
      value: { agents: [] },
    });
    expect(await client.readReport({ kind: "tools" })).toEqual({
      ok: true,
      value: {
        kind: "tools",
        tools: [
          { name: "disabled", enabled: false },
          { name: "search", enabled: true },
        ],
      },
    });
    expect(await client.readReport({ kind: "skills" })).toEqual({
      ok: true,
      value: {
        kind: "skills",
        agentId: null,
        skills: ["example"],
      },
    });
    expect(await client.readReport({ kind: "skills", skillId: "example" })).toMatchObject({
      ok: true,
      value: {
        kind: "skills",
        text: expect.stringContaining("Instructions:\nUse the approved tool."),
      },
    });
    expect(await client.readReport({ kind: "skills", skillId: "../private" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await client.readReport({ kind: "learning" })).toEqual({
      ok: true,
      value: {
        kind: "learning",
        text: [
          "Skill learning:",
          "  pending        1",
          "  surfaced       1",
          "  accepted       0",
          "  rejected       0",
          "  deferred       0",
          "  auto-dismissed 0",
          "Pending proposals:",
          "  - proposal-1 · Inventory Workflow",
          "Use /learning <proposal_id> to view details.",
        ].join("\n"),
      },
    });
    expect(
      await client.readReport({
        kind: "learning",
        proposalId: "proposal-1",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "learning",
        text: expect.stringContaining("Learning proposal: proposal-1"),
      },
    });
    expect(
      await client.readReport({
        kind: "learning",
        proposalId: "../private",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await client.readReport({ kind: "mcp", agentId: "writer" })).toEqual({
      ok: true,
      value: {
        kind: "mcp",
        text: [
          "MCP:",
          "  configured  local",
          "  exposed     local",
          "  tools       2 exposed · 3 registered",
        ].join("\n"),
      },
    });
    expect(await client.readReport({ kind: "tools", agentFilter: "writer" })).toMatchObject({
      ok: false,
    });
    expect(await client.readReport({ kind: "agents", path: "/v1/private" })).toMatchObject({
      ok: false,
    });
    expect(await client.readReport({ kind: "arbitrary" })).toMatchObject({
      ok: false,
    });
    expect(fixture.requests).toHaveLength(10);
    expect(fixture.requests.every((request) => request.token === "test-private-token")).toBe(true);
  });

  it("reads scoped tool exposure and rejects invalid selectors", async () => {
    const fixture = await executableFixture();
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    for (const sessionId of [undefined, "session/one"])
      expect(
        await client.readReport({
          kind: "tools",
          toolView: "status",
          ...(sessionId ? { sessionId } : {}),
        }),
      ).toEqual({
        ok: true,
        value: {
          kind: "tools",
          text: "Tool exposure profiles:\n  active  web (standard)  degraded\n    browser: missing · Install browser\nOther tool dependencies:\n  exec: ready (shell)",
        },
      });
    expect(fixture.requests.map((request) => request.path)).toEqual([
      "/v1/tools/exposure",
      "/v1/tools/exposure?session_id=session%2Fone",
    ]);
    expect(await client.readReport({ kind: "tools", toolView: "list" })).toMatchObject({
      ok: true,
      value: { tools: expect.any(Array) },
    });
    for (const input of [
      { kind: "agents", toolView: "status" },
      { kind: "tools", toolView: "activate" },
      { kind: "tools", toolView: ["status"] },
      { kind: "tools", toolView: { value: "status" } },
      { kind: "tools", toolView: "status", sessionId: "" },
    ])
      expect(await client.readReport(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    expect(fixture.requests).toHaveLength(3);
  });

  it("reads graph readiness with fixed configuration and rejects unrelated authority", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "GraphFakos installed: no\nNext: install viewer",
      stderr: "",
    });
    const client = new CliClient(
      () => ({ executable: "openminion", args: ["--config", "/private/config"] }),
      run,
    );
    expect(await client.readReport({ kind: "graph", graphView: "status" })).toEqual({
      ok: true,
      value: { kind: "graph", text: "GraphFakos installed: no\nNext: install viewer" },
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "openminion",
      ["--config", "/private/config", "graph", "status"],
      30_000,
    );
    for (const input of [
      { kind: "graph", graphView: "refresh" },
      { kind: "graph", graphView: ["status"] },
      { kind: "graph", graphView: "status", sessionId: "session-1" },
      { kind: "graph", graphView: "status", provider: "custom" },
      { kind: "graph", graphView: "status", path: "/private" },
      { kind: "graph", graphView: "status", agentFilter: undefined },
      { kind: "tokens", graphView: "status", sessionId: "session-1" },
    ])
      expect(await client.readReport(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Private failure" });
    expect(await client.readReport({ kind: "graph", graphView: "status" })).toMatchObject({
      ok: false,
      error: { code: "report_unavailable", message: "OpenMinion could not read the graph report." },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses canonical token formatting and transcript export without renderer paths", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Canonical report\n",
      stderr: "",
    });
    const client = new CliClient(
      () => ({
        executable: "openminion",
        args: ["--config", "/private/config"],
      }),
      run,
    );
    expect(await client.readReport({ kind: "tokens", sessionId: "session-1" })).toEqual({
      ok: true,
      value: { kind: "tokens", text: "Canonical report\n" },
    });
    expect(run.mock.calls.at(-1)?.[1]).toEqual([
      "--config",
      "/private/config",
      "status",
      "tokens",
      "--session-id",
      "session-1",
    ]);
    expect(await client.readReport({ kind: "graph" })).toEqual({
      ok: true,
      value: { kind: "graph", text: "Canonical report\n" },
    });
    expect(run.mock.calls.at(-1)?.[1]).toEqual(["--config", "/private/config", "graph", "--help"]);
    expect(await client.exportTranscript({ sessionId: "session-1" })).toEqual({
      ok: true,
      value: "Canonical report\n",
    });
    expect(run.mock.calls.at(-1)?.[1]).toEqual([
      "--config",
      "/private/config",
      "export",
      "transcript",
      "--session-id",
      "session-1",
      "--format",
      "md",
    ]);
    expect(
      await client.exportTranscript({
        sessionId: "session-1",
        path: "/private/file",
      }),
    ).toMatchObject({ ok: false });
    expect(await client.readReport({ kind: "tokens" })).toMatchObject({
      ok: false,
    });
    expect(await client.readReport({ kind: "tokens", sessionId: "--help" })).toMatchObject({
      ok: false,
    });
    expect(await client.exportTranscript({ sessionId: "--help" })).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(3);
    const draft = await client.create({});
    if (!draft.ok) throw new Error("Draft not created");
    expect(await client.exportTranscript({ sessionId: draft.value.sessionId })).toMatchObject({
      ok: false,
    });
    expect(
      await client.readReport({
        kind: "tokens",
        sessionId: draft.value.sessionId,
      }),
    ).toMatchObject({ ok: true, value: { text: "No active session." } });
    run.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "private diagnostic",
    });
    expect(await client.readReport({ kind: "tokens", sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "token_report_unavailable" },
    });
    expect(await new CliClient(() => null).readReport({ kind: "tools" })).toMatchObject({
      ok: false,
    });
  });

  it("routes scoped task operations to fixed CLI arguments and projects only public facts", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        scheduler: {
          state: "unreachable",
          hosted_by: "daemon",
          reason: "daemon_unreachable",
          check_command: "openminion service status cron",
        },
        tasks: [
          {
            id: "work-1",
            title: "Scheduled work",
            lifecycle_state: "PAUSED",
            session_target: "isolated",
            valid_actions: ["resume", "cancel"],
            recent_runs: [
              {
                run_id: "run-2",
                state: "failed",
                summary: null,
                attempts: 2,
                due_at: "2026-09-30T10:59:00Z",
                available_at: "2026-09-30T11:00:00Z",
                started_at: "2026-09-30T11:00:00Z",
                finished_at: "2026-09-30T11:01:00Z",
                isolated_session_id: "result-session-2",
                error: {
                  code: "PROVIDER_UNAVAILABLE",
                  message: "Provider unavailable",
                },
                delivery: {
                  state: "not_requested",
                  mode: "none",
                  targets: [],
                  error: null,
                },
                delivery_targets: [],
              },
              {
                run_id: "run-1",
                state: "finished",
                summary: "Review complete",
                attempts: 1,
                due_at: "2026-09-30T09:59:00Z",
                available_at: "2026-09-30T10:00:00Z",
                started_at: "2026-09-30T10:00:00Z",
                finished_at: "2026-09-30T10:01:00Z",
                isolated_session_id: "result-session-1",
                error: null,
                delivery: {
                  state: "failed",
                  mode: "announce",
                  targets: ["announce:last"],
                  error: {
                    code: "DELIVERY_FAILED",
                    message: "Destination unavailable",
                  },
                },
                delivery_targets: [],
                credential: "never-return-this",
              },
            ],
            credential: "never-return-this",
          },
        ],
        pending_actions: [
          {
            decision_id: "decision-1",
            task_id: "work-1",
            reason: "Write access required",
            tool: "file.write",
            credential: "never-return-this",
          },
        ],
      }),
    });
    const client = new CliClient(
      () => ({
        executable: "/managed/openminion",
        args: ["--config", "/private/config.json"],
      }),
      run,
    );
    const created = await client.create({ agentId: "writer" });
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const inventory = await client.controlTasks({ sessionId, action: "list" });
    expect(inventory).toMatchObject({
      ok: true,
      value: {
        scheduler: {
          state: "unreachable",
          reason: "daemon_unreachable",
          checkCommand: "openminion service status cron",
        },
        tasks: [
          {
            id: "work-1",
            status: "PAUSED",
            sessionTarget: "isolated",
            validActions: ["resume", "cancel"],
            recentRuns: [
              {
                runId: "run-2",
                state: "failed",
                dueAt: "2026-09-30T10:59:00Z",
                availableAt: "2026-09-30T11:00:00Z",
                error: {
                  code: "PROVIDER_UNAVAILABLE",
                  message: "Provider unavailable",
                },
                delivery: { state: "not_requested" },
              },
              {
                runId: "run-1",
                state: "finished",
                summary: "Review complete",
                isolatedSessionId: "result-session-1",
                delivery: {
                  state: "failed",
                  error: {
                    code: "DELIVERY_FAILED",
                    message: "Destination unavailable",
                  },
                },
              },
            ],
          },
        ],
        pendingActions: [
          {
            decisionId: "decision-1",
            taskId: "work-1",
            reason: "Write access required",
            tool: "file.write",
          },
        ],
      },
    });
    expect(JSON.stringify(inventory)).not.toContain("never-return-this");
    expect(run).toHaveBeenLastCalledWith(
      "/managed/openminion",
      [
        "--config",
        "/private/config.json",
        "tasks",
        "list",
        "--session",
        sessionId,
        "--json",
        "--agent-id",
        "writer",
      ],
      30_000,
    );
    run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        task: {
          id: "work-1",
          status: "ACTIVE",
          valid_actions: ["pause", "cancel"],
        },
      }),
    });
    expect(
      await client.controlTasks({
        sessionId,
        action: "resume",
        taskId: "work-1",
      }),
    ).toMatchObject({ ok: true, value: { tasks: [{ status: "ACTIVE" }] } });
    expect(run.mock.calls.at(-1)?.[1]).toContain("resume");
    run.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "private detail",
      stdout:
        '{"ok":false,"error_code":"TASK_RESUME_EXPIRED_ONE_SHOT","error":"Expired one-time tasks cannot resume."}',
    });
    const expired = await client.controlTasks({
      sessionId,
      action: "resume",
      taskId: "work-1",
    });
    expect(expired).toMatchObject({
      ok: false,
      error: {
        code: "TASK_RESUME_EXPIRED_ONE_SHOT",
        message: "Expired one-time tasks cannot resume.",
      },
    });
    expect(JSON.stringify(expired)).not.toContain("private detail");
    const calls = run.mock.calls.length;
    for (const input of [
      { sessionId, action: "delete", taskId: "work-1" },
      { sessionId, action: "resume", taskId: "--help" },
      { sessionId, action: "pause", taskId: "" },
      { sessionId, action: "cancel", taskId: "a\nb" },
      { sessionId, action: "allow", decisionId: "decision-1" },
      { sessionId, action: "list", args: ["--config", "/other"] },
    ])
      expect(await client.controlTasks(input)).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(calls);
  });

  it("creates schedules through the CLI with exact session and agent scope", async () => {
    const run = vi.fn();
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    const created = await client.create({ agentId: "writer" });
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    for (const [kind, value, timing] of [
      ["at", "2099-02-01T12:00:00Z", ["--at=2099-02-01T12:00:00Z"]],
      ["every", "5", ["--every-ms=300000"]],
      ["cron", "0 9 * * 1-5", ["--cron=0 9 * * 1-5", "--tz=America/Los_Angeles"]],
    ] as const) {
      run.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"ok":true}',
        stderr: "",
      });
      run.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"ok":true,"tasks":[{"id":"scheduled-1"}],"pending_actions":[]}',
        stderr: "",
      });
      const result = await client.controlTasks({
        sessionId,
        action: "schedule",
        schedule: {
          name: "--help",
          instruction: "Do this; $(literal)",
          kind,
          value,
          timezone: "America/Los_Angeles",
        },
      });
      expect(result).toMatchObject({
        ok: true,
        value: { tasks: [{ id: "scheduled-1" }] },
      });
      expect(run.mock.calls.at(-2)?.[1]).toEqual([
        "schedule",
        "create",
        "--name=--help",
        "--instruction=Do this; $(literal)",
        ...timing,
        "--session",
        sessionId,
        "--json",
        "--agent-id",
        "writer",
      ]);
      expect(run.mock.calls.at(-1)?.[1]).toEqual([
        "tasks",
        "list",
        "--session",
        sessionId,
        "--json",
        "--agent-id",
        "writer",
      ]);
    }
  });

  it("runs fixed session-scoped delegation operations and projects safe inspection facts", async () => {
    const run = vi.fn();
    const client = new CliClient(
      () => ({ executable: "openminion", args: ["--config", "/private/config.json"] }),
      (executable, args, timeout) =>
        args.at(-1) === "--help"
          ? Promise.resolve({ exitCode: 0, stderr: "", stdout: "--parent-agent-id --session-id" })
          : run(executable, args, timeout),
    );
    const created = await client.create({ agentId: "writer" });
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        mode: "async",
        status: "running",
        agent_id: "reviewer",
        task_id: "task-1",
        trace_id: "a2a-trace-1",
        content: "Delegated A2A job is still running.",
        outputs: {},
      }),
    });

    expect(
      await client.controlDelegation({
        sessionId,
        action: "async",
        targetAgentId: "reviewer",
        instruction: "Review the bounded change.",
        timeoutSeconds: 90,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        action: "async",
        status: "running",
        taskId: "task-1",
        a2aTraceId: "a2a-trace-1",
      },
    });
    expect(run.mock.calls.at(-1)).toEqual([
      "openminion",
      [
        "--config",
        "/private/config.json",
        "agent",
        "delegate",
        "--target-agent-id=reviewer",
        "--instruction=Review the bounded change.",
        "--mode",
        "async",
        "--timeout-seconds",
        "90",
        "--parent-agent-id",
        "writer",
        "--session-id",
        sessionId,
        "--json",
      ],
      100_000,
    ]);

    run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        mode: "inspect",
        status: "running",
        task_id: "task-1",
        trace_id: "a2a-trace-1",
        outputs: {
          support: "supported",
          authority: "session_task_owner",
          task: {
            task_id: "task-1",
            trace_id: "a2a-trace-1",
            agent_id: "reviewer",
            method: "delegate",
            state: "RUNNING",
            current_step: "working",
            progress: 0.5,
            created_at: "2026-10-07T00:00:00Z",
            updated_at: "2026-10-07T00:00:01Z",
            private_result: "never return this",
          },
          links: {
            invocation_id: "invocation-1",
            source_execution_id: "execution-1",
            handoff_id: "handoff-1",
            credential: "never return this",
          },
          timeline: [
            {
              timestamp: "2026-10-07T00:00:00Z",
              message_id: "message-1",
              a2a_trace_id: "a2a-trace-1",
              from_agent: "writer",
              to_agent: "reviewer",
              type: "job.start",
              method: "delegate",
              status: "JOB_QUEUED",
              task_id: "task-1",
              private_prompt: "never return this",
            },
          ],
          child_session: { status: "available", session_id: "child-session" },
          raw_content: { status: "unavailable", content: "never return this" },
        },
      }),
    });

    const inspected = await client.controlDelegation({
      sessionId,
      action: "inspect",
      taskId: "task-1",
    });
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        inspection: {
          authority: "session_task_owner",
          links: {
            invocationId: "invocation-1",
            sourceExecutionId: "execution-1",
            handoffId: "handoff-1",
          },
          childSession: { status: "available", sessionId: "child-session" },
          rawContentStatus: "unavailable",
        },
      },
    });
    expect(JSON.stringify(inspected)).not.toContain("never return this");
    expect(run.mock.calls.at(-1)?.[1]).toEqual([
      "--config",
      "/private/config.json",
      "agent",
      "delegate-inspect",
      "--task-id",
      "task-1",
      "--parent-agent-id",
      "writer",
      "--session-id",
      sessionId,
      "--json",
    ]);
    const calls = run.mock.calls.length;
    for (const input of [
      { sessionId, action: "inspect", taskId: "--help" },
      { sessionId, action: "inspect", taskId: "task-1", instruction: "hidden" },
      { sessionId, action: "async", targetAgentId: "reviewer", instruction: "" },
      { sessionId, action: "shell", args: ["--config", "/other"] },
    ])
      expect(await client.controlDelegation(input)).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(calls);
  });

  it.each(["SUCCESS", "FAILED"])(
    "drops terminal %s child prose from delegation inspection",
    async (state) => {
      const run = vi.fn();
      const client = new CliClient(
        () => ({ executable: "openminion", args: [] }),
        (executable, args, timeout) =>
          args.at(-1) === "--help"
            ? Promise.resolve({ exitCode: 0, stderr: "", stdout: "--parent-agent-id --session-id" })
            : run(executable, args, timeout),
      );
      const created = await client.create({ agentId: "writer" });
      if (!created.ok) throw new Error("Draft not created");
      run.mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          mode: "inspect",
          status: "success",
          task_id: "task-terminal",
          trace_id: "a2a-trace-terminal",
          content: "PRIVATE TERMINAL CHILD PROSE",
          outputs: {
            support: "supported",
            authority: "session_task_owner",
            task: {
              task_id: "task-terminal",
              trace_id: "a2a-trace-terminal",
              agent_id: "reviewer",
              method: "delegate",
              state,
            },
            links: {
              invocation_id: "",
              source_execution_id: "",
              handoff_id: "",
            },
            timeline: [],
            child_session: { status: "not_recorded" },
            raw_content: { status: "unavailable" },
          },
        }),
      });

      const inspected = await client.controlDelegation({
        sessionId: created.value.sessionId,
        action: "inspect",
        taskId: "task-terminal",
      });

      expect(inspected).toMatchObject({
        ok: true,
        value: {
          content: null,
          inspection: { task: { state }, rawContentStatus: "unavailable" },
        },
      });
      expect(JSON.stringify(inspected)).not.toContain("PRIVATE TERMINAL CHILD PROSE");
    },
  );

  it("loads saved CLI task scope without consulting the daemon", async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "sessions" && args[1] === "show")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            id: "saved-session",
            status: "idle",
            metadata: { name: "Saved conversation" },
            created_at: "2026-09-30T09:00:00Z",
            updated_at: "2026-09-30T09:00:00Z",
            agent: "writer",
          }),
        };
      if (args[0] === "export") return { exitCode: 0, stderr: "", stdout: "" };
      if (args[0] === "tasks" && args[1] === "list")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            tasks: [{ id: "task-1", valid_actions: [] }],
            pending_actions: [],
            scheduler: { state: "unreachable", hosted_by: "daemon" },
          }),
        };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    expect(await client.controlTasks({ sessionId: "saved-session", action: "list" })).toMatchObject(
      {
        ok: true,
        value: { scheduler: { state: "unreachable" }, tasks: [{ id: "task-1" }] },
      },
    );
    expect(run.mock.calls.some(([, args]) => args[0] === "daemon")).toBe(false);
  });

  it("rejects malformed schedule inputs and reports a created schedule when readback fails", async () => {
    const run = vi.fn();
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const schedule = {
      name: "Daily",
      instruction: "Summarize",
      kind: "every",
      value: "5",
      timezone: "UTC",
    };
    for (const change of [
      { name: "" },
      { instruction: "" },
      { value: "0" },
      { value: "-1" },
      { value: "Infinity" },
      { name: "bad\0name" },
      { kind: "unknown" },
      { kind: "at", value: "2099-01-01T09:00" },
      { kind: "cron", timezone: "" },
      { args: ["--config", "/other"] },
    ])
      expect(
        await client.controlTasks({
          sessionId,
          action: "schedule",
          schedule: { ...schedule, ...change },
        }),
      ).toMatchObject({ ok: false });
    expect(
      await client.controlTasks({
        sessionId,
        action: "schedule",
        taskId: "unrelated",
        schedule,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await client.controlTasks({
        sessionId: "--help",
        action: "schedule",
        schedule,
      }),
    ).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    });
    run.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "private detail",
    });
    expect(await client.controlTasks({ sessionId, action: "schedule", schedule })).toMatchObject({
      ok: false,
      error: {
        code: "schedule_refresh_failed",
        message: "Your schedule was created. Refresh the work list to see its details.",
      },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(client.beginConfiguration()).toBe(true);
  });

  it("fences a pending task change from Settings and sending, then releases after failure", async () => {
    let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const run = vi.fn(
      () =>
        new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const pending = client.controlTasks({
      sessionId,
      action: "pause",
      taskId: "work-1",
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(client.beginConfiguration()).toBe(false);
    expect(await client.submit({ sessionId, message: "hello" }, vi.fn())).toMatchObject({
      ok: false,
      error: { code: "task_control_busy" },
    });
    expect(
      await client.controlTasks({
        sessionId,
        action: "cancel",
        taskId: "work-1",
      }),
    ).toMatchObject({ ok: false });
    finish({ exitCode: 1, stdout: "", stderr: "private diagnostic" });
    const rejected = await pending;
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "cli_command_failed" },
    });
    expect(JSON.stringify(rejected)).not.toContain("private diagnostic");
    expect(client.beginConfiguration()).toBe(true);
    client.endConfiguration();
  });

  it.skipIf(!process.env.OPENMINION_PYPI_EXECUTABLE)(
    "uses the published CLI and API for a durable conversation across daemon restart",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "desktop-pypi-chat-"));
      const executable = process.env.OPENMINION_PYPI_EXECUTABLE!;
      const configPath = join(root, "agents.json");
      const args = ["--home-root", root, "--data-root", join(root, "data"), "--config", configPath];
      const command = async (suffix: string[]) => {
        const result = await runCommand(executable, [...args, ...suffix], 30_000);
        expect(result.exitCode, suffix.join(" ")).toBe(0);
        return result.stdout;
      };
      let started = false;
      try {
        await command(["config", "init", "--provider", "echo"]);
        const portServer = createServer();
        await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
        const address = portServer.address();
        if (!address || typeof address === "string") throw new Error("No port");
        await new Promise<void>((resolve) => portServer.close(() => resolve()));
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.runtime.ipc_host = "127.0.0.1";
        config.runtime.ipc_port = address.port;
        config.runtime.ipc_token = "isolated-test-token";
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        await command(["daemon", "start"]);
        started = true;
        const client = new CliClient(() => ({ executable, args }));
        const created = await client.create({});
        if (!created.ok) throw new Error("Draft not created");
        const sessionId = created.value.sessionId;
        const events: TurnEventV1[] = [];
        const submitted = await client.submit(
          { sessionId, message: "Desktop published-package integration" },
          (event) => events.push(event),
        );
        expect(submitted).toMatchObject({ ok: true });
        await vi.waitFor(
          () =>
            expect(events.at(-1)).toMatchObject({
              kind: "done",
              outcome: "complete",
            }),
          { timeout: 30_000 },
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "response",
            finalText: expect.stringContaining("Desktop published-package integration"),
          }),
        );
        const loaded = await client.load({ sessionId });
        expect(loaded).toMatchObject({
          ok: true,
          value: { messages: [{ role: "user" }, { role: "assistant" }] },
        });
        expect(await client.events({ sessionId })).toMatchObject({ ok: true });
        expect(await client.list({})).toMatchObject({
          ok: true,
          value: { sessions: [expect.objectContaining({ sessionId })] },
        });
        await command(["daemon", "stop"]);
        started = false;
        await command(["daemon", "start"]);
        started = true;
        const restarted = new CliClient(() => ({ executable, args }));
        expect(await restarted.load({ sessionId })).toEqual(loaded);
        const followup: TurnEventV1[] = [];
        expect(
          await restarted.submit({ sessionId, message: "Follow up after restart" }, (event) =>
            followup.push(event),
          ),
        ).toMatchObject({ ok: true });
        await vi.waitFor(
          () =>
            expect(followup.at(-1)).toMatchObject({
              kind: "done",
              outcome: "complete",
            }),
          { timeout: 30_000 },
        );
        const continued = await restarted.load({ sessionId });
        if (!continued.ok) throw new Error("History not recovered");
        expect(continued.value.messages).toHaveLength(4);
        expect(continued.value.messages[2]?.body).toBe("Follow up after restart");
        expect(await client.close({ sessionId })).toMatchObject({
          ok: true,
          value: { status: "closed" },
        });
      } finally {
        if (started) await command(["daemon", "stop"]);
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("keeps new tasks local until a real message and rejects unavailable operations", async () => {
    const run = vi.fn();
    const client = new CliClient(() => ({ executable: "/managed/openminion", args: [] }), run);
    const created = await client.create({ title: "Draft" });
    expect(created).toMatchObject({
      ok: true,
      value: { isDraft: true, title: "Draft" },
    });
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    expect(await client.load({ sessionId })).toMatchObject({
      ok: true,
      value: { messages: [] },
    });
    expect(
      await client.submit(
        { sessionId, message: "message", attachmentIds: ["a".repeat(48)] },
        vi.fn(),
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
    expect(await client.create({ projectId: "project" })).toMatchObject({
      ok: false,
      error: { code: "unsupported_operation" },
    });
    expect(await client.close({ sessionId })).toMatchObject({
      ok: true,
      value: { status: "closed" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(await new CliClient(() => null, run).list({})).toMatchObject({
      ok: false,
      error: { code: "daemon_unavailable" },
    });
  });

  it("fences new submissions while settings are being applied", async () => {
    const run = vi.fn();
    const client = new CliClient(() => ({ executable: "/managed/openminion", args: [] }), run);
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    expect(client.beginConfiguration()).toBe(true);
    expect(client.beginConfiguration()).toBe(false);
    expect(
      await client.submit(
        { sessionId: created.value.sessionId, message: "Wait for settings" },
        vi.fn(),
      ),
    ).toMatchObject({ ok: false, error: { code: "settings_busy" } });
    expect(run).not.toHaveBeenCalled();
    client.endConfiguration();
    expect(client.beginConfiguration()).toBe(true);
    client.endConfiguration();
  });

  it.each(["stats", "metadata"])("loads %s usage and hides secrets", async (format) => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      let value: unknown;
      if (command.startsWith("sessions list"))
        value = [{ id: "saved", name: "", status: "active", agent: "writer" }];
      else if (command.startsWith("sessions show"))
        value = {
          ...session("saved"),
          turn_usage_display: "input_output_calls",
        };
      else {
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            {
              type: "message",
              id: "m1",
              role: "inbound",
              body: "Question",
              created_at: now,
              metadata: { token: "private" },
              stats: {},
            },
            {
              type: "message",
              id: "m2",
              role: "outbound",
              body: "writer: Answer",
              created_at: now,
              metadata: { display_name: "writer", token: "private" },
              stats: {
                input_tokens: 5700,
                output_tokens: 603,
                cache_read_tokens: 0,
                llm_calls: 4,
                tool_calls: 0,
                tool_errors: 0,
                duration_ms: 26000,
              },
            },
            {
              type: "event",
              id: "e1",
              event_type: "run.completed",
              created_at: now,
              payload: {
                trace_id: "trace",
                state: "completed",
                token: "private",
                agent_id: "writer",
              },
            },
            {
              type: "event",
              id: "e2",
              event_type: "approval.requested",
              created_at: now,
              payload: {
                trace_id: "trace",
                approval_id: "approval-1",
                tool_name: "exec.run",
                consent_preview: 'exec.run(command="npm test")',
                requested_at: now,
                expires_at: "2026-09-08T00:00:50Z",
                outcome: "pending",
              },
            },
            {
              type: "event",
              id: "e3",
              event_type: "approval.resolved",
              created_at: now,
              payload: {
                trace_id: "trace",
                approval_id: "approval-1",
                tool_name: "exec.run",
                consent_preview: 'exec.run(command="npm test")',
                decision: "allow_once",
                outcome: "applied",
                resolved_at: now,
              },
            },
          ]
            .map((row) => {
              if (format === "metadata" && row.stats) {
                const { stats, ...record } = row;
                return JSON.stringify({
                  ...record,
                  metadata: {
                    ...row.metadata,
                    run_stats_json: JSON.stringify(stats),
                  },
                });
              }
              return JSON.stringify(row);
            })
            .join("\n"),
        };
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    });
    const client = new CliClient(
      () => ({
        executable: "/managed/openminion",
        args: ["--config", "/config with spaces.json"],
      }),
      run,
    );
    expect(await client.list({})).toMatchObject({
      ok: true,
      value: {
        sessions: [{ sessionId: "saved", title: null, activeAgentId: "writer" }],
      },
    });
    expect(await client.load({ sessionId: "saved", messageLimit: 1 })).toMatchObject({
      ok: true,
      value: {
        session: { turnUsageDisplay: "input_output_calls" },
        messages: [{ body: "Question", usage: { usageAvailable: false } }],
        messagesHasMore: true,
        nextMessageCursor: "1",
      },
    });
    expect(
      await client.load({
        sessionId: "saved",
        messageAfter: "1",
        messageLimit: 1,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        messages: [
          {
            body: "writer: Answer",
            profileName: "writer",
            usage: { totalTokens: 6303, llmCalls: 4, durationMs: 26000 },
          },
        ],
        messagesHasMore: false,
      },
    });
    const events = await client.events({ sessionId: "saved", after: "0" });
    expect(events).toMatchObject({
      ok: true,
      value: {
        events: [
          {
            traceId: "trace",
            state: "completed",
            facts: { agent_id: "writer" },
          },
          {
            eventType: "approval.requested",
            facts: {
              approval_id: "approval-1",
              consent_preview: 'exec.run(command="npm test")',
              outcome: "pending",
            },
          },
          {
            eventType: "approval.resolved",
            facts: {
              approval_id: "approval-1",
              consent_preview: 'exec.run(command="npm test")',
              decision: "allow_once",
              outcome: "applied",
            },
          },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain("private");
    expect(await client.load({ sessionId: "saved", messageAfter: "bad" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(
      run.mock.calls.every(
        ([, args]) => args[0] === "--config" && args[1] === "/config with spaces.json",
      ),
    ).toBe(true);
  });

  it("restores transient session identity and draft text, then removes an unsent closed conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-cli-drafts-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "[]", stderr: "" });
    const context = () => ({ executable: "openminion", args: [] });
    let store = new DesktopStore(root);
    try {
      const client = new CliClient(context, run, store);
      const created = await client.create({ agentId: "writer", title: "Unsent idea" });
      if (!created.ok) throw new Error("Draft not created");
      const sessionId = created.value.sessionId;
      expect(store.saveDraft({ sessionId, text: "Keep my exact draft\nsecond line" }).ok).toBe(
        true,
      );
      store.close();
      store = new DesktopStore(root);
      const restarted = new CliClient(context, run, store);
      expect(await restarted.load({ sessionId })).toMatchObject({
        ok: true,
        value: { session: created.value, messages: [] },
      });
      expect(run).not.toHaveBeenCalled();
      expect(await restarted.list({})).toMatchObject({
        ok: true,
        value: { sessions: [created.value] },
      });
      expect(store.loadDrafts()).toEqual({
        ok: true,
        value: [{ sessionId, text: "Keep my exact draft\nsecond line" }],
      });
      const callsBeforeClose = run.mock.calls.length;
      expect(await restarted.close({ sessionId })).toMatchObject({
        ok: true,
        value: { sessionId, status: "closed" },
      });
      expect(run).toHaveBeenCalledTimes(callsBeforeClose);
      expect(store.draftSessions()).toEqual([]);
      expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
      expect(await new CliClient(context, run, store).list({})).toMatchObject({
        ok: true,
        value: { sessions: [] },
      });
    } finally {
      store.close();
    }
  });

  it("promotes a discovered runtime session without duplicating its identity or losing a newer draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-cli-promote-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new DesktopStore(root);
    const run = vi.fn();
    const context = () => ({ executable: "openminion", args: [] });
    try {
      const client = new CliClient(context, run, store);
      const created = await client.create({ agentId: "writer" });
      if (!created.ok) throw new Error("Draft not created");
      const sessionId = created.value.sessionId;
      expect(store.saveDraft({ sessionId, text: "Next unsent message" }).ok).toBe(true);
      run.mockResolvedValue({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify([
          { id: sessionId, name: "Runtime conversation", status: "idle", agent: "writer" },
        ]),
      });
      const listed = await client.list({});
      expect(listed).toMatchObject({
        ok: true,
        value: { sessions: [{ sessionId, title: "Runtime conversation" }] },
      });
      if (listed.ok) expect(listed.value.sessions).toHaveLength(1);
      expect(store.draftSessions()).toEqual([]);
      expect(store.loadDrafts()).toEqual({
        ok: true,
        value: [{ sessionId, text: "Next unsent message" }],
      });
      expect(await new CliClient(context, run, store).list({})).toEqual(listed);
    } finally {
      store.close();
    }
  });

  it("streams through the authenticated API and acknowledges displayed replies", async () => {
    const fixture = await executableFixture();
    const events: TurnEventV1[] = [];
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const submit = await client.submit(
      { sessionId, message: "literal $(touch nope) `secret`\nsecond line" },
      (event) => events.push(event),
    );
    expect(submit).toMatchObject({ ok: true, value: { sessionId } });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        outcome: "complete",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        progressKind: "text",
        text: "Reply",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "response", finalText: "Reply" }),
    );
    expect(
      events.filter((event) => event.kind === "progress" && event.progressKind === "status"),
    ).toMatchObject([
      { label: "Working on it...", detailText: null },
      { label: "Thinking...", detailText: null },
    ]);
    expect(JSON.stringify(events)).not.toContain("[act]");
    expect(JSON.stringify(events)).not.toContain("private diagnostic");
    const recorded = fixture.requests[0]!;
    expect(recorded.body.input_text).toBe("literal $(touch nope) `secret`\nsecond line");
    expect(recorded.body.approval_transport).toBe("turn_stream");
    expect(recorded.token).toBe("test-private-token");
    expect(recorded.body.inbound_metadata).toEqual({
      caller_handles_delivery: "true",
      resume: "true",
    });
    expect(await client.load({ sessionId })).toMatchObject({
      ok: true,
      value: { session: { sessionId }, messages: [{ body: "Reply" }] },
    });
  });

  it.each([
    ["allow_once", "applied", true],
    ["deny", "denied", false],
  ] as const)("streams tool and approval events for %s", async (decision, outcome, ok) => {
    const fixture = await executableFixture("approval");
    const events: TurnEventV1[] = [];
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const submitted = await client.submit(
      { sessionId: created.value.sessionId, message: "run tests" },
      (event) => events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "approval",
          phase: "requested",
          approvalId: "approval-1",
          consentPreview: 'exec.run(command="npm test")',
          outcome: "pending",
        }),
      ),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        phase: "started",
        toolName: "exec.run",
        callId: "call-1",
      }),
    );

    expect(
      await client.decide({
        sessionId: submitted.value.sessionId,
        traceId: submitted.value.traceId,
        approvalId: "approval-1",
        decision,
      }),
    ).toMatchObject({
      ok: true,
      value: { decision, outcome, approvalId: "approval-1" },
    });
    expect(fixture.requests[1]?.body).toEqual({
      session_id: submitted.value.sessionId,
      trace_id: submitted.value.traceId,
      approval_id: "approval-1",
      decision,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "approval",
          phase: "resolved",
          decision,
          outcome,
        }),
      ),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        phase: "completed",
        ok,
        exitCode: null,
      }),
    );
  });

  it.each([
    [{}, true],
    [{ content: "" }, true],
    [{ content: "  full tool output\nsecond line\n", truncated: false }, true],
    [{ content: "partial output", truncated: true }, true],
    [{ content: { unexpected: "payload" } }, false],
    [{ content: "output", truncated: "false" }, false],
  ] as const)("preserves only runtime-supplied tool content %j", async (toolOutput, valid) => {
    const fixture = await executableFixture("approval", toolOutput);
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const events: TurnEventV1[] = [];
    const submitted = await client.submit(
      { sessionId: created.value.sessionId, message: "run tests" },
      (event) => events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() => expect(events.some((event) => event.kind === "approval")).toBe(true));
    expect(events.find((event) => event.kind === "tool")).not.toHaveProperty("content");
    await client.decide({
      sessionId: submitted.value.sessionId,
      traceId: submitted.value.traceId,
      approvalId: "approval-1",
      decision: "allow_once",
    });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: valid ? "complete" : "error" }),
    );
    const completed = events.find((event) => event.kind === "tool" && event.phase === "completed");
    if (valid) {
      expect(completed).toMatchObject(toolOutput);
      expect(completed && "content" in completed).toBe("content" in toolOutput);
      expect(completed && "truncated" in completed).toBe("truncated" in toolOutput);
    } else {
      expect(completed).toBeUndefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "error",
          error: expect.objectContaining({ code: "daemon_stream_failed" }),
        }),
      );
    }
  });

  it("preserves typed retryable approval errors", async () => {
    const fixture = await executableFixture("approval-retryable");
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const submitted = await client.submit(
      { sessionId: created.value.sessionId, message: "run tests" },
      vi.fn(),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    expect(
      await client.decide({
        sessionId: submitted.value.sessionId,
        traceId: submitted.value.traceId,
        approvalId: "approval-1",
        decision: "allow_once",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "approval_temporarily_unavailable",
        message: "Try the approval again.",
        retryable: true,
        retryAfterMs: 250,
      },
    });
  });

  it("accepts expiry settlement without a human decision", async () => {
    const fixture = await executableFixture("approval-expired");
    const events: TurnEventV1[] = [];
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const submitted = await client.submit(
      { sessionId: created.value.sessionId, message: "run tests" },
      (event) => events.push(event),
    );
    expect(submitted.ok).toBe(true);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "approval",
          phase: "resolved",
          decision: null,
          outcome: "expired",
        }),
      ),
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: "done", outcome: "complete" }));
  });

  it("keeps ordinary chat compatible when approvals are not advertised", async () => {
    const fixture = await executableFixture("missing-approval-capability");
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    expect(
      await client.submit({ sessionId: created.value.sessionId, message: "hello" }, vi.fn()),
    ).toMatchObject({ ok: true });
    expect(fixture.requests[0]?.body.approval_transport).toBe("turn_stream");
  });

  it("preserves the saved agent and surfaces canonical stream errors", async () => {
    const fixture = await executableFixture("error");
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const events: TurnEventV1[] = [];
    expect(
      await client.submit({ sessionId: "saved", message: "Follow up" }, (event) =>
        events.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "error" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({
          code: "turn_failed",
          message: "Canonical failure",
        }),
      }),
    );
    expect(fixture.requests[0]?.body.agent_id).toBe("writer");
    expect(fixture.requests[0]?.body.user).toBe("cli-tools");
    expect(fixture.requests[0]?.body.channel).toBe("console");
    expect(fixture.requests[0]?.body.deliver).toBe(false);
  });

  it("rejects cross-session stream identity and never exposes child stderr", async () => {
    const fixture = await executableFixture("wrong-session");
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const emit = vi.fn();
    const result = await client.submit(
      { sessionId: created.value.sessionId, message: "hello" },
      emit,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "daemon_stream_failed" },
    });
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-stderr");
    expect(await client.load({ sessionId: created.value.sessionId })).toMatchObject({
      ok: true,
      value: { session: { isDraft: true } },
    });
    expect(await client.submit(null as never, emit)).toMatchObject({
      ok: false,
    });
  });

  it("reattaches a known trace without resending, deduplicates replay, and preserves cancellation scope", async () => {
    const fixture = await executableFixture("reconnect");
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    const identity = { sessionId: "saved", traceId: submitted.value.traceId };
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        kind: "connection",
        state: "disconnected",
        error: { retryable: true },
      }),
    );
    expect(events.some((event) => event.kind === "done" || event.kind === "error")).toBe(false);
    expect(
      await client.submit({ sessionId: "saved", message: "duplicate" }, vi.fn()),
    ).toMatchObject({ ok: false, error: { code: "session_turn_active" } });
    expect(await client.reconnect({ ...identity, traceId: "other" })).toMatchObject({
      ok: false,
      error: { code: "trace_not_found" },
    });
    expect(await client.reconnect({ ...identity, afterSequence: 900 } as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const reconnect = client.reconnect(identity);
    expect(await client.reconnect(identity)).toMatchObject({
      ok: false,
      error: { code: "stream_connected" },
    });
    expect(await reconnect).toMatchObject({ ok: true, value: identity });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
    );
    expect(events.filter((event) => event.kind === "started")).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === "connection").map((event) => event.state),
    ).toEqual(["disconnected", "reconnected"]);
    expect(
      events
        .filter((event) => event.kind === "progress" && event.progressKind === "text")
        .map((event) => event.text),
    ).toEqual(["Before ", "after"]);
    expect(fixture.requests.filter((request) => request.body.input_text)).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.path?.includes("/stream?"))).toMatchObject([
      { path: `/v1/turn/${identity.traceId}/stream?after_sequence=1`, token: "test-private-token" },
    ]);
    expect(await client.cancel(identity)).toMatchObject({
      ok: false,
      error: { code: "trace_not_found" },
    });
  });

  it("keeps cancellation available while disconnected without claiming completion", async () => {
    const fixture = await executableFixture("reconnect-missing");
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
    );
    const identity = { sessionId: "saved", traceId: submitted.value.traceId };
    expect(await client.cancel(identity)).toMatchObject({
      ok: true,
      value: { state: "requested", terminal: false },
    });
    expect(events.some((event) => event.kind === "done")).toBe(false);
    expect(await client.reconnect(identity)).toMatchObject({
      ok: false,
      error: { code: "trace_not_found" },
    });
    expect(events.at(-1)).toMatchObject({ kind: "connection", state: "unavailable" });
  });

  it("replays a pending approval and routes its decision through the original turn", async () => {
    const fixture = await executableFixture("reconnect-approval");
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
    );
    const identity = { sessionId: "saved", traceId: submitted.value.traceId };
    expect(await client.reconnect(identity)).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "approval", phase: "requested" }),
    );
    expect(
      await client.decide({ ...identity, approvalId: "approval-1", decision: "allow_once" }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
    );
    expect(events.filter((event) => event.kind === "approval").map((event) => event.phase)).toEqual(
      ["requested", "resolved"],
    );
    expect(fixture.requests.filter((request) => request.body.input_text)).toHaveLength(1);
  });

  it.each([
    ["reconnect-missing", "trace_not_found", "unavailable"],
    ["reconnect-attach-missing", "trace_not_found", "unavailable"],
    ["reconnect-gap", "stream_replay_gap", "disconnected"],
    ["reconnect-gap-race", "stream_replay_gap", "disconnected"],
    ["reconnect-wrong-session", "stream_identity_mismatch", "disconnected"],
  ])("keeps unknown outcomes truthful for %s", async (mode, code, state) => {
    const fixture = await executableFixture(mode);
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
    );
    expect(
      await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId }),
    ).toMatchObject({ ok: false, error: { code } });
    expect(events.at(-1)).toMatchObject({ kind: "connection", state, error: { code } });
    expect(events.some((event) => event.kind === "done" || event.kind === "error")).toBe(false);
    expect(fixture.requests.filter((request) => request.body.input_text)).toHaveLength(1);
    if (state === "unavailable")
      expect(await client.load({ sessionId: "saved" })).toMatchObject({
        ok: true,
        value: { messages: [expect.objectContaining({ body: "Reply" })] },
      });
  });

  it("retains an accepted response when reconnecting only the terminal tail", async () => {
    const fixture = await executableFixture("reconnect-response-tail");
    const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
    );
    expect(events.filter((event) => event.kind === "response")).toHaveLength(1);
    expect(
      await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
    );
    expect(events.filter((event) => event.kind === "response")).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.body.input_text)).toHaveLength(1);
  });

  it.each(["reconnect-cursor-missing", "reconnect-cursor-wrong"])(
    "rejects corrupt replay cursors for %s",
    async (mode) => {
      const fixture = await executableFixture(mode);
      const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
      const events: TurnEventV1[] = [];
      const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
        events.push(event),
      );
      if (!submitted.ok) throw new Error("Turn not accepted");
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
      );
      await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId });
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          kind: "connection",
          state: "disconnected",
          error: { code: "invalid_daemon_response", retryable: false },
        }),
      );
      expect(
        events
          .filter((event) => event.kind === "progress" && event.progressKind === "text")
          .map((event) => event.text),
      ).toEqual(["Before "]);
      expect(events.some((event) => event.kind === "done")).toBe(false);
    },
  );

  it.each(["reconnect-no-cursor", "reconnect-no-capability"])(
    "does not guess replay support for %s",
    async (mode) => {
      const fixture = await executableFixture(mode);
      const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
      const events: TurnEventV1[] = [];
      const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
        events.push(event),
      );
      if (!submitted.ok) throw new Error("Turn not accepted");
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          kind: "connection",
          state: "disconnected",
          error: { retryable: false },
        }),
      );
      expect(
        await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId }),
      ).toMatchObject({ ok: false, error: { code: "stream_replay_unavailable" } });
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests.at(-1)?.path).toBe(`/v1/turn/${submitted.value.traceId}/status`);
    },
  );

  it.each(["reconnect-no-cursor", "reconnect-no-capability", "reconnect-gap"])(
    "can explicitly check status after replay is unavailable for %s",
    async (mode) => {
      const fixture = await executableFixture(mode);
      const client = new CliClient(() => ({ executable: fixture.executable, args: fixture.args }));
      const events: TurnEventV1[] = [];
      const submitted = await client.submit({ sessionId: "saved", message: "once" }, (event) =>
        events.push(event),
      );
      if (!submitted.ok) throw new Error("Turn not accepted");
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" }),
      );
      expect(
        await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId }),
      ).toMatchObject({ ok: false });
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "disconnected" });
      fixture.expireTrace();
      expect(
        await client.reconnect({ sessionId: "saved", traceId: submitted.value.traceId }),
      ).toMatchObject({
        ok: false,
        error: { code: "trace_not_found" },
      });
      expect(events.at(-1)).toMatchObject({ kind: "connection", state: "unavailable" });
      expect(events.some((event) => event.kind === "done" || event.kind === "error")).toBe(false);
      expect(client.beginConfiguration()).toBe(true);
      client.endConfiguration();
      expect(await client.load({ sessionId: "saved" })).toMatchObject({
        ok: true,
        value: { messages: [expect.objectContaining({ body: "Reply" })] },
      });
      expect(fixture.requests.filter((request) => request.body.input_text)).toHaveLength(1);
      expect(fixture.requests.filter((request) => request.path?.includes("/stream?"))).toHaveLength(
        0,
      );
    },
  );

  it("cancels through the ordinary authenticated daemon endpoint and fences duplicate sends", async () => {
    const fixture = await executableFixture("wait");
    const client = new CliClient(() => ({
      executable: fixture.executable,
      args: fixture.args,
    }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const events: TurnEventV1[] = [];
    const submitted = await client.submit({ sessionId, message: "wait" }, (event) =>
      events.push(event),
    );
    if (!submitted.ok) throw new Error("Turn not accepted");
    expect(await client.submit({ sessionId, message: "duplicate" }, vi.fn())).toMatchObject({
      ok: false,
      error: { code: "session_turn_active" },
    });
    expect(await client.cancel({ sessionId, traceId: "wrong" })).toMatchObject({
      ok: false,
      error: { code: "trace_not_found" },
    });
    expect(await client.cancel({ sessionId, traceId: submitted.value.traceId })).toMatchObject({
      ok: true,
      value: { state: "requested", terminal: false },
    });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        outcome: "cancelled",
      }),
    );
  });
});

const now = "2026-09-08T00:00:00Z";
function session(id: string) {
  return {
    id,
    status: "active",
    agent: "writer",
    metadata: {},
    created_at: now,
    updated_at: now,
  };
}

async function executableFixture(
  mode = "normal",
  toolOutput: Record<string, unknown> = {},
  skillResponses: { list?: unknown; detail?: unknown } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "desktop-cli-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{
    body: Record<string, unknown>;
    token: string | string[] | undefined;
    path?: string;
  }> = [];
  let complete: ((cancelled: boolean) => void) | null = null;
  let emitSse: ((event: string, value: unknown) => void) | null = null;
  let activeSessionId = "";
  let traceId = "";
  let traceExpired = false;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      requests.push({
        body: {},
        token: req.headers["x-ipc-token"],
        path: req.url,
      });
      res.setHeader("Content-Type", "application/json");
      if (
        req.url === `/v1/turn/${traceId}/status` ||
        req.url?.startsWith(`/v1/turn/${traceId}/stream?`)
      ) {
        const attaching = req.url.includes("/stream?");
        if (
          traceExpired ||
          mode === "reconnect-missing" ||
          (attaching && mode === "reconnect-attach-missing")
        ) {
          res.statusCode = 404;
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "trace_not_found",
                message: "Active trace not found",
                retryable: false,
              },
            }),
          );
        } else if (!attaching) {
          res.end(
            JSON.stringify({
              ok: true,
              trace_id: traceId,
              session_id: mode === "reconnect-wrong-session" ? "other" : activeSessionId,
              agent_id: "writer",
              status: null,
              stream: {
                schema_version: "openminion.turn-stream.v1",
                replay_floor_sequence: mode === "reconnect-gap" ? 4 : 1,
              },
            }),
          );
        } else {
          res.setHeader("Content-Type", "text/event-stream");
          const output = (event: string, data: Record<string, unknown>) =>
            res.write(
              `${data.event_id ? `id: ${data.event_id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            );
          output("meta", {
            session_id: activeSessionId,
            trace_id: traceId,
            request_id: "attach-1",
            stream_schema_version: "openminion.turn-stream.v1",
            capabilities: ["active_turn_replay"],
            replay_floor_sequence: mode === "reconnect-gap-race" ? 4 : 1,
          });
          if (mode === "reconnect-response-tail") {
            output("done", { trace_id: traceId, status: "complete" });
            res.end();
            return;
          }
          for (const [sequence, text] of [
            [1, "Before "],
            [2, "after"],
          ] as const)
            output("chunk", {
              trace_id: traceId,
              ...(mode === "reconnect-cursor-missing" && sequence === 2
                ? {}
                : {
                    sequence,
                    event_id:
                      mode === "reconnect-cursor-wrong" && sequence === 2
                        ? "other:2"
                        : `${traceId}:${sequence}`,
                  }),
              kind: "final_text",
              data: { text },
              ts: now,
            });
          complete = () => {
            output("response", { trace_id: traceId, final_text: "Before after", errors: [] });
            output("done", { trace_id: traceId, status: "complete" });
            res.end();
          };
          if (mode === "reconnect-approval") {
            emitSse = (event, value) => output(event, value as Record<string, unknown>);
            output("chunk", {
              trace_id: traceId,
              sequence: 3,
              event_id: `${traceId}:3`,
              kind: "approval",
              data: {
                phase: "requested",
                session_id: activeSessionId,
                trace_id: traceId,
                approval_id: "approval-1",
                tool_name: "exec.run",
                consent_preview: "Run a command",
                outcome: "pending",
                requested_at: now,
                expires_at: "2027-01-01T00:00:00Z",
              },
            });
          } else complete(false);
        }
        return;
      }
      if (req.url?.startsWith("/v1/tools/exposure")) {
        res.end(
          JSON.stringify({
            ok: true,
            exposure: {
              profiles: [
                {
                  profile_id: "web",
                  tier: "standard",
                  active: true,
                  dependency_readiness: "degraded",
                  private: "not exposed",
                  dependency_statuses: [
                    {
                      dependency_id: "browser",
                      state: "missing",
                      setup_hints: [{ label: "Install browser" }],
                    },
                  ],
                },
              ],
              unprofiled_dependency_tools: [
                {
                  tool_name: "exec",
                  dependency_readiness: "ready",
                  dependency_statuses: [{ dependency_id: "shell" }],
                },
              ],
              ...(req.url.includes("?") ? { security_lab: { state: "not_configured" } } : {}),
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify(
          req.url === "/v1/agents"
            ? {
                ok: true,
                agents: [
                  {
                    agent_id: "writer",
                    display_name: "Writer",
                    secret: "private",
                  },
                ],
              }
            : req.url === "/v1/runtime/capabilities?agent_id=writer"
              ? {
                  ok: true,
                  capabilities: {
                    tools: {
                      mcp_exposure: {
                        configured_servers: ["local"],
                        exposed_servers: ["local"],
                        exposed_runtime_tool_count: 2,
                        registered_runtime_tool_count: 3,
                      },
                    },
                    mcp: { failed_servers: {} },
                  },
                }
              : req.url === "/v1/skills" || req.url?.startsWith("/v1/skills?")
                ? (skillResponses.list ?? {
                    ok: true,
                    skills: [{ skill_id: "example", private: "private" }],
                  })
                : req.url === "/v1/skills/example"
                  ? (skillResponses.detail ?? {
                      ok: true,
                      skill: {
                        skill_id: "example",
                        name: "Example",
                        status: "active",
                        scope: "agent",
                        risk_class: "low",
                        version_hash: "abc123",
                        tools: [],
                        tags: [],
                        sections: { instructions: "Use the approved tool." },
                        private: "private",
                      },
                    })
                  : req.url === "/v1/skills/suggestions/status"
                    ? {
                        ok: true,
                        status: {
                          pending_count: 1,
                          surfaced_count: 1,
                          accepted_count: 0,
                          rejected_count: 0,
                          deferred_count: 0,
                          auto_dismissed_count: 0,
                        },
                      }
                    : req.url === "/v1/skills/suggestions/inbox"
                      ? {
                          ok: true,
                          suggestions: [
                            {
                              proposal_id: "proposal-1",
                              display_name: "Inventory Workflow",
                            },
                          ],
                        }
                      : req.url === "/v1/skills/proposals/proposal-1"
                        ? {
                            ok: true,
                            proposal: {
                              proposal_id: "proposal-1",
                              queue_state: "pending",
                              source_task_shape_ref: "shape-1",
                              proposal: {
                                proposed_skill_definition: {
                                  display_name: "Inventory Workflow",
                                  risk_class: "low",
                                },
                              },
                            },
                          }
                        : {
                            ok: true,
                            tools: [
                              {
                                name: "search",
                                enabled: true,
                                private: "private",
                              },
                              { name: "disabled", enabled: false },
                            ],
                          },
        ),
      );
      return;
    }
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(data);
      requests.push({ body, token: req.headers["x-ipc-token"] });
      if (req.url?.endsWith("/cancel")) {
        expect(req.url).toBe(`/v1/turn/${traceId}/cancel`);
        expect(req.headers["x-ipc-token"]).toBe("test-private-token");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, cancelled: true, trace_id: traceId }));
        complete?.(true);
        return;
      }
      if (req.url === "/v1/approvals/resume") {
        expect(req.headers["x-ipc-token"]).toBe("test-private-token");
        res.setHeader("Content-Type", "application/json");
        if (mode === "approval-retryable") {
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "approval_temporarily_unavailable",
                message: "Try the approval again.",
                retryable: true,
                retry_after_ms: 250,
              },
            }),
          );
          return;
        }
        const outcome = body.decision === "allow_once" ? "applied" : "denied";
        emitSse?.("chunk", {
          trace_id: traceId,
          ...(mode === "reconnect-approval" ? { sequence: 4, event_id: `${traceId}:4` } : {}),
          kind: "approval",
          data: {
            phase: "resolved",
            session_id: activeSessionId,
            trace_id: traceId,
            approval_id: "approval-1",
            tool_name: "exec.run",
            consent_preview: 'exec.run(command="npm test")',
            requested_at: null,
            expires_at: null,
            decision: body.decision,
            outcome,
            resolved_at: now,
          },
          ts: now,
        });
        emitSse?.("chunk", {
          trace_id: traceId,
          ...(mode === "reconnect-approval" ? { sequence: 5, event_id: `${traceId}:5` } : {}),
          kind: "tool_completed",
          data: {
            tool_name: "exec.run",
            call_id: "call-1",
            state: outcome === "applied" ? "ok" : "denied",
            ok: outcome === "applied",
            duration_ms: 12,
            ...toolOutput,
          },
          ts: now,
        });
        res.end(
          JSON.stringify({
            ok: true,
            session_id: activeSessionId,
            trace_id: traceId,
            approval_id: "approval-1",
            decision: body.decision,
            outcome,
            resolved_at: now,
          }),
        );
        complete?.(false);
        return;
      }
      if (req.url === "/v1/tools/exposure/activate") {
        requests.push({ path: req.url, body, token: req.headers["x-ipc-token"] });
        res.end(
          JSON.stringify({
            ok: true,
            activation: { profile_id: "web", audit_id: "audit-1", private: "not exposed" },
          }),
        );
        return;
      }
      if (req.url === "/v1/tools/exposure/deactivate") {
        requests.push({ path: req.url, body, token: req.headers["x-ipc-token"] });
        res.end(JSON.stringify({ ok: true, deactivated: true }));
        return;
      }
      expect(req.url).toBe("/v1/turn/stream");
      traceId = body.trace_id;
      activeSessionId = body.session_id;
      res.setHeader("Content-Type", "text/event-stream");
      const output = (event: string, value: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      emitSse = output;
      output("meta", {
        session_id: mode === "wrong-session" ? "different" : body.session_id,
        trace_id: traceId,
        request_id: "request-1",
        stream_schema_version: "openminion.turn-stream.v1",
        capabilities:
          mode === "missing-approval-capability"
            ? ["active_turn_replay"]
            : mode === "reconnect-no-capability"
              ? []
              : ["active_turn_replay", "approval_interaction_v1"],
      });
      if (mode.startsWith("reconnect")) {
        const cursor =
          mode === "reconnect-no-cursor" ? {} : { sequence: 1, event_id: `${traceId}:1` };
        if (mode !== "reconnect-no-cursor") res.write(`id: ${traceId}:1\n`);
        output("chunk", {
          trace_id: traceId,
          ...cursor,
          kind: "final_text",
          data: { text: "Before " },
          ts: now,
        });
        if (mode === "reconnect-response-tail")
          output("response", { trace_id: traceId, final_text: "Before ", errors: [] });
        res.end();
        return;
      }
      for (const data of [
        {
          status_key: "executing",
          label: "Executing step...",
          detail_text: "[act] budget finalization status retry",
        },
        {
          status_key: "planning",
          visibility: "internal",
          detail_text: "private diagnostic",
        },
        {
          status_key: "analyzing",
          detail_code: "thinking",
          detail_text: "[act] started",
        },
      ])
        output("chunk", { trace_id: traceId, kind: "status", data, ts: now });
      complete = (cancelled) => {
        output("chunk", {
          trace_id: traceId,
          kind: "final_text",
          data: { text: "Reply" },
          ts: now,
        });
        output("response", {
          trace_id: traceId,
          final_text: "Reply",
          errors: cancelled
            ? [
                {
                  code: "cancelled",
                  message: "Cancelled",
                  retryable: false,
                  retry_after_ms: null,
                },
              ]
            : [],
          stats: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            llm_calls: 1,
            tool_calls: 0,
            tool_errors: 0,
            duration_ms: 1,
          },
        });
        output("done", { trace_id: traceId, status: "complete" });
        res.end();
      };
      if (mode === "approval" || mode === "approval-retryable" || mode === "approval-expired") {
        output("chunk", {
          trace_id: traceId,
          kind: "tool_started",
          data: {
            tool_name: "exec.run",
            call_id: "call-1",
            state: "running",
          },
          ts: now,
        });
        output("chunk", {
          trace_id: traceId,
          kind: "approval",
          data: {
            phase: "requested",
            session_id: body.session_id,
            trace_id: traceId,
            approval_id: "approval-1",
            tool_name: "exec.run",
            consent_preview: 'exec.run(command="npm test")',
            requested_at: now,
            expires_at: "2026-09-08T00:00:50Z",
            decision: null,
            outcome: "pending",
            resolved_at: null,
          },
          ts: now,
        });
        if (mode === "approval-expired") {
          output("chunk", {
            trace_id: traceId,
            kind: "approval",
            data: {
              phase: "resolved",
              session_id: body.session_id,
              trace_id: traceId,
              approval_id: "approval-1",
              tool_name: "exec.run",
              consent_preview: 'exec.run(command="npm test")',
              decision: null,
              outcome: "expired",
              resolved_at: now,
            },
            ts: now,
          });
          complete(false);
        }
      }
      if (mode === "error") {
        output("error", {
          code: "turn_failed",
          message: "Canonical failure",
          retryable: false,
          retry_after_ms: null,
        });
        output("done", { trace_id: traceId, status: "error" });
        res.end();
      } else if (
        mode !== "wait" &&
        mode !== "approval" &&
        mode !== "approval-retryable" &&
        mode !== "approval-expired"
      )
        complete(false);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const executable = join(root, "openminion.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
const now = ${JSON.stringify(now)};
const output = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stderr.write('private-stderr');
if (args[0] === 'config') output({default_agent:'writer',runtime:{ipc_token:'test-private-token'}});
else if (args[0] === 'daemon') output({reachable:true,host:'127.0.0.1',port:${address.port}});
else if (args[0] === 'sessions') output({id:args[2],status:'active',channel:'console',target:'cli-tools',agent:'writer',metadata:{},created_at:now,updated_at:now});
else if (args[0] === 'export') output({type:'message',id:'reply',role:'outbound',body:'Reply',created_at:now});
else process.exit(1);
`,
  );
  return {
    root,
    executable: process.execPath,
    args: [executable],
    requests,
    expireTrace: () => {
      traceExpired = true;
    },
  };
}
