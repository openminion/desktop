import { randomUUID } from "node:crypto";
import type { ReportValue } from "../shared/reports.js";
import type { RuntimeTask, TaskControlValue } from "../shared/tasks.js";
import { request, type IncomingMessage } from "node:http";
import type {
  ClientResult,
  SessionSummaryV1,
  SessionListInput,
  SessionListValue,
  SessionCreateInput,
  SessionLoadInput,
  SessionLoadValue,
  SessionCloseInput,
  SessionEventsInput,
  SessionEventsValue,
  SessionEventFact,
  TurnSubmitInput,
  TurnSubmitValue,
  TurnEventV1,
  TurnCancelInput,
  TurnCancellationValue,
} from "../shared/contracts.js";
import { runCommand, type RunCommand } from "./installation.js";
import {
  type OpenMinionClient,
  EVENT_FACTS,
  validateListInput,
  validateCreateInput,
  validateLoadInput,
  validateCloseInput,
  validateEventsInput,
  validateSubmitInput,
  validateCancelInput,
  requireRecord,
  requireArray,
  requireString,
  optionalString,
  responseEvent,
  errorValue,
  usageValue,
  turnUsageDisplay,
  protocolError,
  failure,
  failureFrom,
} from "./openminion-client.js";

export type CliCommandContext = { executable: string; args: readonly string[] };
type DraftSession = SessionSummaryV1 & { isDraft: true };
type TranscriptRecord = Record<string, unknown>;
type ActiveTurn = { identity: TurnSubmitValue | null };

function runtimeTask(value: unknown): RuntimeTask {
  const row = requireRecord(value);
  return {
    id: requireString(row.id),
    title: optionalString(row.title ?? null),
    status: optionalString(row.lifecycle_state ?? row.status ?? null),
    kind: optionalString(row.task_kind ?? null),
    schedule: optionalString(row.schedule_summary ?? null),
    dueAt: optionalString(row.due_at ?? null),
    operatorState: optionalString(row.operator_state ?? null),
    resumeAction: optionalString(row.resume_action ?? null),
    validActions: requireArray(row.valid_actions ?? []).filter(
      (action): action is "pause" | "resume" | "cancel" =>
        action === "pause" || action === "resume" || action === "cancel",
    ),
  };
}

export class CliClient implements Pick<OpenMinionClient, keyof OpenMinionClient> {
  readonly #context: () => CliCommandContext | null;
  readonly #run: RunCommand;
  readonly #drafts = new Map<string, DraftSession>();
  readonly #active = new Map<string, ActiveTurn>();
  readonly #taskControls = new Set<string>();

  constructor(context: () => CliCommandContext | null, run: RunCommand = runCommand) {
    this.#context = context;
    this.#run = run;
  }

  #configuring = false;

