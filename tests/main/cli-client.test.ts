import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliClient } from "../../src/main/cli-client.js";
import { runCommand } from "../../src/main/installation.js";
import type { TurnEventV1 } from "../../src/shared/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("PyPI CLI client", () => {
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
          () => expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
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
          () => expect(followup.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
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
    expect(created).toMatchObject({ ok: true, value: { isDraft: true, title: "Draft" } });
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    expect(await client.load({ sessionId })).toMatchObject({ ok: true, value: { messages: [] } });
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

  it("maps canonical session history and events without exposing metadata secrets", async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      let value: unknown;
      if (command.startsWith("sessions list"))
        value = [{ id: "saved", name: "", status: "active", agent: "writer" }];
      else if (command.startsWith("sessions show")) value = session("saved");
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
            },
            {
              type: "message",
              id: "m2",
              role: "outbound",
              body: "Answer",
              created_at: now,
              metadata: {},
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
          ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
        };
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    });
    const client = new CliClient(
      () => ({ executable: "/managed/openminion", args: ["--config", "/config with spaces.json"] }),
      run,
    );
    expect(await client.list({})).toMatchObject({
      ok: true,
      value: { sessions: [{ sessionId: "saved", title: null, activeAgentId: "writer" }] },
    });
    expect(await client.load({ sessionId: "saved", messageLimit: 1 })).toMatchObject({
      ok: true,
      value: { messages: [{ body: "Question" }], messagesHasMore: true, nextMessageCursor: "1" },
    });
    expect(
      await client.load({ sessionId: "saved", messageAfter: "1", messageLimit: 1 }),
    ).toMatchObject({
      ok: true,
      value: { messages: [{ body: "Answer" }], messagesHasMore: false },
    });
    const events = await client.events({ sessionId: "saved", after: "0" });
    expect(events).toMatchObject({
      ok: true,
      value: { events: [{ traceId: "trace", state: "completed", facts: { agent_id: "writer" } }] },
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

  it("streams through the authenticated API and acknowledges displayed replies", async () => {
    const fixture = await executableFixture();
    const events: TurnEventV1[] = [];
    const client = new CliClient(() => ({ executable: fixture.executable, args: [] }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const sessionId = created.value.sessionId;
    const submit = await client.submit(
      { sessionId, message: "literal $(touch nope) `secret`\nsecond line" },
      (event) => events.push(event),
    );
    expect(submit).toMatchObject({ ok: true, value: { sessionId } });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "complete" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "progress", progressKind: "text", text: "Reply" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "response", finalText: "Reply" }),
    );
    const recorded = fixture.requests[0]!;
    expect(recorded.body.input_text).toBe("literal $(touch nope) `secret`\nsecond line");
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

  it("preserves the saved agent and surfaces canonical stream errors", async () => {
    const fixture = await executableFixture("error");
    const client = new CliClient(() => ({ executable: fixture.executable, args: [] }));
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
        error: expect.objectContaining({ code: "turn_failed", message: "Canonical failure" }),
      }),
    );
    expect(fixture.requests[0]?.body.agent_id).toBe("writer");
  });

  it("rejects cross-session stream identity and never exposes child stderr", async () => {
    const fixture = await executableFixture("wrong-session");
    const client = new CliClient(() => ({ executable: fixture.executable, args: [] }));
    const created = await client.create({});
    if (!created.ok) throw new Error("Draft not created");
    const emit = vi.fn();
    const result = await client.submit(
      { sessionId: created.value.sessionId, message: "hello" },
      emit,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "daemon_stream_failed" } });
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-stderr");
    expect(await client.load({ sessionId: created.value.sessionId })).toMatchObject({
      ok: true,
      value: { session: { isDraft: true } },
    });
    expect(await client.submit(null as never, emit)).toMatchObject({ ok: false });
  });

  it("cancels through the ordinary authenticated daemon endpoint and fences duplicate sends", async () => {
    const fixture = await executableFixture("wait");
    const client = new CliClient(() => ({ executable: fixture.executable, args: [] }));
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
      expect(events.at(-1)).toMatchObject({ kind: "done", outcome: "cancelled" }),
    );
  });
});

const now = "2026-09-08T00:00:00Z";
function session(id: string) {
  return { id, status: "active", agent: "writer", metadata: {}, created_at: now, updated_at: now };
}

async function executableFixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "desktop-cli-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ body: Record<string, unknown>; token: string | string[] | undefined }> =
    [];
  let complete: ((cancelled: boolean) => void) | null = null;
  let traceId = "";
  const server = createServer((req, res) => {
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
      expect(req.url).toBe("/v1/turn/stream");
      traceId = body.trace_id;
      res.setHeader("Content-Type", "text/event-stream");
      const output = (event: string, value: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      output("meta", {
        session_id: mode === "wrong-session" ? "different" : body.session_id,
        trace_id: traceId,
        request_id: "request-1",
        stream_schema_version: "openminion.turn-stream.v1",
      });
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
            ? [{ code: "cancelled", message: "Cancelled", retryable: false, retry_after_ms: null }]
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
      if (mode === "error") {
        output("error", {
          code: "turn_failed",
          message: "Canonical failure",
          retryable: false,
          retry_after_ms: null,
        });
        output("done", { trace_id: traceId, status: "error" });
        res.end();
      } else if (mode !== "wait") complete(false);
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
else if (args[0] === 'sessions') output({id:args[2],status:'active',agent:'writer',metadata:{},created_at:now,updated_at:now});
else if (args[0] === 'export') output({type:'message',id:'reply',role:'outbound',body:'Reply',created_at:now});
else process.exit(1);
`,
  );
  await chmod(executable, 0o755);
  return { root, executable, requests };
}
