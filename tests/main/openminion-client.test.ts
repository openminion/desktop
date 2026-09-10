import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMinionClient } from "../../src/main/openminion-client.js";
import type { DesktopClientReady, TurnEventV1 } from "../../src/shared/contracts.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    await cleanup.pop()?.();
  }
});

describe("OpenMinionClient", () => {
  it("validates a turn before main performs file-grant side effects", () => {
    const readiness = vi.fn();
    const client = new OpenMinionClient(readiness);

    expect(
      client.validateTurnSubmission({
        sessionId: " session-1 ",
        message: "hello",
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        input: { sessionId: "session-1", message: "hello" },
      },
    });
    expect(
      client.validateTurnSubmission({
        sessionId: "session-1",
        message: "hello",
        observation: { includeCurrentView: true },
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        input: {
          sessionId: "session-1",
          message: "hello",
          observation: { includeCurrentView: true },
        },
      },
    });
    for (const observation of [
      { includeCurrentView: false },
      { includeCurrentView: true, frameId: "must-not-cross" },
      true,
    ]) {
      expect(
        client.validateTurnSubmission({
          sessionId: "session-1",
          message: "hello",
          observation,
        } as never),
      ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(client.validateTurnSubmission(null as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false, retryAfterMs: null },
    });
    expect(
      client.validateTurnSubmission({
        sessionId: "session-1",
        message: "hello",
        extra: true,
      } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(client.validateSessionClose({ sessionId: " session-1 " })).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      client.validateSessionClose({
        sessionId: "session-1",
        extra: true,
      } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(readiness).not.toHaveBeenCalled();
  });

  it("streams media through fixed routes and submits only ordered opaque IDs", async () => {
    const mediaId = "a".repeat(48);
    const bytes = Buffer.from("PNG!");
    let submittedAttachments: unknown;
    const readiness = await daemon(async (request, response) => {
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/client/sessions/session-1/media") {
        expect(request.headers["content-type"]).toBe("image/png");
        expect(request.headers["content-length"]).toBe(String(bytes.length));
        expect(request.headers["x-openminion-media-name"]).toBe("pixel.png");
        expect(Buffer.from(await readBody(request))).toEqual(bytes);
        response.statusCode = 201;
        json(response, {
          ok: true,
          media: {
            schema_version: 1,
            media_id: mediaId,
            session_id: "session-1",
            name: "pixel.png",
            mime_type: "image/png",
            size_bytes: bytes.length,
            kind: "image",
            turn_compatible: true,
            expires_at: "2999-01-01T00:00:00Z",
          },
          meta: meta(),
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/stream") {
        const body = JSON.parse(await readBody(request));
        submittedAttachments = body.attachments;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: body.trace_id,
          session_id: body.session_id,
        });
        writeEvent(response, "response", {
          trace_id: body.trace_id,
          final_text: "done",
          errors: [],
          stats: {},
        });
        writeEvent(response, "done", { status: "complete" });
        response.end();
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === `/v1/client/sessions/session-1/media/${mediaId}`
      ) {
        json(response, { ok: true, released: true, media_id: mediaId, meta: meta() });
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.create({})).toMatchObject({ ok: true });
    expect(
      await client.uploadMedia({
        sessionId: "session-1",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        stream: Readable.from(bytes),
      }),
    ).toMatchObject({ ok: true, value: { mediaId, name: "pixel.png" } });
    const events: TurnEventV1[] = [];
    expect(
      await client.submit(
        { sessionId: "session-1", message: "see", attachmentIds: [mediaId] },
        (event) => events.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: "done" }));
    expect(submittedAttachments).toEqual([mediaId]);
    expect(events.find((event) => event.kind === "response")).toMatchObject({
      usage: {
        usageAvailable: false,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        llmCalls: null,
        durationMs: null,
        costUsd: null,
        costSource: "unavailable",
      },
    });
    expect(await client.releaseMedia({ sessionId: "session-1", mediaId })).toEqual({
      ok: true,
      value: { mediaId, released: true },
    });
    expect(
      await client.submit(
        { sessionId: "session-1", message: "bad", attachmentIds: [mediaId, mediaId] },
        vi.fn(),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("does not retry when the submitted turn has an ambiguous transport result", async () => {
    let submitted = 0;
    const readiness = await daemon(async (request, response) => {
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/stream") {
        submitted += 1;
        await readBody(request);
        request.socket.destroy();
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.create({})).toMatchObject({ ok: true });

    expect(await client.submit({ sessionId: "session-1", message: "once" }, vi.fn())).toEqual({
      ok: false,
      error: {
        code: "submission_ambiguous",
        message: "Check session history before retrying",
        retryable: false,
        retryAfterMs: null,
      },
    });
    expect(submitted).toBe(1);
  });

  it("normalizes a malformed first SSE frame after HTTP acceptance", async () => {
    const readiness = await daemon(async (request, response) => {
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/stream") {
        await readBody(request);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end("event: meta\ndata: {\n\n");
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.create({})).toMatchObject({ ok: true });

    expect(await client.submit({ sessionId: "session-1", message: "once" }, vi.fn())).toMatchObject(
      {
        ok: false,
        error: {
          code: "submission_ambiguous",
          message: "Check session history before retrying",
          retryable: false,
        },
      },
    );
  });

  it("uses only fixed authenticated routes and projects exact session DTOs", async () => {
    const requests: Array<{
      method: string;
      url: string;
      token: string;
      body: string;
    }> = [];
    const readiness = await daemon(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        token: String(request.headers["x-openminion-client-token"] ?? ""),
        body,
      });
      if (request.method === "GET" && request.url === "/v1/client/sessions?limit=1") {
        json(response, {
          ok: true,
          sessions: [session()],
          next_cursor: null,
          has_more: false,
          meta: meta(),
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (
        request.method === "GET" &&
        (request.url === "/v1/client/sessions/session-1?message_limit=20" ||
          request.url === "/v1/client/sessions/session-1?message_limit=1")
      ) {
        json(response, {
          ok: true,
          session: session(),
          messages: [message()],
          next_message_cursor: "message-cursor",
          messages_has_more: false,
          meta: meta(),
        });
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/v1/client/sessions/session-1/events?after=event-zero"
      ) {
        json(response, {
          ok: true,
          events: [eventValue()],
          next_cursor: "event-one",
          has_more: false,
          meta: meta(),
        });
        return;
      }
      if (request.method === "DELETE" && request.url === "/v1/client/sessions/session-1") {
        json(response, { ok: true, session: session("closed"), meta: meta() });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/trace-1/cancel") {
        response.statusCode = 202;
        json(response, {
          ok: true,
          cancellation: {
            session_id: "session-1",
            trace_id: "trace-1",
            run_id: "run-1",
            state: "requested",
            terminal: false,
          },
          meta: meta(),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/client/sessions/session-1/turns/trace-1/approvals/approval-1"
      ) {
        json(response, {
          ok: true,
          approval: {
            schema_version: 1,
            approval_id: "approval-1",
            session_id: "session-1",
            trace_id: "trace-1",
            call_id: "call-1",
            decision: "allow_once",
            outcome: "applied",
            resolved_at: "2026-08-19T00:00:04Z",
          },
          meta: meta(),
        });
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);

    expect(await client.list({ limit: 1 })).toEqual({
      ok: true,
      value: { sessions: [camelSession()], nextCursor: null, hasMore: false },
    });
    expect(await client.create({ title: " Chat ", projectId: "project-1" })).toEqual({
      ok: true,
      value: camelSession(),
    });
    expect(await client.load({ sessionId: "session-1", messageLimit: 20 })).toEqual({
      ok: true,
      value: {
        session: camelSession(),
        messages: [camelMessage()],
        nextMessageCursor: "message-cursor",
        messagesHasMore: false,
      },
    });
    expect(await client.validateWritableSession("session-1")).toEqual({
      ok: true,
      value: { sessionId: "session-1", writable: true },
    });
    expect(await client.events({ sessionId: "session-1", after: "event-zero" })).toEqual({
      ok: true,
      value: {
        events: [camelEvent()],
        nextCursor: "event-one",
        hasMore: false,
      },
    });
    expect(await client.close({ sessionId: "session-1", reason: "done" })).toEqual({
      ok: true,
      value: camelSession("closed"),
    });
    expect(await client.validateWritableSession("session-1")).toMatchObject({
      ok: false,
      error: { code: "session_closed" },
    });
    expect(await client.cancel({ sessionId: "session-1", traceId: "trace-1" })).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        traceId: "trace-1",
        runId: "run-1",
        state: "requested",
        terminal: false,
      },
    });
    expect(
      await client.decide({
        sessionId: "session-1",
        traceId: "trace-1",
        approvalId: "approval-1",
        decision: "allow_once",
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        approvalId: "approval-1",
        sessionId: "session-1",
        traceId: "trace-1",
        callId: "call-1",
        decision: "allow_once",
        outcome: "applied",
        resolvedAt: "2026-08-19T00:00:04Z",
      },
    });
    expect(
      await client.submit({ sessionId: "session-1", message: "blocked" }, vi.fn()),
    ).toMatchObject({ ok: false, error: { code: "session_closed" } });

    const beforeInvalid = requests.length;
    expect(await client.list({ limit: 1, route: "/private" } as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(requests).toHaveLength(beforeInvalid);
    expect(requests.every((request) => request.token === readiness.client_token)).toBe(true);
    expect(requests[1].body).toBe(JSON.stringify({ title: "Chat", project_id: "project-1" }));
    const rendered = JSON.stringify([
      await client.list({ limit: 1 }),
      await client.load({ sessionId: "session-1", messageLimit: 20 }),
    ]);
    expect(rendered).not.toContain(readiness.client_token);
    expect(rendered).not.toContain("127.0.0.1");
    expect(rendered).not.toContain("/v1/");
    expect(rendered).not.toContain("secret");
  });

  it("maps bounded SSE events and rejects a same-session double submit", async () => {
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let turnBody: Record<string, unknown> | null = null;
    const readiness = await daemon(async (request, response) => {
      if (request.url === "/v1/client/sessions" && request.method === "POST") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.url === "/v1/turn/stream" && request.method === "POST") {
        turnBody = JSON.parse(await readBody(request));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: turnBody!.trace_id,
          session_id: turnBody!.session_id,
        });
        await streamGate;
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "status",
          data: { status_key: "working", label: "Working", detail_text: null },
          ts: "2026-08-19T00:00:01Z",
        });
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "tool_started",
          data: {
            tool_name: "workspace.search",
            call_id: "call-1",
            state: "started",
          },
          ts: "2026-08-19T00:00:02Z",
        });
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "tool_completed",
          data: {
            tool_name: "workspace.search",
            call_id: "call-1",
            state: "completed",
            ok: true,
            duration_ms: 12,
            exit_code: null,
          },
          ts: "2026-08-19T00:00:02Z",
        });
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "approval_required",
          data: {
            approval_id: "approval-1",
            call_id: "call-2",
            tool_name: "workspace.write",
            argument_keys: ["path", "text"],
            requested_at: "2026-08-19T00:00:02Z",
            expires_at: "2026-08-19T00:01:02Z",
          },
          ts: "2026-08-19T00:00:02Z",
        });
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "approval_resolved",
          data: {
            approval_id: "approval-1",
            call_id: "call-2",
            tool_name: "workspace.write",
            decision: "deny",
            outcome: "denied",
            resolved_at: "2026-08-19T00:00:03Z",
          },
          ts: "2026-08-19T00:00:03Z",
        });
        writeEvent(response, "chunk", {
          trace_id: turnBody!.trace_id,
          kind: "final_text",
          data: { text: "hello" },
          ts: "2026-08-19T00:00:03Z",
        });
        writeEvent(response, "response", {
          trace_id: turnBody!.trace_id,
          final_text: "hello",
          errors: [],
          stats: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_tokens: 3,
            llm_calls: 2,
            tool_calls: 1,
            tool_errors: 0,
            duration_ms: 125,
          },
          metadata: { secret: "must-not-cross" },
          artifacts: [{ path: "/private/path" }],
        });
        writeEvent(response, "done", { status: "complete" });
        response.end();
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.create({})).toMatchObject({ ok: true });
    const emitted: TurnEventV1[] = [];
    const started = await client.submit({ sessionId: "session-1", message: " hello " }, (event) =>
      emitted.push(event),
    );
    expect(started).toMatchObject({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      await client.submit({ sessionId: "session-1", message: "duplicate" }, vi.fn()),
    ).toMatchObject({ ok: false, error: { code: "session_turn_active" } });
    releaseStream!();
    await vi.waitFor(() => expect(emitted.at(-1)?.kind).toBe("done"));

    expect(Object.keys(turnBody!)).toEqual([
      "trace_id",
      "session_id",
      "agent_id",
      "input_text",
      "mode",
      "stream",
      "channel",
      "user",
      "idempotency_key",
    ]);
    expect(turnBody).toMatchObject({
      session_id: "session-1",
      agent_id: "openminion",
      input_text: " hello ",
      mode: "oneshot",
      stream: true,
      channel: "console",
      user: "api-user",
    });
    expect(emitted.map((event) => event.kind)).toEqual([
      "started",
      "progress",
      "tool",
      "tool",
      "approval",
      "approval",
      "progress",
      "response",
      "done",
    ]);
    expect(emitted[1]).toMatchObject({
      kind: "progress",
      progressKind: "status",
      statusKey: "working",
    });
    expect(emitted[2]).toMatchObject({
      kind: "tool",
      phase: "started",
      toolName: "workspace.search",
      ok: null,
    });
    expect(emitted[3]).toMatchObject({
      kind: "tool",
      phase: "completed",
      durationMs: 12,
    });
    expect(emitted[4]).toMatchObject({
      kind: "approval",
      phase: "requested",
      argumentKeys: ["path", "text"],
    });
    expect(emitted[5]).toMatchObject({
      kind: "approval",
      phase: "resolved",
      decision: "deny",
      outcome: "denied",
    });
    expect(emitted[6]).toMatchObject({
      kind: "progress",
      progressKind: "text",
      text: "hello",
    });
    expect(emitted[7]).toMatchObject({
      kind: "response",
      usage: {
        usageAvailable: true,
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        llmCalls: 2,
        durationMs: 125,
        costUsd: null,
        costSource: "unavailable",
      },
    });
    expect(JSON.stringify(emitted)).not.toMatch(/secret|private|artifact|metadata/i);
    expect(await client.submit({ sessionId: "session-1", message: "next" }, vi.fn())).toMatchObject(
      { ok: true },
    );
  });

  it("rejects partial, unknown, negative, and unsafe response usage", async () => {
    const invalidStats = [
      { input_tokens: 1 },
      {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        llm_calls: 1,
        tool_calls: 0,
        tool_errors: 0,
        duration_ms: 1,
        unknown: 1,
      },
      {
        input_tokens: -1,
        output_tokens: 1,
        cache_read_tokens: 0,
        llm_calls: 1,
        tool_calls: 0,
        tool_errors: 0,
        duration_ms: 1,
      },
      {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
        cache_read_tokens: 0,
        llm_calls: 1,
        tool_calls: 0,
        tool_errors: 0,
        duration_ms: 1,
      },
    ];
    let stream = 0;
    const readiness = await daemon(async (request, response) => {
      if (request.method === "POST" && request.url === "/v1/client/sessions") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/turn/stream") {
        const body = JSON.parse(await readBody(request));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: body.trace_id,
          session_id: body.session_id,
        });
        writeEvent(response, "response", {
          trace_id: body.trace_id,
          final_text: "done",
          errors: [],
          stats: invalidStats[stream++],
        });
        writeEvent(response, "done", { status: "complete" });
        response.end();
        return;
      }
    });
    const client = new OpenMinionClient(() => readiness);
    await client.create({});
    for (const _stats of invalidStats) {
      const emitted: TurnEventV1[] = [];
      expect(
        await client.submit({ sessionId: "session-1", message: "usage" }, (event) =>
          emitted.push(event),
        ),
      ).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(emitted.at(-1)).toMatchObject({ kind: "done" }));
      expect(emitted.at(-2)).toMatchObject({
        kind: "error",
        error: { code: "invalid_daemon_response" },
      });
    }
  });

  it("fails closed when stream identity or response schemas drift", async () => {
    let streamCount = 0;
    const readiness = await daemon(async (request, response) => {
      if (request.url === "/v1/client/sessions" && request.method === "POST") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.url === "/v1/turn/stream") {
        streamCount += 1;
        const body = JSON.parse(await readBody(request));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: streamCount === 1 ? `${body.trace_id}-mismatch` : body.trace_id,
          session_id: body.session_id,
        });
        if (streamCount === 2) {
          writeEvent(response, "chunk", {
            trace_id: body.trace_id,
            kind: "approval_required",
            data: {
              approval_id: "approval-1",
              call_id: "call-1",
              tool_name: "workspace.write",
              argument_keys: ["text", "path"],
              requested_at: "2026-08-19T00:00:02Z",
              expires_at: "2026-08-19T00:01:02Z",
            },
            ts: "2026-08-19T00:00:02Z",
          });
        }
        response.end();
        return;
      }
      if (request.url === "/v1/client/sessions?limit=1") {
        json(response, {
          ok: true,
          sessions: [{ ...session(), client_token: "must-not-cross" }],
          next_cursor: null,
          has_more: false,
          meta: meta(),
        });
        return;
      }
    });
    const client = new OpenMinionClient(() => readiness);
    await client.create({});
    expect(
      await client.submit({ sessionId: "session-1", message: "hello" }, vi.fn()),
    ).toMatchObject({ ok: false, error: { code: "submission_ambiguous" } });
    const emitted: TurnEventV1[] = [];
    expect(
      await client.submit({ sessionId: "session-1", message: "unsafe approval" }, (event) =>
        emitted.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(emitted.at(-1)?.kind).toBe("done"));
    expect(emitted[1]).toMatchObject({
      kind: "error",
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.list({ limit: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
  });

  it("admits only the bounded argument-key event fact", async () => {
    let eventCount = 0;
    const readiness = await daemon(async (_request, response) => {
      eventCount += 1;
      const facts =
        eventCount === 1
          ? {
              approval_id: "approval-1",
              call_id: "call-1",
              tool_name: "workspace.write",
              argument_keys: ["path", "text"],
              argument_keys_count: 2,
              outcome: "pending",
            }
          : eventCount === 2
            ? { argument_keys: ["text", "path"], argument_keys_count: 2 }
            : { status: ["must-not-cross"] };
      json(response, {
        ok: true,
        events: [{ ...eventValue(), facts }],
        next_cursor: `event-${eventCount}`,
        has_more: false,
        meta: meta(),
      });
    });
    const client = new OpenMinionClient(() => readiness);

    expect(await client.events({ sessionId: "session-1" })).toMatchObject({
      ok: true,
      value: {
        events: [
          {
            facts: {
              argument_keys: ["path", "text"],
              argument_keys_count: 2,
            },
          },
        ],
      },
    });
    for (let index = 0; index < 2; index += 1) {
      expect(await client.events({ sessionId: "session-1" })).toMatchObject({
        ok: false,
        error: { code: "invalid_daemon_response" },
      });
    }
  });

  it("rejects control responses correlated to a different session or trace", async () => {
    let loadCount = 0;
    const readiness = await daemon(async (request, response) => {
      await readBody(request);
      if (request.method === "GET" && request.url?.startsWith("/v1/client/sessions/session-1")) {
        loadCount += 1;
        json(response, {
          ok: true,
          session: loadCount === 1 ? { ...session(), session_id: "session-other" } : session(),
          messages: loadCount === 2 ? [{ ...message(), session_id: "session-other" }] : [],
          next_message_cursor: "message-cursor",
          messages_has_more: false,
          meta: meta(),
        });
        return;
      }
      if (request.method === "DELETE") {
        json(response, {
          ok: true,
          session: { ...session("closed"), session_id: "session-other" },
          meta: meta(),
        });
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/cancel")) {
        response.statusCode = 202;
        json(response, {
          ok: true,
          cancellation: {
            session_id: "session-other",
            trace_id: "trace-other",
            run_id: null,
            state: "requested",
            terminal: false,
          },
          meta: meta(),
        });
      }
    });
    const client = new OpenMinionClient(() => readiness);

    expect(await client.load({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.load({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.close({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.cancel({ sessionId: "session-1", traceId: "trace-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
  });

  it("fails closed on malformed or mismatched approval decisions", async () => {
    let requestCount = 0;
    const readiness = await daemon(async (request, response) => {
      await readBody(request);
      requestCount += 1;
      const approval: Record<string, unknown> = {
        schema_version: 1,
        approval_id: requestCount === 2 ? "approval-other" : "approval-1",
        session_id: "session-1",
        trace_id: "trace-1",
        call_id: "call-1",
        decision: "allow_once",
        outcome: requestCount === 1 ? "denied" : "applied",
        resolved_at: "2026-08-19T00:00:04Z",
      };
      if (requestCount === 3) {
        approval.client_token = "must-not-cross";
      }
      json(response, { ok: true, approval, meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);
    const input = {
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      decision: "allow_once" as const,
    };

    expect(await client.decide({ ...input, route: "/private" } as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(requestCount).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      expect(await client.decide(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_daemon_response" },
      });
    }
  });

  it("couples cancellation HTTP status to the exact active or terminal state", async () => {
    const responses = [
      { status: 202, state: "completed", terminal: true },
      { status: 200, state: "requested", terminal: false },
      { status: 200, state: "failed", terminal: false },
      { status: 200, state: "already_requested", terminal: false },
      { status: 200, state: "completed", terminal: true },
    ];
    const readiness = await daemon(async (request, response) => {
      await readBody(request);
      const next = responses.shift()!;
      response.statusCode = next.status;
      json(response, {
        ok: true,
        cancellation: {
          session_id: "session-1",
          trace_id: "trace-1",
          run_id: "run-1",
          state: next.state,
          terminal: next.terminal,
        },
        meta: meta(),
      });
    });
    const client = new OpenMinionClient(() => readiness);

    for (let index = 0; index < 3; index += 1) {
      expect(await client.cancel({ sessionId: "session-1", traceId: "trace-1" })).toMatchObject({
        ok: false,
        error: { code: "invalid_daemon_response" },
      });
    }
    expect(await client.cancel({ sessionId: "session-1", traceId: "trace-1" })).toMatchObject({
      ok: true,
      value: { state: "already_requested", terminal: false },
    });
    expect(await client.cancel({ sessionId: "session-1", traceId: "trace-1" })).toMatchObject({
      ok: true,
      value: { state: "completed", terminal: true },
    });
  });

  it("bounds complete SSE frames and completes once when the daemon keeps the socket open", async () => {
    let streamCount = 0;
    const readiness = await daemon(async (request, response) => {
      if (request.url === "/v1/client/sessions" && request.method === "POST") {
        await readBody(request);
        json(response, { ok: true, session: session(), meta: meta() });
        return;
      }
      if (request.url === "/v1/turn/stream") {
        streamCount += 1;
        const body = JSON.parse(await readBody(request));
        if (streamCount === 1) {
          response.writeHead(200, { "Content-Type": "text/event-streaming" });
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        if (streamCount === 4) {
          response.end(
            eventText("meta", {
              request_id: request.headers["x-request-id"],
              trace_id: body.trace_id,
              session_id: body.session_id,
            }) +
              eventText("response", {
                trace_id: body.trace_id,
                final_text: "must-not-cross",
                errors: [],
              }) +
              eventText("done", { status: "complete" }) +
              eventText("chunk", {
                trace_id: body.trace_id,
                kind: "final_text",
                data: { text: "after done" },
                ts: "2026-08-19T00:00:02Z",
              }),
          );
          return;
        }
        writeEvent(response, "meta", {
          request_id: request.headers["x-request-id"],
          trace_id: body.trace_id,
          session_id: body.session_id,
        });
        if (streamCount === 2) {
          writeEvent(response, "chunk", {
            trace_id: body.trace_id,
            kind: "final_text",
            data: { text: "x".repeat(600 * 1024) },
            ts: "2026-08-19T00:00:01Z",
          });
          return;
        }
        writeEvent(response, "response", {
          trace_id: body.trace_id,
          final_text: "done",
          errors: [],
        });
        writeEvent(response, "done", { status: "complete" });
      }
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.create({})).toMatchObject({ ok: true });

    expect(
      await client.submit({ sessionId: "session-1", message: "bad type" }, vi.fn()),
    ).toMatchObject({ ok: false, error: { code: "submission_ambiguous" } });

    const oversized: TurnEventV1[] = [];
    expect(
      await client.submit({ sessionId: "session-1", message: "oversized" }, (event) =>
        oversized.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(oversized.at(-1)?.kind).toBe("done"));
    expect(oversized).toContainEqual(
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({ code: "stream_limit_exceeded" }),
      }),
    );

    const completed: TurnEventV1[] = [];
    expect(
      await client.submit({ sessionId: "session-1", message: "valid" }, (event) =>
        completed.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(completed.at(-1)?.kind).toBe("done"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed.map((event) => event.kind)).toEqual(["started", "response", "done"]);

    const trailing: TurnEventV1[] = [];
    expect(
      await client.submit({ sessionId: "session-1", message: "trailing" }, (event) =>
        trailing.push(event),
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(trailing.at(-1)?.kind).toBe("done"));
    expect(trailing.map((event) => event.kind)).toEqual(["started", "error", "done"]);
    expect(trailing[1]).toMatchObject({
      kind: "error",
      error: { code: "stream_protocol_error" },
    });
  });

  it("projects artifact catalog, content, and decisions through fixed routes", async () => {
    const artifactId = "A".repeat(48);
    const cursor = "C".repeat(48);
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const readiness = await daemon(async (request, response) => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      if (request.url === "/v1/client/sessions/session-1/artifacts?limit=25") {
        json(response, {
          ok: true,
          artifacts: [artifactItem(artifactId)],
          next_cursor: null,
          complete: true,
          meta: meta(),
        });
        return;
      }
      if (
        request.url === `/v1/client/sessions/session-1/artifacts/${artifactId}?limit_bytes=65536`
      ) {
        json(response, {
          ok: true,
          content: {
            schema_version: 1,
            artifact_id: artifactId,
            session_id: "session-1",
            content_kind: "diff",
            text: "--- [PATH REDACTED]\n+++ [PATH REDACTED]\n@@ -1 +1 @@\n-old\n+new\n",
            complete: true,
            next_cursor: null,
          },
          meta: meta(),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === `/v1/client/sessions/session-1/artifacts/${artifactId}/detach`
      ) {
        json(response, {
          ok: true,
          artifact: {
            artifact_id: artifactId,
            session_id: "session-1",
            state: "detached",
            outcome: "applied",
          },
          meta: meta(),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === `/v1/client/sessions/session-1/artifacts/${artifactId}/restore`
      ) {
        json(response, {
          ok: true,
          artifact: {
            artifact_id: artifactId,
            session_id: "session-1",
            state: "active",
            outcome: "already_applied",
          },
          meta: meta(),
        });
        return;
      }
      response.statusCode = 404;
      json(response, { ok: false, error: daemonError("artifact_not_found"), meta: meta() });
    });
    const client = new OpenMinionClient(() => readiness);

    expect(await client.listArtifacts({ sessionId: "session-1", limit: 25 })).toEqual({
      ok: true,
      value: {
        artifacts: [camelArtifactItem(artifactId)],
        nextCursor: null,
        complete: true,
      },
    });
    expect(
      await client.readArtifact({
        sessionId: "session-1",
        artifactId,
        limitBytes: 64 * 1024,
      }),
    ).toMatchObject({
      ok: true,
      value: { artifactId, sessionId: "session-1", contentKind: "diff", complete: true },
    });
    expect(await client.detachArtifact({ sessionId: "session-1", artifactId })).toEqual({
      ok: true,
      value: { artifactId, sessionId: "session-1", state: "detached", outcome: "applied" },
    });
    expect(await client.restoreArtifact({ sessionId: "session-1", artifactId })).toEqual({
      ok: true,
      value: {
        artifactId,
        sessionId: "session-1",
        state: "active",
        outcome: "already_applied",
      },
    });
    expect(
      requests.slice(2).every((request) => request.body === JSON.stringify({ schema_version: 1 })),
    ).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("artifact://");
    expect(cursor).toHaveLength(48);
  });

  it("fails closed on artifact identity, cursor, and DTO drift", async () => {
    const artifactId = "A".repeat(48);
    let requestCount = 0;
    const readiness = await daemon(async (_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        json(response, {
          ok: true,
          artifacts: [{ ...artifactItem(artifactId), internal_ref: "artifact://must-not-cross" }],
          next_cursor: null,
          complete: true,
          meta: meta(),
        });
        return;
      }
      if (requestCount === 2) {
        json(response, {
          ok: true,
          content: {
            schema_version: 1,
            artifact_id: artifactId,
            session_id: "session-other",
            content_kind: "unavailable",
            text: "must-not-cross",
            complete: false,
            next_cursor: null,
          },
          meta: meta(),
        });
        return;
      }
      if (requestCount === 3) {
        response.statusCode = 404;
        json(response, {
          ok: false,
          error: {
            code: "artifact_missing",
            message: "Missing /Users/person/private artifact://sha256/internal",
            details: {},
            retryable: false,
            retry_after_ms: null,
          },
          meta: meta(),
        });
        return;
      }
      json(response, {
        ok: true,
        content: {
          schema_version: 1,
          artifact_id: artifactId,
          session_id: "session-1",
          content_kind: "text",
          text: "Internal path /Users/person/private and artifact://sha256/internal",
          complete: true,
          next_cursor: null,
        },
        meta: meta(),
      });
    });
    const client = new OpenMinionClient(() => readiness);
    expect(await client.listArtifacts({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.readArtifact({ sessionId: "session-1", artifactId })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    const beforeInvalid = requestCount;
    expect(
      await client.readArtifact({
        sessionId: "session-1",
        artifactId: "../artifact",
        route: "/v1/private",
      } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(requestCount).toBe(beforeInvalid);
    expect(await client.listArtifacts({ sessionId: "session-1" })).toEqual({
      ok: false,
      error: {
        code: "artifact_missing",
        message: "The artifact content is no longer available.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    expect(await client.readArtifact({ sessionId: "session-1", artifactId })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
  });

  it("rejects artifact state and HTTP error coupling drift", async () => {
    const artifactId = "A".repeat(48);
    let responseNumber = 0;
    const readiness = await daemon(async (_request, response) => {
      responseNumber += 1;
      if (responseNumber <= 4) {
        const variants = [
          {
            ...artifactItem(artifactId),
            kind: "artifact",
            source: "attachment",
            state: "missing",
            content_kind: "text",
            tool_name: null,
            tool_status: null,
            summary: null,
            actions: [],
          },
          {
            ...artifactItem(artifactId),
            kind: "artifact",
            source: "attachment",
            state: "active",
            content_kind: "unavailable",
            mime_type: null,
            size_bytes: null,
            tool_name: null,
            tool_status: null,
            summary: null,
            actions: [],
          },
          {
            ...artifactItem(artifactId),
            kind: "artifact",
            source: "attachment",
            state: "unsupported",
            content_kind: "unavailable",
            tool_name: null,
            tool_status: null,
            summary: null,
            actions: ["read"],
          },
          {
            ...artifactItem(artifactId),
            kind: "artifact",
            source: "attachment",
            state: "detached",
            content_kind: "unavailable",
            mime_type: null,
            size_bytes: null,
            tool_name: null,
            tool_status: null,
            summary: null,
            actions: ["read"],
          },
        ];
        json(response, {
          ok: true,
          artifacts: [variants[responseNumber - 1]],
          next_cursor: null,
          complete: true,
          meta: meta(),
        });
        return;
      }
      if (responseNumber === 5) {
        json(response, {
          ok: true,
          content: {
            schema_version: 1,
            artifact_id: artifactId,
            session_id: "session-1",
            content_kind: "unavailable",
            text: null,
            complete: false,
            next_cursor: "C".repeat(48),
          },
          meta: meta(),
        });
        return;
      }
      response.statusCode = responseNumber === 6 ? 409 : 404;
      json(response, {
        ok: false,
        error:
          responseNumber === 6
            ? {
                code: "artifact_missing",
                message: "Artifact is unavailable.",
                details: {},
                retryable: false,
                retry_after_ms: null,
              }
            : {
                code: "artifact_missing",
                message: "Artifact is unavailable.",
                retryable: false,
                retry_after_ms: null,
              },
        meta: meta(),
      });
    });
    const client = new OpenMinionClient(() => readiness);

    for (let index = 0; index < 4; index += 1) {
      expect(await client.listArtifacts({ sessionId: "session-1" })).toMatchObject({
        ok: false,
        error: { code: "invalid_daemon_response" },
      });
    }
    expect(await client.readArtifact({ sessionId: "session-1", artifactId })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.listArtifacts({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
    expect(await client.listArtifacts({ sessionId: "session-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_daemon_response" },
    });
  });
});

async function daemon(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<DesktopClientReady> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("fixture failed"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return {
    schema_version: 1,
    event: "desktop.client.ready",
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    protocol_min: 1,
    protocol_max: 1,
    daemon_version: "0.0.9",
    config_id: "a".repeat(64),
    client_id: "client-1",
    client_token: `synthetic-${"x".repeat(43)}`,
    expires_at: "2999-01-01T00:00:00Z",
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function json(response: ServerResponse, payload: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(eventText(event, data));
}

function eventText(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function session(status = "active") {
  return {
    schema_version: 1,
    session_id: "session-1",
    title: "Chat",
    status,
    created_at: "2026-08-19T00:00:00Z",
    updated_at: "2026-08-19T00:00:01Z",
    active_agent_id: "openminion",
    model: { provider: null, model_id: null },
    project_id: "project-1",
    event_cursor: "event-zero",
    turn_usage_display: "input_output_calls",
  };
}

function camelSession(status = "active") {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    title: "Chat",
    status,
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:01Z",
    activeAgentId: "openminion",
    model: { provider: null, modelId: null },
    projectId: "project-1",
    eventCursor: "event-zero",
    turnUsageDisplay: "input_output_calls",
  };
}

function message() {
  return {
    schema_version: 1,
    id: "message-1",
    session_id: "session-1",
    role: "assistant",
    body: "hello",
    stats: {
      input_tokens: 5700,
      output_tokens: 603,
      cache_read_tokens: 0,
      llm_calls: 4,
      tool_calls: 0,
      tool_errors: 0,
      duration_ms: 26_000,
    },
    created_at: "2026-08-19T00:00:02Z",
  };
}

function camelMessage() {
  return {
    schemaVersion: 1,
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    body: "hello",
    usage: {
      usageAvailable: true,
      inputTokens: 5700,
      outputTokens: 603,
      totalTokens: 6303,
      llmCalls: 4,
      durationMs: 26_000,
      costUsd: null,
      costSource: "unavailable",
    },
    createdAt: "2026-08-19T00:00:02Z",
  };
}

function eventValue() {
  return {
    schema_version: 1,
    event_type: "run.completed",
    cursor: "event-one",
    created_at: "2026-08-19T00:00:03Z",
    run_id: "run-1",
    trace_id: "trace-1",
    state: "completed",
    facts: { status: "completed", response_chars: 5 },
  };
}

function camelEvent() {
  return {
    schemaVersion: 1,
    eventType: "run.completed",
    cursor: "event-one",
    createdAt: "2026-08-19T00:00:03Z",
    runId: "run-1",
    traceId: "trace-1",
    state: "completed",
    facts: { status: "completed", response_chars: 5 },
  };
}

function artifactItem(artifactId: string) {
  return {
    schema_version: 1,
    artifact_id: artifactId,
    session_id: "session-1",
    kind: "tool_output",
    display_name: "workspace.patch",
    mime_type: "text/plain",
    size_bytes: 72,
    created_at: "2026-08-20T00:00:00Z",
    source: "tool",
    state: "active",
    content_kind: "diff",
    occurrence_count: 1,
    tool_name: "workspace.patch",
    tool_status: "completed",
    summary: "Updated one file",
    actions: ["read"],
  };
}

function camelArtifactItem(artifactId: string) {
  return {
    schemaVersion: 1,
    artifactId,
    sessionId: "session-1",
    kind: "tool_output",
    displayName: "workspace.patch",
    mimeType: "text/plain",
    sizeBytes: 72,
    createdAt: "2026-08-20T00:00:00Z",
    source: "tool",
    state: "active",
    contentKind: "diff",
    occurrenceCount: 1,
    toolName: "workspace.patch",
    toolStatus: "completed",
    summary: "Updated one file",
    actions: ["read"],
  };
}

function meta() {
  return { request_id: "request-1", method: "GET", path: "/redacted" };
}

function daemonError(code: string) {
  return { code, message: "Request failed.", retryable: false };
}