  beginConfiguration(): boolean {
    if (this.#configuring || this.#active.size > 0 || this.#taskControls.size > 0) return false;
    this.#configuring = true;
    return true;
  }

  endConfiguration(): void {
    this.#configuring = false;
  }

  readReport(input: unknown): Promise<ClientResult<ReportValue>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (Object.keys(value).some((key) => !["kind", "sessionId", "agentFilter"].includes(key)))
        throw protocolError("invalid_request", "Choose a supported report.");
      if (this.#configuring)
        throw protocolError("settings_busy", "Wait for Settings to finish applying.");
      if (
        value.agentFilter !== undefined &&
        (value.kind !== "agents" ||
          typeof value.agentFilter !== "string" ||
          value.agentFilter.length > 512)
      )
        throw protocolError("invalid_request", "Choose an exact agent ID or name.");
      if (value.kind === "agents") {
        const payload = await this.#request("/v1/agents");
        if (payload.ok !== true)
          throw protocolError("report_unavailable", "Agent discovery is unavailable.");
        const agents = requireArray(payload.agents).map((item) => {
          const row = requireRecord(item);
          const id = requireString(row.agent_id);
          return { id, label: optionalString(row.display_name ?? null) || id };
        });
        return {
          kind: "agents",
          agents: agents.filter(
            (agent) =>
              !value.agentFilter ||
              agent.id === value.agentFilter ||
              agent.label === value.agentFilter,
          ),
        };
      }
      if (value.kind === "tools") {
        const payload = await this.#request("/v1/tools");
        if (payload.ok !== true)
          throw protocolError("report_unavailable", "Tool inventory is unavailable.");
        return {
          kind: "tools",
          tools: requireArray(payload.tools)
            .map((item) => {
              const row = requireRecord(item);
              if (typeof row.enabled !== "boolean")
                throw protocolError(
                  "invalid_daemon_response",
                  "OpenMinion did not report tool availability.",
                );
              return { name: requireString(row.name), enabled: row.enabled };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      }
      if (value.kind === "tokens") {
        const { sessionId } = validateLoadInput({ sessionId: value.sessionId } as SessionLoadInput);
        if (sessionId.startsWith("-") || sessionId.includes("\0"))
          throw protocolError("invalid_request", "Choose a saved conversation.");
        if (this.#drafts.has(sessionId)) return { kind: "tokens", text: "No active session." };
        const context = this.#requireContext();
        const result = await this.#run(
          context.executable,
          [...context.args, "status", "tokens", "--session-id", sessionId],
          30_000,
        );
        if (result.exitCode !== 0)
          throw protocolError(
            "token_report_unavailable",
            "OpenMinion could not read saved token usage for this conversation.",
          );
        return { kind: "tokens", text: result.stdout };
      }
      throw protocolError("invalid_request", "Choose agents, tools, or tokens.");
    });
  }

  exportTranscript(input: unknown): Promise<ClientResult<string>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (Object.keys(value).some((key) => key !== "sessionId"))
        throw protocolError("invalid_request", "Choose a conversation to export.");
      const { sessionId } = validateLoadInput(value as SessionLoadInput);
      if (sessionId.startsWith("-") || sessionId.includes("\0"))
        throw protocolError("invalid_request", "Choose a saved conversation.");
      if (this.#drafts.has(sessionId))
        throw protocolError("session_not_found", "Send a message before exporting this task.");
      return this.#command(["export", "transcript", "--session-id", sessionId, "--format", "md"]);
    });
  }

  controlTasks(input: unknown): Promise<ClientResult<TaskControlValue>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (Object.keys(value).some((key) => !["sessionId", "action", "taskId"].includes(key)))
        throw protocolError("invalid_request", "Choose a supported task operation.");
      const { sessionId } = validateLoadInput({ sessionId: value.sessionId } as SessionLoadInput);
      const action = requireString(value.action);
      if (!["list", "show", "pause", "resume", "cancel"].includes(action))
        throw protocolError("invalid_request", "Choose a supported task action.");
      const taskId = action === "list" ? null : requireString(value.taskId);
      if (
        taskId !== null &&
        (!taskId || taskId.startsWith("-") || /\s|\0/.test(taskId) || taskId.length > 512)
      )
        throw protocolError("invalid_request", "Choose an exact task ID from OpenMinion.");
      const mutating = !["list", "show"].includes(action);
      if (this.#configuring || this.#taskControls.has(sessionId))
        throw protocolError("task_control_busy", "Wait for the current operation to finish.");
      if (mutating && this.#active.has(sessionId))
        throw protocolError(
          "session_turn_active",
          "Finish or stop this turn before changing work.",
        );
      // Reserve before loading scope so a turn or Settings cannot race a task change.
      if (mutating) this.#taskControls.add(sessionId);
      try {
        const loaded = await this.load({ sessionId, messageLimit: 1 });
        if (!loaded.ok) throw protocolError(loaded.error.code, loaded.error.message);
        const args = ["tasks", action];
        if (taskId) args.push(taskId);
        args.push("--session", sessionId, "--json");
        if (loaded.value.session.activeAgentId)
          args.push("--agent-id", loaded.value.session.activeAgentId);
        const payload = requireRecord(await this.#json(args));
        if (payload.ok !== true)
          throw protocolError(
            "task_control_failed",
            "OpenMinion did not complete this task operation.",
          );
        return {
          tasks: (action === "list" ? requireArray(payload.tasks) : [payload.task]).map(
            runtimeTask,
          ),
          pendingActions: action === "list" ? requireArray(payload.pending_actions).length : 0,
        };
      } finally {
        if (mutating) this.#taskControls.delete(sessionId);
      }
    });
  }

  list(input: SessionListInput): Promise<ClientResult<SessionListValue>> {
    return this.#control(async () => {
      const value = validateListInput(input);
      const offset = cursorOffset(value.cursor);
      const limit = value.limit ?? 100;
      const rows = requireArray(
        await this.#json(["sessions", "list", "--json", "--limit", String(offset + limit + 1)]),
      ).map((item) => {
        const row = requireRecord(item);
        const id = requireString(row.id);
        this.#drafts.delete(id);
        return summary(row, false);
      });
      const sessions = [...this.#drafts.values(), ...rows];
      const hasMore = sessions.length > offset + limit;
      return {
        sessions: sessions.slice(offset, offset + limit),
        nextCursor: hasMore ? String(offset + limit) : null,
        hasMore,
      };
    });
  }

  create(input: SessionCreateInput): Promise<ClientResult<SessionSummaryV1>> {
    return this.#control(async () => {
      const value = validateCreateInput(input);
      this.#requireContext();
      if (value.projectId)
        throw protocolError("unsupported_operation", "Project binding is not connected yet.");
      const now = new Date().toISOString();
      const draft: DraftSession = {
        schemaVersion: 1,
        sessionId: randomUUID(),
        title: value.title ?? "New task",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        activeAgentId: value.agentId ?? null,
        model: { provider: null, modelId: null },
        projectId: null,
        eventCursor: "0",
        turnUsageDisplay: "total",
        isDraft: true,
      };
      this.#drafts.set(draft.sessionId, draft);
      return draft;
    });
  }

  load(input: SessionLoadInput): Promise<ClientResult<SessionLoadValue>> {
    return this.#control(async () => {
      const value = validateLoadInput(input);
      const draft = this.#drafts.get(value.sessionId);
      if (draft)
        return { session: draft, messages: [], nextMessageCursor: "0", messagesHasMore: false };
      const [details, records] = await Promise.all([
        this.#json(["sessions", "show", value.sessionId, "--json"]),
        this.#transcript(value.sessionId),
      ]);
      const session = summary(requireRecord(details), true);
      if (session.sessionId !== value.sessionId)
        throw protocolError("invalid_daemon_response", "The returned session does not match.");
      const messages = records
        .filter(
          (row) =>
            row.type === "message" &&
            ["inbound", "outbound", "user", "assistant"].includes(String(row.role)),
        )
        .map((row) => ({
          schemaVersion: 1 as const,
          id: requireString(row.id),
          sessionId: value.sessionId,
          role: (row.role === "inbound" || row.role === "user" ? "user" : "assistant") as
            | "user"
            | "assistant",
          body: requireString(row.body),
          profileName: optionalString(requireRecord(row.metadata ?? {}).display_name ?? null),
          ...(row.stats === undefined ? {} : { usage: usageValue(row.stats) }),
          createdAt: requireString(row.created_at),
        }));
      const offset = cursorOffset(value.messageAfter);
      const end = offset + (value.messageLimit ?? 200);
      return {
        session,
        messages: messages.slice(offset, end),
        nextMessageCursor: String(Math.min(end, messages.length)),
        messagesHasMore: end < messages.length,
      };
    });
  }

  async validateWritableSession(
    sessionId: string,
  ): Promise<ClientResult<{ sessionId: string; writable: true }>> {
    if (this.#active.has(sessionId))
      return failure("session_turn_active", "A turn is already active for this session.");
    const loaded = await this.load({ sessionId, messageLimit: 1 });
    if (!loaded.ok) return loaded;
    if (loaded.value.session.status === "closed")
      return failure("session_closed", "The selected session is closed.");
    return { ok: true, value: { sessionId, writable: true } };
  }

  close(input: SessionCloseInput): Promise<ClientResult<SessionSummaryV1>> {
    return this.#control(async () => {
      const value = validateCloseInput(input);
      if (this.#active.has(value.sessionId))
        throw protocolError(
          "session_turn_active",
          "Finish or cancel the turn before closing this task.",
        );
      const draft = this.#drafts.get(value.sessionId);
      if (draft) {
        this.#drafts.delete(value.sessionId);
        return { ...draft, status: "closed" as const };
      }
      await this.#command([
        "sessions",
        "close",
        value.sessionId,
        "--reason",
        value.reason ?? "manual_close",
      ]);
      return summary(
        requireRecord(await this.#json(["sessions", "show", value.sessionId, "--json"])),
        true,
      );
    });
  }

  events(input: SessionEventsInput): Promise<ClientResult<SessionEventsValue>> {
    return this.#control(async () => {
      const value = validateEventsInput(input);
      const records = this.#drafts.has(value.sessionId)
        ? []
        : await this.#transcript(value.sessionId, true);
      const rows = records.filter((row) => row.type === "event");
      const offset = cursorOffset(value.after);
      const end = offset + (value.limit ?? 200);
      return {
        events: rows.slice(offset, end).map((row, index) => {
          const payload = requireRecord(row.payload);
          const facts: Record<string, SessionEventFact> = {};
          for (const key of EVENT_FACTS) {
            const fact = payload[key];
            if (
              typeof fact === "string" ||
              typeof fact === "number" ||
              typeof fact === "boolean" ||
              fact === null
            )
              facts[key] = fact;
          }
          return {
            schemaVersion: 1 as const,
            eventType: requireString(row.event_type),
            cursor: String(offset + index + 1),
            createdAt: requireString(row.created_at),
            runId: optionalString(payload.run_id ?? null),
            traceId: optionalString(payload.trace_id ?? null),
            state: optionalString(payload.state ?? null),
            facts,
          };
        }),
        nextCursor: String(Math.min(end, rows.length)),
        hasMore: end < rows.length,
      };
    });
  }

  async submit(
    input: TurnSubmitInput,
    emit: (event: TurnEventV1) => void,
  ): Promise<ClientResult<TurnSubmitValue>> {
    let reservedSession: string | null = null;
    try {
      const value = validateSubmitInput(input);
      if (value.attachmentIds?.length || value.observation)
        return unsupported("Sending attachments and screenshots");
      if (this.#configuring)
        return failure(
          "settings_busy",
          "Settings are being applied. Try sending again in a moment.",
        );
      if (this.#taskControls.has(value.sessionId))
        return failure(
          "task_control_busy",
          "Wait for the task operation to finish before sending.",
        );
      if (this.#active.has(value.sessionId))
        return failure("session_turn_active", "A turn is already active for this session.");
      const draft = this.#drafts.get(value.sessionId);
      const details = draft
        ? null
        : requireRecord(await this.#json(["sessions", "show", value.sessionId, "--json"]));
      const session = draft ?? summary(details!, true);
      if (session.sessionId !== value.sessionId)
        throw protocolError("invalid_daemon_response", "The returned session does not match.");
      if (session.status === "closed")
        return failure("session_closed", "The selected session is closed.");
      // Reserve before endpoint discovery so a second send cannot race admission.
      this.#requireContext();
      if (this.#taskControls.has(value.sessionId))
        return failure(
          "task_control_busy",
          "Wait for the task operation to finish before sending.",
        );
      if (this.#configuring)
        return failure(
          "settings_busy",
          "Settings are being applied. Try sending again in a moment.",
        );
      if (this.#active.has(value.sessionId))
        return failure("session_turn_active", "A turn is already active for this session.");
      const pending: ActiveTurn = { identity: null };
      this.#active.set(value.sessionId, pending);
      reservedSession = value.sessionId;
      const endpoint = await this.#endpoint();
      const traceId = randomUUID();
      const body = JSON.stringify({
        trace_id: traceId,
        session_id: value.sessionId,
        agent_id: session.activeAgentId ?? endpoint.defaultAgent,
        input_text: value.message,
        channel: details ? requireString(details.channel) : "console",
        user: details ? requireString(details.target) : "api-user",
        stream: true,
        deliver: false,
        idempotency_key: randomUUID(),
        inbound_metadata: { caller_handles_delivery: "true", resume: "true" },
      });
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: endpoint.host,
            port: endpoint.port,
            path: "/v1/turn/stream",
            method: "POST",
            headers: {
              "X-IPC-Token": endpoint.token,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          resolve,
        );
        req.setTimeout(30_000, () => req.destroy(new Error("daemon_timeout")));
        req.on("error", reject);
        req.end(body);
      });
      if (
        response.statusCode !== 200 ||
        !response.headers["content-type"]?.startsWith("text/event-stream")
      ) {
        response.destroy();
        throw protocolError(
          "turn_rejected",
          "OpenMinion did not accept this message. Check the runtime connection and configuration.",
        );
      }
      response.setTimeout(0);
      return await this.#stream(response, pending, value.sessionId, traceId, emit);
    } catch (error) {
      if (reservedSession) this.#active.delete(reservedSession);
      return failureFrom(error);
    }
  }

  cancel(input: TurnCancelInput): Promise<ClientResult<TurnCancellationValue>> {
    return this.#control(async () => {
      const value = validateCancelInput(input);
      const active = this.#active.get(value.sessionId);
      if (active?.identity?.traceId !== value.traceId)
        throw protocolError("trace_not_found", "This turn is not active in Desktop.");
      const result = await this.#request(`/v1/turn/${encodeURIComponent(value.traceId)}/cancel`, {
        session_id: value.sessionId,
      });
      if (result.ok !== true || result.cancelled !== true || result.trace_id !== value.traceId)
        throw protocolError(
          "invalid_daemon_response",
          "Cancellation was not confirmed by OpenMinion.",
        );
      return {
        sessionId: value.sessionId,
        traceId: value.traceId,
        runId: value.traceId,
        state: "requested",
        terminal: false,
      };
    });
  }

  validateTurnSubmission(
    input: TurnSubmitInput,
  ): ClientResult<{ sessionId: string; input: TurnSubmitInput }> {
    try {
      const value = validateSubmitInput(input);
      if (value.attachmentIds?.length || value.observation)
        return unsupported("Sending attachments and screenshots");
      return { ok: true, value: { sessionId: value.sessionId, input: value } };
    } catch (error) {
      return failureFrom(error);
    }
  }

  validateSessionClose(input: SessionCloseInput): ClientResult<{ sessionId: string }> {
    try {
      return { ok: true, value: { sessionId: validateCloseInput(input).sessionId } };
    } catch (error) {
      return failureFrom(error);
    }
  }

  readonly decide: OpenMinionClient["decide"] = async () => unsupported("Approval decisions");
  readonly listArtifacts: OpenMinionClient["listArtifacts"] = async () =>
    unsupported("Artifact browsing");
  readonly readArtifact: OpenMinionClient["readArtifact"] = async () =>
    unsupported("Artifact browsing");
  readonly detachArtifact: OpenMinionClient["detachArtifact"] = async () =>
    unsupported("Artifact changes");
  readonly restoreArtifact: OpenMinionClient["restoreArtifact"] = async () =>
    unsupported("Artifact changes");
  readonly uploadMedia: OpenMinionClient["uploadMedia"] = async () =>
    unsupported("Attachments and screenshots");
  readonly releaseMedia: OpenMinionClient["releaseMedia"] = async () =>
    unsupported("Attachments and screenshots");

  #requireContext(): CliCommandContext {
    const context = this.#context();
    if (!context)
      throw protocolError(
        "daemon_unavailable",
        "Connect OpenMinion before sending a message.",
        true,
      );
    return context;
  }

  async #command(args: string[]): Promise<string> {
    const context = this.#requireContext();
    const result = await this.#run(context.executable, [...context.args, ...args], 30_000);
    if (result.exitCode !== 0)
      throw protocolError(
        "cli_command_failed",
        "OpenMinion could not complete this operation. Check the runtime connection and configuration.",
      );
    return result.stdout;
  }

  async #json(args: string[]): Promise<unknown> {
    return JSON.parse(await this.#command(args));
  }

  async #transcript(sessionId: string, events = false): Promise<TranscriptRecord[]> {
    const args = ["export", "transcript", "--session-id", sessionId, "--format", "jsonl"];
    if (events) args.push("--include-events");
    const text = await this.#command(args);
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => requireRecord(JSON.parse(line)));
  }

  async #control<T>(operation: () => Promise<T>): Promise<ClientResult<T>> {
    try {
      this.#requireContext();
      return { ok: true, value: await operation() };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async #endpoint() {
    const [status, config] = await Promise.all([
      this.#json(["daemon", "status", "--json"]),
      this.#json(["config", "show"]),
    ]);
    const daemon = requireRecord(status);
    const runtime = requireRecord(requireRecord(config).runtime);
    if (
      daemon.reachable !== true ||
      !["127.0.0.1", "::1"].includes(String(daemon.host)) ||
      !Number.isInteger(daemon.port) ||
      Number(daemon.port) < 1 ||
      Number(daemon.port) > 65535
    )
      throw protocolError(
        "invalid_daemon_response",
        "OpenMinion did not report a local daemon endpoint.",
      );
    return {
      host: String(daemon.host),
      port: Number(daemon.port),
      token: requireString(runtime.ipc_token),
      defaultAgent: optionalString(requireRecord(config).default_agent ?? null),
    };
  }

  async #request(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const endpoint = await this.#endpoint();
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? "" : JSON.stringify(body);
      const req = request(
        {
          hostname: endpoint.host,
          port: endpoint.port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(encoded),
            "X-IPC-Token": endpoint.token,
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
            if (Buffer.byteLength(text) > 1024 * 1024)
              response.destroy(
                protocolError("response_too_large", "The daemon response exceeded its limit."),
              );
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const payload = requireRecord(JSON.parse(text));
              if (response.statusCode !== 200)
                throw protocolError("daemon_request_failed", "OpenMinion rejected this operation.");
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(15_000, () =>
        req.destroy(protocolError("daemon_timeout", "OpenMinion did not respond in time.", true)),
      );
      req.on("error", reject);
      req.end(encoded);
    });
  }

  #stream(
    response: IncomingMessage,
    active: ActiveTurn,
    sessionId: string,
    traceId: string,
    emit: (event: TurnEventV1) => void,
  ): Promise<ClientResult<TurnSubmitValue>> {
    return new Promise((resolve) => {
      let buffer = "";
      let bytes = 0;
      let terminal = false;
      let receivedResponse = false;
      let outcome: "complete" | "error" | "cancelled" = "complete";
      const fail = () => {
        if (terminal) return;
        terminal = true;
        clearTimeout(startupTimer);
        this.#active.delete(sessionId);
        const result = failure(
          "daemon_stream_failed",
          "The OpenMinion stream ended unexpectedly. Reload the task before sending again.",
          true,
        );
        if (active.identity) {
          emit({
            schemaVersion: 1,
            kind: "error",
            sessionId,
            traceId: active.identity.traceId,
            error: result.error,
          });
          emit({
            schemaVersion: 1,
            kind: "done",
            sessionId,
            traceId: active.identity.traceId,
            outcome: "error",
          });
        }
        resolve(result);
        response.destroy();
      };
      const startupTimer = setTimeout(fail, 30_000);
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (bytes > 8 * 1024 * 1024 || Buffer.byteLength(buffer) > 512 * 1024) {
          fail();
          return;
        }
        try {
          let newline = buffer.indexOf("\n\n");
          while (newline >= 0 && !terminal) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 2);
            if (line.trim()) {
              const lines = line.split("\n");
              const event = lines.find((item) => item.startsWith("event: "))?.slice(7);
              const dataText = lines
                .filter((item) => item.startsWith("data: "))
                .map((item) => item.slice(6))
                .join("\n");
              const row = { event };
              const data = requireRecord(JSON.parse(dataText));
              if (row.event === "meta") {
                if (
                  active.identity ||
                  data.session_id !== sessionId ||
                  data.trace_id !== traceId ||
                  data.stream_schema_version !== "openminion.turn-stream.v1"
                )
                  throw new Error("Invalid stream identity");
                active.identity = {
                  requestId: requireString(data.request_id),
                  traceId: requireString(data.trace_id),
                  sessionId,
                };
                clearTimeout(startupTimer);
                emit({ schemaVersion: 1, kind: "started", ...active.identity });
                resolve({ ok: true, value: active.identity });
              } else {
                if (
                  !active.identity ||
                  (row.event !== "error" && data.trace_id !== active.identity.traceId)
                )
                  throw new Error("Invalid stream identity");
                if (row.event === "chunk") {
                  const detail = requireRecord(data.data);
                  if (data.kind === "status")
                    emit({
                      schemaVersion: 1,
                      kind: "progress",
                      progressKind: "status",
                      sessionId,
                      traceId: active.identity.traceId,
                      statusKey: requireString(detail.status_key),
                      label: optionalString(detail.label ?? null),
                      detailText: optionalString(detail.detail_text ?? null),
                      createdAt: requireString(data.ts),
                    });
                  if (data.kind === "final_text")
                    emit({
                      schemaVersion: 1,
                      kind: "progress",
                      progressKind: "text",
                      sessionId,
                      traceId: active.identity.traceId,
                      text: requireString(detail.text),
                      createdAt: requireString(data.ts),
                    });
                } else if (row.event === "response") {
                  const response = responseEvent(data, active.identity);
                  receivedResponse = true;
                  this.#drafts.delete(sessionId);
                  if (response.errors.length)
                    outcome = response.errors.some((error) => error.code === "cancelled")
                      ? "cancelled"
                      : "error";
                  emit(response);
                } else if (row.event === "error") {
                  outcome = "error";
                  emit({
                    schemaVersion: 1,
                    kind: "error",
                    sessionId,
                    traceId: active.identity.traceId,
                    error: errorValue(data),
                  });
                } else if (row.event === "done") {
                  if (!["complete", "error"].includes(String(data.status)))
                    throw new Error("Invalid stream outcome");
                  if (data.status === "error") outcome = "error";
                  if (outcome === "complete" && !receivedResponse)
                    throw new Error("Missing turn response");
                  terminal = true;
                  response.destroy();
                  clearTimeout(startupTimer);
                  this.#active.delete(sessionId);
                  emit({
                    schemaVersion: 1,
                    kind: "done",
                    sessionId,
                    traceId: active.identity.traceId,
                    outcome,
                  });
                } else throw new Error("Unsupported stream event");
              }
            }
            newline = buffer.indexOf("\n\n");
          }
        } catch {
          fail();
        }
      });
      response.on("error", fail);
      response.on("close", () => {
        if (!terminal) fail();
      });
    });
  }
}

function cursorOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw protocolError("invalid_request", "The history cursor is invalid.");
  return Number(value);
}

function summary(row: Record<string, unknown>, detail: boolean): SessionSummaryV1 {
  const state = requireString(row.status);
  if (!["active", "idle", "paused", "stale", "closed"].includes(state))
    throw protocolError(
      "invalid_daemon_response",
      "OpenMinion returned an unsupported session state.",
    );
  return {
    schemaVersion: 1,
    sessionId: requireString(row.id),
    title:
      (detail
        ? optionalString(requireRecord(row.metadata).name ?? null)
        : optionalString(row.name ?? null)) || null,
    status: state as SessionSummaryV1["status"],
    createdAt: detail ? requireString(row.created_at) : "",
    updatedAt: detail ? requireString(row.updated_at) : "",
    activeAgentId: optionalString(row.agent),
    model: { provider: null, modelId: null },
    projectId: null,
    eventCursor: "0",
    turnUsageDisplay: turnUsageDisplay(row.turn_usage_display),
  };
}

function unsupported(feature: string): ReturnType<typeof failure> {
  return failure(
    "unsupported_operation",
    `${feature} are not connected to the installed OpenMinion runtime yet.`,
  );
}
