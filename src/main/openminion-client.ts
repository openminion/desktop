import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import type {
  ApprovalDecision,
  ApprovalDecisionInput,
  ApprovalDecisionV1,
  ApprovalEventV1,
  ArtifactAction,
  ArtifactCatalogItemV1,
  ArtifactContentKind,
  ArtifactContentV1,
  ArtifactDecisionInput,
  ArtifactDecisionValue,
  ArtifactListInput,
  ArtifactListValue,
  ArtifactReadInput,
  ClientResult,
  DesktopClientReady,
  ErrorV1,
  MessageV1,
  MediaAttachmentV1,
  MediaReleaseInput,
  MediaReleaseValue,
  SessionCloseInput,
  SessionCreateInput,
  SessionEventFact,
  SessionEventsInput,
  SessionEventsValue,
  SessionListInput,
  SessionListValue,
  SessionLoadInput,
  SessionLoadValue,
  SessionStatus,
  SessionSummaryV1,
  TurnCancelInput,
  TurnCancellationValue,
  TurnErrorV1,
  TurnEventV1,
  TurnResponseV1,
  TurnSubmitInput,
  TurnSubmitValue,
} from "../shared/contracts.js";
import { clientHeaders } from "./security.js";

const CONTROL_TIMEOUT_MS = 15_000;
const TERMINAL_GRACE_MS = 5_000;
const STREAM_BUFFER_BYTES = 512 * 1024;
const STREAM_TOTAL_BYTES = 8 * 1024 * 1024;
const STREAM_FRAME_LIMIT = 4_096;
const TURN_BODY_BYTES = 256 * 1024;
const DONE_FRAME_PREFIX = Buffer.from("event: done\n");
const SESSION_STATUSES = new Set<SessionStatus>(["active", "idle", "paused", "stale", "closed"]);
export const EVENT_FACTS = new Set([
  "step",
  "status",
  "previous_status",
  "reason",
  "reason_code",
  "closed_at",
  "agent_id",
  "response_id",
  "response_chars",
  "provider",
  "model",
  "delivery_mode",
  "channel",
  "target",
  "approval_id",
  "call_id",
  "command_id",
  "tool_name",
  "decision",
  "outcome",
  "requested_at",
  "expires_at",
  "resolved_at",
  "argument_keys_count",
  "duration_ms",
  "ok",
  "summary_status",
]);

type ReadinessSource = () => DesktopClientReady | null;
type EventSink = (event: TurnEventV1) => void;
type JsonRecord = Record<string, unknown>;
type ClientFailureResult = { ok: false; error: ErrorV1 };
type MediaUpload = {
  sessionId: string;
  name: string;
  mimeType: MediaAttachmentV1["mimeType"];
  sizeBytes: number;
  stream: Readable;
  signal?: AbortSignal;
};

export class OpenMinionClient {
  readonly #readiness: ReadinessSource;
  readonly #agents = new Map<string, string>();
  readonly #closedSessions = new Set<string>();
  readonly #activeSessions = new Set<string>();

  constructor(readiness: ReadinessSource) {
    this.#readiness = readiness;
  }

  list(input: SessionListInput): Promise<ClientResult<SessionListValue>> {
    return this.#control(async (readiness) => {
      const value = validateListInput(input);
      const query = queryString({ cursor: value.cursor, limit: value.limit });
      const payload = await requestJson(
        readiness,
        "GET",
        `/v1/client/sessions${query}`,
        undefined,
        256 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "sessions", "next_cursor", "has_more", "meta"]);
      const sessions = requireArray(payload.sessions).map(sessionSummary);
      sessions.forEach((session) => {
        this.#rememberAgent(session);
      });
      return {
        sessions,
        nextCursor: optionalString(payload.next_cursor),
        hasMore: requireBoolean(payload.has_more),
      };
    });
  }

  create(input: SessionCreateInput): Promise<ClientResult<SessionSummaryV1>> {
    return this.#control(async (readiness) => {
      const value = validateCreateInput(input);
      const payload = await requestJson(
        readiness,
        "POST",
        "/v1/client/sessions",
        snakeCaseDefined({
          agent_id: value.agentId,
          title: value.title,
          project_id: value.projectId,
        }),
        64 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "session", "meta"]);
      const session = sessionSummary(payload.session);
      this.#rememberAgent(session);
      return session;
    });
  }

  load(input: SessionLoadInput): Promise<ClientResult<SessionLoadValue>> {
    return this.#control(async (readiness) => {
      const value = validateLoadInput(input);
      const query = queryString({
        message_after: value.messageAfter,
        message_limit: value.messageLimit,
      });
      const payload = await requestJson(
        readiness,
        "GET",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}${query}`,
        undefined,
        512 * 1024,
      );
      requireSuccessEnvelope(payload, [
        "ok",
        "session",
        "messages",
        "next_message_cursor",
        "messages_has_more",
        "meta",
      ]);
      const session = sessionSummary(payload.session);
      if (session.sessionId !== value.sessionId) {
        throw protocolError("invalid_daemon_response", "The daemon returned a different session.");
      }
      const messages = requireArray(payload.messages).map(messageValue);
      if (messages.some((message) => message.sessionId !== value.sessionId)) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned a message for a different session.",
        );
      }
      this.#rememberAgent(session);
      return {
        session,
        messages,
        nextMessageCursor: requireString(payload.next_message_cursor),
        messagesHasMore: requireBoolean(payload.messages_has_more),
      };
    });
  }

  async validateWritableSession(
    sessionId: string,
  ): Promise<ClientResult<{ sessionId: string; writable: true }>> {
    if (this.#closedSessions.has(sessionId)) {
      return failure("session_closed", "The selected session is closed.");
    }
    if (this.#activeSessions.has(sessionId)) {
      return failure("session_turn_active", "A turn is already active for this session.");
    }
    const loaded = await this.load({ sessionId, messageLimit: 1 });
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value.session.status === "closed") {
      return failure("session_closed", "The selected session is closed.");
    }
    if (this.#activeSessions.has(sessionId)) {
      return failure("session_turn_active", "A turn is already active for this session.");
    }
    return { ok: true, value: { sessionId, writable: true } };
  }

  close(input: SessionCloseInput): Promise<ClientResult<SessionSummaryV1>> {
    return this.#control(async (readiness) => {
      const value = validateCloseInput(input);
      const payload = await requestJson(
        readiness,
        "DELETE",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}`,
        snakeCaseDefined({ reason: value.reason }),
        64 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "session", "meta"]);
      const session = sessionSummary(payload.session);
      if (session.sessionId !== value.sessionId) {
        throw protocolError("invalid_daemon_response", "The daemon returned a different session.");
      }
      this.#rememberAgent(session);
      return session;
    });
  }

  events(input: SessionEventsInput): Promise<ClientResult<SessionEventsValue>> {
    return this.#control(async (readiness) => {
      const value = validateEventsInput(input);
      const query = queryString({ after: value.after, limit: value.limit });
      const payload = await requestJson(
        readiness,
        "GET",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/events${query}`,
        undefined,
        1024 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "events", "next_cursor", "has_more", "meta"]);
      return {
        events: requireArray(payload.events).map(sessionEvent),
        nextCursor: requireString(payload.next_cursor),
        hasMore: requireBoolean(payload.has_more),
      };
    });
  }

  cancel(input: TurnCancelInput): Promise<ClientResult<TurnCancellationValue>> {
    return this.#control(async (readiness) => {
      const value = validateCancelInput(input);
      const response = await requestJsonWithStatus(
        readiness,
        "POST",
        `/v1/turn/${encodeURIComponent(value.traceId)}/cancel`,
        { session_id: value.sessionId },
        64 * 1024,
        [200, 202],
      );
      const payload = response.payload;
      requireSuccessEnvelope(payload, ["ok", "cancellation", "meta"]);
      const cancellation = cancellationValue(payload.cancellation);
      if (cancellation.sessionId !== value.sessionId || cancellation.traceId !== value.traceId) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned a different cancellation.",
        );
      }
      validateCancellationResponse(response.status, cancellation);
      return cancellation;
    });
  }

  decide(input: ApprovalDecisionInput): Promise<ClientResult<ApprovalDecisionV1>> {
    return this.#control(async (readiness) => {
      const value = validateApprovalDecisionInput(input);
      const payload = await requestJson(
        readiness,
        "POST",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/turns/${encodeURIComponent(value.traceId)}/approvals/${encodeURIComponent(value.approvalId)}`,
        { decision: value.decision },
        64 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "approval", "meta"]);
      const approval = approvalDecisionValue(payload.approval);
      if (
        approval.sessionId !== value.sessionId ||
        approval.traceId !== value.traceId ||
        approval.approvalId !== value.approvalId ||
        approval.decision !== value.decision ||
        !decisionOutcomeMatches(approval.decision, approval.outcome)
      ) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned a different approval decision.",
        );
      }
      return approval;
    });
  }

  listArtifacts(input: ArtifactListInput): Promise<ClientResult<ArtifactListValue>> {
    return this.#artifactControl(async (readiness) => {
      const value = validateArtifactListInput(input);
      const query = queryString({ cursor: value.cursor, limit: value.limit });
      const payload = await requestArtifactJson(
        readiness,
        "GET",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/artifacts${query}`,
        undefined,
        256 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "artifacts", "next_cursor", "complete", "meta"]);
      const artifacts = requireArray(payload.artifacts).map(artifactCatalogItem);
      if (artifacts.some((artifact) => artifact.sessionId !== value.sessionId)) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned an artifact for a different session.",
        );
      }
      const nextCursor = optionalOpaqueResponse(payload.next_cursor);
      const complete = requireBoolean(payload.complete);
      if ((complete && nextCursor !== null) || (!complete && nextCursor === null)) {
        throw protocolError("invalid_daemon_response", "The daemon artifact cursor is invalid.");
      }
      return { artifacts, nextCursor, complete };
    });
  }

  readArtifact(input: ArtifactReadInput): Promise<ClientResult<ArtifactContentV1>> {
    return this.#artifactControl(async (readiness) => {
      const value = validateArtifactReadInput(input);
      const query = queryString({ cursor: value.cursor, limit_bytes: value.limitBytes });
      const payload = await requestArtifactJson(
        readiness,
        "GET",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/artifacts/${encodeURIComponent(value.artifactId)}${query}`,
        undefined,
        128 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "content", "meta"]);
      const content = artifactContent(payload.content);
      if (content.sessionId !== value.sessionId || content.artifactId !== value.artifactId) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned different artifact content.",
        );
      }
      return content;
    });
  }

  detachArtifact(input: ArtifactDecisionInput): Promise<ClientResult<ArtifactDecisionValue>> {
    return this.#artifactDecision(input, "detach");
  }

  restoreArtifact(input: ArtifactDecisionInput): Promise<ClientResult<ArtifactDecisionValue>> {
    return this.#artifactDecision(input, "restore");
  }

  uploadMedia(input: MediaUpload): Promise<ClientResult<MediaAttachmentV1>> {
    return this.#control(async (readiness) => {
      const value = validateMediaUpload(input);
      this.#requireWritableSession(value.sessionId);
      const payload = await requestMediaUpload(readiness, value);
      requireSuccessEnvelope(payload, ["ok", "media", "meta"]);
      const media = mediaAttachment(payload.media);
      if (
        media.sessionId !== value.sessionId ||
        media.name !== value.name ||
        media.mimeType !== value.mimeType ||
        media.sizeBytes !== value.sizeBytes
      ) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned different media metadata.",
        );
      }
      return media;
    });
  }

  releaseMedia(input: MediaReleaseInput): Promise<ClientResult<MediaReleaseValue>> {
    return this.#control(async (readiness) => {
      const value = validateMediaReleaseInput(input);
      const payload = await requestJson(
        readiness,
        "DELETE",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/media/${value.mediaId}`,
        undefined,
        64 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "released", "media_id", "meta"]);
      if (payload.released !== true || payload.media_id !== value.mediaId) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned a different media release.",
        );
      }
      return { mediaId: value.mediaId, released: true };
    });
  }

  async submit(input: TurnSubmitInput, emit: EventSink): Promise<ClientResult<TurnSubmitValue>> {
    try {
      const value = validateSubmitInput(input);
      if (this.#activeSessions.has(value.sessionId)) {
        return failure("session_turn_active", "A turn is already active for this session.");
      }
      const agentId = this.#agents.get(value.sessionId);
      if (!agentId) {
        return failure("session_not_loaded", "Load the session before submitting a turn.");
      }
      if (this.#closedSessions.has(value.sessionId)) {
        return failure("session_closed", "The selected session is closed.");
      }
      const readiness = this.#readiness();
      if (!readiness) {
        return failure("daemon_unavailable", "The local OpenMinion daemon is not ready.", true);
      }
      const identity = {
        requestId: randomUUID(),
        traceId: randomUUID(),
        sessionId: value.sessionId,
      };
      const body = JSON.stringify({
        trace_id: identity.traceId,
        session_id: identity.sessionId,
        agent_id: agentId,
        input_text: value.message,
        mode: "oneshot",
        stream: true,
        channel: "console",
        user: "api-user",
        idempotency_key: randomUUID(),
        ...(value.attachmentIds?.length ? { attachments: value.attachmentIds } : {}),
      });
      if (Buffer.byteLength(body) > TURN_BODY_BYTES) {
        return failure("invalid_request", "The message exceeds the desktop turn limit.");
      }
      this.#activeSessions.add(value.sessionId);
      return await startTurnStream(readiness, body, identity, emit, () => {
        this.#activeSessions.delete(value.sessionId);
      });
    } catch (error) {
      return failureFrom(error);
    }
  }

  validateTurnSubmission(
    input: TurnSubmitInput,
  ): ClientResult<{ sessionId: string; input: TurnSubmitInput }> {
    try {
      const value = validateSubmitInput(input);
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

  async #control<T>(
    operation: (readiness: DesktopClientReady) => Promise<T>,
  ): Promise<ClientResult<T>> {
    try {
      const readiness = this.#readiness();
      if (!readiness) {
        return failure("daemon_unavailable", "The local OpenMinion daemon is not ready.", true);
      }
      return { ok: true, value: await operation(readiness) };
    } catch (error) {
      return failureFrom(error);
    }
  }

  #artifactDecision(
    input: ArtifactDecisionInput,
    action: "detach" | "restore",
  ): Promise<ClientResult<ArtifactDecisionValue>> {
    return this.#artifactControl(async (readiness) => {
      const value = validateArtifactDecisionInput(input);
      const payload = await requestArtifactJson(
        readiness,
        "POST",
        `/v1/client/sessions/${encodeURIComponent(value.sessionId)}/artifacts/${encodeURIComponent(value.artifactId)}/${action}`,
        { schema_version: 1 },
        64 * 1024,
      );
      requireSuccessEnvelope(payload, ["ok", "artifact", "meta"]);
      const decision = artifactDecisionValue(payload.artifact);
      const expectedState = action === "detach" ? "detached" : "active";
      if (
        decision.sessionId !== value.sessionId ||
        decision.artifactId !== value.artifactId ||
        decision.state !== expectedState
      ) {
        throw protocolError(
          "invalid_daemon_response",
          "The daemon returned a different artifact decision.",
        );
      }
      return decision;
    });
  }

  async #artifactControl<T>(
    operation: (readiness: DesktopClientReady) => Promise<T>,
  ): Promise<ClientResult<T>> {
    const result = await this.#control(operation);
    return result.ok ? result : { ok: false, error: safeArtifactError(result.error) };
  }

  #rememberAgent(session: SessionSummaryV1): void {
    if (session.status === "closed") {
      this.#closedSessions.add(session.sessionId);
    } else {
      this.#closedSessions.delete(session.sessionId);
    }
    if (session.activeAgentId) {
      this.#agents.set(session.sessionId, session.activeAgentId);
    }
  }

  #requireWritableSession(sessionId: string): void {
    if (!this.#agents.has(sessionId)) {
      throw protocolError("session_not_loaded", "Load the session before selecting media.");
    }
    if (this.#closedSessions.has(sessionId)) {
      throw protocolError("session_closed", "The selected session is closed.");
    }
  }
}

async function startTurnStream(
  readiness: DesktopClientReady,
  body: string,
  identity: TurnSubmitValue,
  emit: EventSink,
  onComplete: () => void,
): Promise<ClientResult<TurnSubmitValue>> {
  return new Promise((resolve) => {
    let resolved = false;
    let completed = false;
    let requestFinished = false;
    const complete = () => {
      if (!completed) {
        completed = true;
        onComplete();
      }
    };
    const headers = clientHeaders(readiness.client_token, true);
    headers.Accept = "text/event-stream";
    headers["Content-Length"] = Buffer.byteLength(body).toString();
    headers["X-Request-ID"] = identity.requestId;
    const request = httpRequest(
      daemonUrl(readiness, "/v1/turn/stream"),
      { method: "POST", headers },
      (response) => {
        if (response.statusCode !== 200) {
          void readJsonResponse(response, 64 * 1024)
            .then(
              (payload) => resolveOnce(failureFromPayload(payload), resolve),
              (error: unknown) => resolveOnce(failureFrom(error), resolve),
            )
            .finally(complete);
          return;
        }
        request.setTimeout(0);
        if (!hasMediaType(response.headers["content-type"], "text/event-stream")) {
          response.destroy();
          resolveOnce(
            failure("submission_ambiguous", "Check session history before retrying"),
            resolve,
          );
          complete();
          return;
        }
        void consumeStream(response, identity, (event) => {
          emit(event);
          if (!resolved && event.kind === "started") {
            resolved = true;
            resolve({ ok: true, value: identity });
          }
        })
          .catch((error: unknown) => {
            const result = failureFrom(error);
            if (!resolved) {
              resolved = true;
              resolve(failure("submission_ambiguous", "Check session history before retrying"));
              return;
            }
            emit({
              schemaVersion: 1,
              kind: "error",
              sessionId: identity.sessionId,
              traceId: identity.traceId,
              error: result.error,
            });
            emit({
              schemaVersion: 1,
              kind: "done",
              sessionId: identity.sessionId,
              traceId: identity.traceId,
              outcome: "error",
            });
          })
          .finally(complete);
      },
    );
    request.setTimeout(CONTROL_TIMEOUT_MS, () => request.destroy(new Error("daemon_timeout")));
    request.once("finish", () => {
      requestFinished = true;
    });
    request.once("error", (error) => {
      resolveOnce(
        requestFinished
          ? failure("submission_ambiguous", "Check session history before retrying")
          : failureFrom(error),
        resolve,
      );
      complete();
    });
    request.end(body);
  });
}

async function consumeStream(
  response: IncomingMessage,
  identity: TurnSubmitValue,
  emit: EventSink,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let bytes = 0;
  let frames = 0;
  let terminalTimer: NodeJS.Timeout | null = null;
  const state: StreamState = {
    started: false,
    terminal: false,
    result: null,
    outcome: null,
    terminalEvent: null,
  };
  try {
    for await (const chunk of response) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > STREAM_TOTAL_BYTES) {
        throw protocolError("stream_limit_exceeded", "The daemon stream exceeded its byte limit.");
      }
      buffer = Buffer.concat([buffer, value]);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.subarray(0, boundary);
        buffer = buffer.subarray(boundary + 2);
        if (frame.length > STREAM_BUFFER_BYTES) {
          throw protocolError(
            "stream_limit_exceeded",
            "The daemon stream frame exceeded its buffer limit.",
          );
        }
        frames += 1;
        if (frames > STREAM_FRAME_LIMIT) {
          throw protocolError(
            "stream_limit_exceeded",
            "The daemon stream exceeded its frame limit.",
          );
        }
        if (
          frame.subarray(0, DONE_FRAME_PREFIX.length).equals(DONE_FRAME_PREFIX) &&
          buffer.length !== 0
        ) {
          throw protocolError(
            "stream_protocol_error",
            "The daemon stream emitted data after completion.",
          );
        }
        projectFrame(frame, identity, state, emit);
        if (state.terminal) {
          if (terminalTimer) {
            clearTimeout(terminalTimer);
            terminalTimer = null;
          }
          response.destroy();
          return;
        }
        if (state.outcome !== null && !state.terminal && !terminalTimer) {
          terminalTimer = setTimeout(
            () =>
              response.destroy(
                protocolError(
                  "stream_terminal_timeout",
                  "The daemon stream did not finish within its terminal grace period.",
                ),
              ),
            TERMINAL_GRACE_MS,
          );
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > STREAM_BUFFER_BYTES) {
        throw protocolError(
          "stream_limit_exceeded",
          "The daemon stream frame exceeded its buffer limit.",
        );
      }
    }
    if (buffer.length !== 0 || !state.terminal) {
      throw protocolError(
        "stream_protocol_error",
        "The daemon stream ended without a terminal event.",
      );
    }
  } finally {
    if (terminalTimer) {
      clearTimeout(terminalTimer);
    }
  }
}

function projectFrame(
  frame: Buffer,
  identity: TurnSubmitValue,
  state: StreamState,
  emit: EventSink,
): void {
  if (state.terminal) {
    throw protocolError(
      "stream_protocol_error",
      "The daemon stream emitted data after completion.",
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  const lines = text.split("\n");
  if (lines.length !== 2 || !lines[0].startsWith("event: ") || !lines[1].startsWith("data: ")) {
    throw protocolError("stream_protocol_error", "The daemon stream frame is malformed.");
  }
  const name = lines[0].slice(7);
  const payload: unknown = JSON.parse(lines[1].slice(6));
  if (name === "meta") {
    if (state.started) {
      throw protocolError(
        "stream_protocol_error",
        "The daemon stream repeated its identity event.",
      );
    }
    exactRecord(payload, ["request_id", "trace_id", "session_id"]);
    const record = payload as JsonRecord;
    if (
      record.request_id !== identity.requestId ||
      record.trace_id !== identity.traceId ||
      record.session_id !== identity.sessionId
    ) {
      throw protocolError(
        "stream_identity_mismatch",
        "The daemon stream identity did not match the submitted turn.",
      );
    }
    state.started = true;
    emit({ schemaVersion: 1, kind: "started", ...identity });
    return;
  }
  if (!state.started) {
    throw protocolError("stream_protocol_error", "The daemon stream started out of order.");
  }
  if (name === "chunk") {
    if (state.result !== null) {
      throw protocolError(
        "stream_protocol_error",
        "The daemon stream emitted progress after its result.",
      );
    }
    const event = progressEvent(payload, identity);
    if (event) {
      emit(event);
    }
    return;
  }
  if (name === "response") {
    if (state.outcome !== null) {
      throw protocolError("stream_protocol_error", "The daemon stream repeated its result.");
    }
    const event = responseEvent(payload, identity);
    state.result = "response";
    state.outcome =
      cancellationOutcome(event.errors) ?? (event.errors.length ? "error" : "complete");
    state.terminalEvent = event;
    return;
  }
  if (name === "error") {
    if (state.outcome !== null) {
      throw protocolError("stream_protocol_error", "The daemon stream repeated its result.");
    }
    const error = errorValue(payload);
    state.result = "error";
    state.outcome = cancellationOutcome([error]) ?? "error";
    state.terminalEvent = {
      schemaVersion: 1,
      kind: "error",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      error,
    };
    return;
  }
  if (name === "done") {
    exactRecord(payload, ["status"]);
    const status = (payload as JsonRecord).status;
    if (
      state.outcome === null ||
      state.terminalEvent === null ||
      (status !== "complete" && status !== "error") ||
      (status === "complete" && state.result !== "response") ||
      (status === "error" && state.result !== "error")
    ) {
      throw protocolError("stream_protocol_error", "The daemon stream terminal state is invalid.");
    }
    state.terminal = true;
    emit(state.terminalEvent);
    emit({
      schemaVersion: 1,
      kind: "done",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      outcome: state.outcome,
    });
    return;
  }
  throw protocolError("stream_protocol_error", "The daemon stream event family is not supported.");
}

type StreamState = {
  started: boolean;
  terminal: boolean;
  result: "response" | "error" | null;
  outcome: "complete" | "error" | "cancelled" | null;
  terminalEvent: TurnResponseV1 | TurnErrorV1 | null;
};

function progressEvent(payload: unknown, identity: TurnSubmitValue): TurnEventV1 | null {
  exactRecord(payload, ["trace_id", "kind", "data", "ts"]);
  const record = payload as JsonRecord;
  if (record.trace_id !== identity.traceId) {
    throw protocolError(
      "stream_identity_mismatch",
      "The daemon stream chunk identity did not match the turn.",
    );
  }
  const kind = requireString(record.kind);
  const data = requireRecord(record.data);
  const createdAt = requireString(record.ts);
  if (kind === "status") {
    return {
      schemaVersion: 1,
      kind: "progress",
      progressKind: "status",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      statusKey: requireString(data.status_key),
      label: optionalString(data.label),
      detailText: optionalString(data.detail_text),
      createdAt,
    };
  }
  if (kind === "final_text") {
    return {
      schemaVersion: 1,
      kind: "progress",
      progressKind: "text",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      text: requireString(data.text),
      createdAt,
    };
  }
  if (kind === "tool_started") {
    exactRecord(data, ["tool_name", "call_id", "state"]);
    return {
      schemaVersion: 1,
      kind: "tool",
      phase: "started",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      toolName: requireString(data.tool_name),
      callId: requireString(data.call_id),
      state: requireString(data.state),
      createdAt,
      ok: null,
      durationMs: null,
      exitCode: null,
    };
  }
  if (kind === "tool_completed") {
    exactRecord(data, ["tool_name", "call_id", "state", "ok", "duration_ms", "exit_code"]);
    return {
      schemaVersion: 1,
      kind: "tool",
      phase: "completed",
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      toolName: requireString(data.tool_name),
      callId: requireString(data.call_id),
      state: requireString(data.state),
      createdAt,
      ok: optionalBoolean(data.ok),
      durationMs: optionalNumber(data.duration_ms),
      exitCode: optionalNumber(data.exit_code),
    };
  }
  if (kind === "approval_required") {
    exactRecord(data, [
      "approval_id",
      "call_id",
      "tool_name",
      "argument_keys",
      "requested_at",
      "expires_at",
    ]);
    return approvalEvent(identity, data, "requested");
  }
  if (kind === "approval_resolved") {
    exactRecord(data, [
      "approval_id",
      "call_id",
      "tool_name",
      "decision",
      "outcome",
      "resolved_at",
    ]);
    return approvalEvent(identity, data, "resolved");
  }
  return null;
}

function approvalEvent(
  identity: TurnSubmitValue,
  data: JsonRecord,
  phase: ApprovalEventV1["phase"],
): ApprovalEventV1 {
  if (phase === "requested") {
    return {
      schemaVersion: 1,
      kind: "approval",
      phase,
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      approvalId: requireString(data.approval_id),
      toolName: requireString(data.tool_name),
      callId: requireString(data.call_id),
      argumentKeys: boundedArgumentKeys(data.argument_keys),
      requestedAt: requireString(data.requested_at),
      expiresAt: requireString(data.expires_at),
      decision: null,
      outcome: "pending",
      resolvedAt: null,
    };
  }
  const decision = approvalDecision(data.decision, true);
  const outcome = requireString(data.outcome) as ApprovalEventV1["outcome"];
  if (!approvalResolutionMatches(decision, outcome)) {
    throw protocolError("invalid_daemon_response", "The daemon approval outcome is invalid.");
  }
  return {
    schemaVersion: 1,
    kind: "approval",
    phase,
    sessionId: identity.sessionId,
    traceId: identity.traceId,
    approvalId: requireString(data.approval_id),
    toolName: requireString(data.tool_name),
    callId: requireString(data.call_id),
    argumentKeys: [],
    requestedAt: null,
    expiresAt: null,
    decision,
    outcome,
    resolvedAt: requireString(data.resolved_at),
  };
}

function approvalResolutionMatches(
  decision: ApprovalDecision | null,
  outcome: ApprovalEventV1["outcome"],
): boolean {
  if (outcome === "applied") {
    return decision === "allow_once";
  }
  if (outcome === "denied") {
    return decision === "deny";
  }
  return (
    new Set(["expired", "cancelled", "interrupted", "event_failed"]).has(outcome) &&
    decision === null
  );
}

function responseEvent(payload: unknown, identity: TurnSubmitValue): TurnResponseV1 {
  const record = requireRecord(payload);
  if (record.trace_id !== identity.traceId) {
    throw protocolError(
      "stream_identity_mismatch",
      "The daemon response identity did not match the turn.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "response",
    sessionId: identity.sessionId,
    traceId: identity.traceId,
    finalText: requireString(record.final_text),
    errors: requireArray(record.errors).map(errorValue),
    usage: usageValue(record.stats),
  };
}

function usageValue(value: unknown): TurnResponseV1["usage"] {
  const unavailable = {
    usageAvailable: false as const,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    llmCalls: null,
    durationMs: null,
    costUsd: null,
    costSource: "unavailable" as const,
  };
  if (value === undefined) return unavailable;
  const record = requireRecord(value);
  const keys = Object.keys(record);
  if (keys.length === 0) return unavailable;
  exactRecord(record, [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "llm_calls",
    "tool_calls",
    "tool_errors",
    "duration_ms",
  ]);
  const numbers = keys.map((key) => record[key]);
  if (!numbers.every(nonnegativeSafeInteger)) {
    throw protocolError("invalid_daemon_response", "The daemon response usage is invalid.");
  }
  const inputTokens = record.input_tokens as number;
  const outputTokens = record.output_tokens as number;
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw protocolError("invalid_daemon_response", "The daemon response usage is invalid.");
  }
  return {
    usageAvailable: true,
    inputTokens,
    outputTokens,
    totalTokens,
    llmCalls: record.llm_calls as number,
    durationMs: record.duration_ms as number,
    costUsd: null,
    costSource: "unavailable",
  };
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function cancellationOutcome(errors: ErrorV1[]): "cancelled" | null {
  return errors.some((error) => error.code === "cancelled") ? "cancelled" : null;
}

async function requestMediaUpload(
  readiness: DesktopClientReady,
  input: MediaUpload,
): Promise<JsonRecord> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("grant_revoked"));
      return;
    }
    const headers = clientHeaders(readiness.client_token);
    headers["Content-Type"] = input.mimeType;
    headers["Content-Length"] = String(input.sizeBytes);
    headers["X-OpenMinion-Media-Name"] = encodeURIComponent(input.name);
    headers["X-Request-ID"] = randomUUID();
    const request = httpRequest(
      daemonUrl(readiness, `/v1/client/sessions/${encodeURIComponent(input.sessionId)}/media`),
      { method: "POST", headers },
      resolve,
    );
    request.setTimeout(CONTROL_TIMEOUT_MS, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    const abort = () => request.destroy(new Error("grant_revoked"));
    input.signal?.addEventListener("abort", abort, { once: true });
    request.once("close", () => input.signal?.removeEventListener("abort", abort));
    input.stream.once("error", (error) => request.destroy(error));
    input.stream.pipe(request);
  });
  const payload = await readJsonResponse(response, 64 * 1024);
  if (response.statusCode !== 201) {
    throw new ClientFailure(errorFromPayload(payload));
  }
  return payload;
}

async function requestJson(
  readiness: DesktopClientReady,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: JsonRecord | undefined,
  limit: number,
): Promise<JsonRecord> {
  return (await requestJsonWithStatus(readiness, method, path, body, limit, [200])).payload;
}

async function requestArtifactJson(
  readiness: DesktopClientReady,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: JsonRecord | undefined,
  limit: number,
): Promise<JsonRecord> {
  return (
    await requestJsonWithStatus(
      readiness,
      method,
      path,
      body,
      limit,
      [200],
      artifactErrorFromResponse,
    )
  ).payload;
}

async function requestJsonWithStatus(
  readiness: DesktopClientReady,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: JsonRecord | undefined,
  limit: number,
  acceptedStatuses: readonly number[],
  failureParser: ((status: number, payload: JsonRecord) => ErrorV1) | null = null,
): Promise<{ status: number; payload: JsonRecord }> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const headers = clientHeaders(readiness.client_token, encoded !== undefined);
    if (encoded !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(encoded).toString();
    }
    const request = httpRequest(daemonUrl(readiness, path), { method, headers }, resolve);
    request.setTimeout(CONTROL_TIMEOUT_MS, () => request.destroy(new Error("daemon_timeout")));
    request.once("error", reject);
    request.end(encoded);
  });
  const payload = await readJsonResponse(response, limit);
  const status = response.statusCode ?? 0;
  if (!acceptedStatuses.includes(status)) {
    throw new ClientFailure(
      failureParser ? failureParser(status, payload) : errorFromPayload(payload),
    );
  }
  return { status, payload };
}

async function readJsonResponse(response: IncomingMessage, limit: number): Promise<JsonRecord> {
  if (!hasMediaType(response.headers["content-type"], "application/json")) {
    response.destroy();
    throw protocolError("invalid_daemon_response", "The daemon response type is invalid.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) {
      response.destroy();
      throw protocolError("response_too_large", "The daemon response exceeded its route limit.");
    }
    chunks.push(value);
  }
  return requireRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
  );
}

function hasMediaType(value: string | string[] | undefined, expected: string): boolean {
  if (Array.isArray(value) || value === undefined) {
    return false;
  }
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim());
  return (
    mediaType.toLowerCase() === expected &&
    parameters.every((parameter) => {
      const separator = parameter.indexOf("=");
      return separator > 0 && parameter.slice(separator + 1).trim().length > 0;
    })
  );
}

function daemonUrl(readiness: DesktopClientReady, path: string): string {
  const host = readiness.host === "::1" ? "[::1]" : readiness.host;
  return `http://${host}:${readiness.port}${path}`;
}

function sessionSummary(value: unknown): SessionSummaryV1 {
  exactRecord(value, [
    "schema_version",
    "session_id",
    "title",
    "status",
    "created_at",
    "updated_at",
    "active_agent_id",
    "model",
    "project_id",
    "event_cursor",
  ]);
  const record = value as JsonRecord;
  const status = requireString(record.status) as SessionStatus;
  if (record.schema_version !== 1 || !SESSION_STATUSES.has(status)) {
    throw protocolError("invalid_daemon_response", "The daemon session summary is invalid.");
  }
  exactRecord(record.model, ["provider", "model_id"]);
  const model = record.model as JsonRecord;
  return {
    schemaVersion: 1,
    sessionId: requireString(record.session_id),
    title: optionalString(record.title),
    status,
    createdAt: requireString(record.created_at),
    updatedAt: requireString(record.updated_at),
    activeAgentId: optionalString(record.active_agent_id),
    model: { provider: optionalString(model.provider), modelId: optionalString(model.model_id) },
    projectId: optionalString(record.project_id),
    eventCursor: requireString(record.event_cursor),
  };
}

function messageValue(value: unknown): MessageV1 {
  exactRecord(value, ["schema_version", "id", "session_id", "role", "body", "created_at"]);
  const record = value as JsonRecord;
  if (record.schema_version !== 1 || (record.role !== "user" && record.role !== "assistant")) {
    throw protocolError("invalid_daemon_response", "The daemon message is invalid.");
  }
  return {
    schemaVersion: 1,
    id: requireString(record.id),
    sessionId: requireString(record.session_id),
    role: record.role,
    body: requireString(record.body),
    createdAt: requireString(record.created_at),
  };
}

function sessionEvent(value: unknown): SessionEventsValue["events"][number] {
  exactRecord(value, [
    "schema_version",
    "event_type",
    "cursor",
    "created_at",
    "run_id",
    "trace_id",
    "state",
    "facts",
  ]);
  const record = value as JsonRecord;
  const rawFacts = requireRecord(record.facts);
  const facts: Record<string, SessionEventFact> = {};
  for (const [key, fact] of Object.entries(rawFacts)) {
    if (key === "argument_keys") {
      facts[key] = boundedArgumentKeys(fact);
      continue;
    }
    if (!EVENT_FACTS.has(key) || !isScalarEventFact(fact)) {
      throw protocolError("invalid_daemon_response", "The daemon event facts are invalid.");
    }
    if (typeof fact === "string" && Buffer.byteLength(fact) > 4 * 1024) {
      throw protocolError("invalid_daemon_response", "The daemon event fact exceeds its limit.");
    }
    facts[key] = fact;
  }
  if (
    Array.isArray(facts.argument_keys) &&
    facts.argument_keys.length !== facts.argument_keys_count
  ) {
    throw protocolError("invalid_daemon_response", "The daemon argument-key facts are invalid.");
  }
  if (record.schema_version !== 1) {
    throw protocolError("invalid_daemon_response", "The daemon event schema is invalid.");
  }
  return {
    schemaVersion: 1,
    eventType: requireString(record.event_type),
    cursor: requireString(record.cursor),
    createdAt: requireString(record.created_at),
    runId: optionalString(record.run_id),
    traceId: optionalString(record.trace_id),
    state: optionalString(record.state),
    facts,
  };
}

function cancellationValue(value: unknown): TurnCancellationValue {
  exactRecord(value, ["session_id", "trace_id", "run_id", "state", "terminal"]);
  const record = value as JsonRecord;
  const state = requireString(record.state);
  if (!new Set(["requested", "already_requested", "completed", "failed", "cancelled"]).has(state)) {
    throw protocolError("invalid_daemon_response", "The daemon cancellation state is invalid.");
  }
  return {
    sessionId: requireString(record.session_id),
    traceId: requireString(record.trace_id),
    runId: optionalString(record.run_id),
    state: state as TurnCancellationValue["state"],
    terminal: requireBoolean(record.terminal),
  };
}

function approvalDecisionValue(value: unknown): ApprovalDecisionV1 {
  exactRecord(value, [
    "schema_version",
    "approval_id",
    "session_id",
    "trace_id",
    "call_id",
    "decision",
    "outcome",
    "resolved_at",
  ]);
  const record = value as JsonRecord;
  const decision = approvalDecision(record.decision);
  const outcome = requireString(record.outcome) as ApprovalDecisionV1["outcome"];
  if (
    record.schema_version !== 1 ||
    !new Set(["applied", "denied", "already_applied", "already_denied"]).has(outcome)
  ) {
    throw protocolError("invalid_daemon_response", "The daemon approval decision is invalid.");
  }
  return {
    schemaVersion: 1,
    approvalId: requireString(record.approval_id),
    sessionId: requireString(record.session_id),
    traceId: requireString(record.trace_id),
    callId: requireString(record.call_id),
    decision,
    outcome,
    resolvedAt: requireString(record.resolved_at),
  };
}

function mediaAttachment(value: unknown): MediaAttachmentV1 {
  exactRecord(value, [
    "schema_version",
    "media_id",
    "session_id",
    "name",
    "mime_type",
    "size_bytes",
    "kind",
    "turn_compatible",
    "expires_at",
  ]);
  const record = value as JsonRecord;
  const mimeType = requireString(record.mime_type);
  const kind = requireString(record.kind);
  const expiresAt = requireString(record.expires_at);
  const name = requireString(record.name);
  const sizeBytes = record.size_bytes;
  const image = mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
  const file =
    mimeType === "application/pdf" || mimeType === "text/plain" || mimeType === "application/json";
  if (
    record.schema_version !== 1 ||
    !/^[0-9a-f]{48}$/.test(requireString(record.media_id)) ||
    (!image && !file) ||
    kind !== (image ? "image" : "file") ||
    record.turn_compatible !== image ||
    !Number.isInteger(sizeBytes) ||
    Number(sizeBytes) < 1 ||
    Number(sizeBytes) > 10 * 1024 * 1024 ||
    !validMediaName(name) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  ) {
    throw protocolError("invalid_daemon_response", "The daemon media metadata is invalid.");
  }
  return {
    schemaVersion: 1,
    mediaId: requireString(record.media_id),
    sessionId: requireString(record.session_id),
    name,
    mimeType: mimeType as MediaAttachmentV1["mimeType"],
    sizeBytes: Number(sizeBytes),
    kind: kind as MediaAttachmentV1["kind"],
    turnCompatible: record.turn_compatible as boolean,
    expiresAt,
  };
}

function artifactCatalogItem(value: unknown): ArtifactCatalogItemV1 {
  exactRecord(value, [
    "schema_version",
    "artifact_id",
    "session_id",
    "kind",
    "display_name",
    "mime_type",
    "size_bytes",
    "created_at",
    "source",
    "state",
    "content_kind",
    "occurrence_count",
    "tool_name",
    "tool_status",
    "summary",
    "actions",
  ]);
  const record = value as JsonRecord;
  const artifactId = opaqueArtifactId(record.artifact_id, "invalid_daemon_response");
  const kind = requireString(record.kind);
  const source = requireString(record.source);
  const state = requireString(record.state);
  const contentKind = artifactContentKind(record.content_kind);
  const actions = artifactActions(record.actions);
  const sizeBytes = optionalInteger(record.size_bytes, 0, Number.MAX_SAFE_INTEGER);
  const occurrenceCount = requiredInteger(record.occurrence_count, 1, Number.MAX_SAFE_INTEGER);
  const displayName = boundedResponseString(record.display_name, 512);
  const mimeType = optionalBoundedResponseString(record.mime_type, 256);
  const createdAt = optionalBoundedResponseString(record.created_at, 128);
  const toolName = optionalBoundedResponseString(record.tool_name, 512);
  const toolStatus = optionalBoundedResponseString(record.tool_status, 256);
  const summary = optionalBoundedResponseString(record.summary, 4 * 1024);
  const artifactShape = kind === "artifact" && source === "attachment";
  const toolShape = kind === "tool_output" && source === "tool";
  const available = contentKind !== "unavailable";
  if (
    record.schema_version !== 1 ||
    (!artifactShape && !toolShape) ||
    !new Set(["active", "detached", "missing", "unsupported"]).has(state) ||
    (artifactShape && (toolName !== null || toolStatus !== null || summary !== null)) ||
    (toolShape && (toolName === null || toolStatus === null || summary === null)) ||
    (toolShape && (createdAt === null || displayName !== toolName)) ||
    (toolShape && (state !== "active" || occurrenceCount !== 1)) ||
    (toolShape &&
      mimeType !==
        (contentKind === "json" ? "application/json" : available ? "text/plain" : null)) ||
    (toolShape && (sizeBytes !== null) !== available) ||
    (toolShape && actions.some((action) => action !== "read")) ||
    (toolShape && contentKind === "unavailable" && actions.length !== 0) ||
    (artifactShape && !validArtifactStateActions(state, contentKind, actions))
  ) {
    throw protocolError("invalid_daemon_response", "The daemon artifact catalog item is invalid.");
  }
  return {
    schemaVersion: 1,
    artifactId,
    sessionId: boundedResponseString(record.session_id, 256),
    kind: kind as ArtifactCatalogItemV1["kind"],
    displayName,
    mimeType,
    sizeBytes,
    createdAt,
    source: source as ArtifactCatalogItemV1["source"],
    state: state as ArtifactCatalogItemV1["state"],
    contentKind,
    occurrenceCount,
    toolName,
    toolStatus,
    summary,
    actions,
  };
}

function artifactContent(value: unknown): ArtifactContentV1 {
  exactRecord(value, [
    "schema_version",
    "artifact_id",
    "session_id",
    "content_kind",
    "text",
    "complete",
    "next_cursor",
  ]);
  const record = value as JsonRecord;
  const contentKind = artifactContentKind(record.content_kind);
  const text = optionalBoundedResponseString(record.text, 64 * 1024);
  const complete = requireBoolean(record.complete);
  const nextCursor = optionalOpaqueResponse(record.next_cursor);
  if (
    record.schema_version !== 1 ||
    (contentKind === "unavailable" ? text !== null : text === null) ||
    (contentKind === "unavailable" && !complete) ||
    (complete ? nextCursor !== null : nextCursor === null)
  ) {
    throw protocolError("invalid_daemon_response", "The daemon artifact content is invalid.");
  }
  return {
    schemaVersion: 1,
    artifactId: opaqueArtifactId(record.artifact_id, "invalid_daemon_response"),
    sessionId: boundedResponseString(record.session_id, 256),
    contentKind,
    text,
    complete,
    nextCursor,
  };
}

function artifactDecisionValue(value: unknown): ArtifactDecisionValue {
  exactRecord(value, ["artifact_id", "session_id", "state", "outcome"]);
  const record = value as JsonRecord;
  if (
    (record.state !== "active" && record.state !== "detached") ||
    (record.outcome !== "applied" && record.outcome !== "already_applied")
  ) {
    throw protocolError("invalid_daemon_response", "The daemon artifact decision is invalid.");
  }
  return {
    artifactId: opaqueArtifactId(record.artifact_id, "invalid_daemon_response"),
    sessionId: boundedResponseString(record.session_id, 256),
    state: record.state,
    outcome: record.outcome,
  };
}

function decisionOutcomeMatches(
  decision: ApprovalDecision,
  outcome: ApprovalDecisionV1["outcome"],
): boolean {
  return decision === "allow_once"
    ? outcome === "applied" || outcome === "already_applied"
    : outcome === "denied" || outcome === "already_denied";
}

function validateCancellationResponse(status: number, cancellation: TurnCancellationValue): void {
  const active = status === 202 && cancellation.state === "requested" && !cancellation.terminal;
  const duplicate =
    status === 200 && cancellation.state === "already_requested" && !cancellation.terminal;
  const terminal =
    status === 200 &&
    cancellation.terminal &&
    ["completed", "failed", "cancelled"].includes(cancellation.state);
  if (!active && !duplicate && !terminal) {
    throw protocolError(
      "invalid_daemon_response",
      "The daemon cancellation status and state do not match.",
    );
  }
}

function requireSuccessEnvelope(payload: JsonRecord, keys: string[]): void {
  exactRecord(payload, keys);
  if (payload.ok !== true || !isRecord(payload.meta)) {
    throw protocolError("invalid_daemon_response", "The daemon success envelope is invalid.");
  }
}

function errorValue(value: unknown): ErrorV1 {
  const record = requireRecord(value);
  return {
    code: requireString(record.code),
    message: requireString(record.message),
    retryable: requireBoolean(record.retryable),
    retryAfterMs: optionalNumber(record.retry_after_ms),
  };
}

function errorFromPayload(payload: JsonRecord): ErrorV1 {
  if (payload.ok !== false || !isRecord(payload.error)) {
    return clientError("invalid_daemon_response", "The daemon error envelope is invalid.");
  }
  try {
    return errorValue(payload.error);
  } catch {
    return clientError("invalid_daemon_response", "The daemon error envelope is invalid.");
  }
}

function validateListInput(input: SessionListInput): SessionListInput {
  exactRecord(input, [], ["cursor", "limit"], "invalid_request");
  return { cursor: optionalInputString(input.cursor), limit: optionalLimit(input.limit, 100) };
}

function validateCreateInput(input: SessionCreateInput): SessionCreateInput {
  exactRecord(input, [], ["agentId", "title", "projectId"], "invalid_request");
  return {
    agentId: optionalInputString(input.agentId, 256),
    title: optionalInputString(input.title, 256),
    projectId: optionalInputString(input.projectId, 256),
  };
}

function validateLoadInput(input: SessionLoadInput): SessionLoadInput {
  exactRecord(input, ["sessionId"], ["messageAfter", "messageLimit"], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    messageAfter: optionalInputString(input.messageAfter),
    messageLimit: optionalLimit(input.messageLimit, 200),
  };
}

function validateCloseInput(input: SessionCloseInput): SessionCloseInput {
  exactRecord(input, ["sessionId"], ["reason"], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    reason: optionalInputString(input.reason, 256),
  };
}

function validateEventsInput(input: SessionEventsInput): SessionEventsInput {
  exactRecord(input, ["sessionId"], ["after", "limit"], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    after: optionalInputString(input.after),
    limit: optionalLimit(input.limit, 200),
  };
}

function validateSubmitInput(input: TurnSubmitInput): TurnSubmitInput {
  exactRecord(input, ["sessionId", "message"], ["attachmentIds", "observation"], "invalid_request");
  const value: TurnSubmitInput = {
    sessionId: inputString(input.sessionId, 256),
    message: messageInput(input.message),
  };
  const attachmentIds = optionalMediaIds(input.attachmentIds);
  const observation = optionalObservationIntent(input.observation);
  if (attachmentIds) value.attachmentIds = attachmentIds;
  if (observation) value.observation = observation;
  return value;
}

function optionalObservationIntent(value: unknown): TurnSubmitInput["observation"] {
  if (value === undefined) return undefined;
  exactRecord(value, ["includeCurrentView"], [], "invalid_request");
  if (value.includeCurrentView !== true) {
    throw protocolError("invalid_request", "The observation intent is invalid.");
  }
  return { includeCurrentView: true };
}

function validateMediaUpload(input: MediaUpload): MediaUpload {
  exactRecord(
    input,
    ["sessionId", "name", "mimeType", "sizeBytes", "stream"],
    ["signal"],
    "invalid_request",
  );
  const sessionId = inputString(input.sessionId, 256);
  const name = input.name;
  if (
    typeof name !== "string" ||
    !validMediaName(name) ||
    !new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
      "text/plain",
      "application/json",
    ]).has(input.mimeType) ||
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 10 * 1024 * 1024 ||
    typeof input.stream?.pipe !== "function" ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    throw protocolError("invalid_request", "The selected media is invalid.");
  }
  return { ...input, sessionId, name };
}

function validateMediaReleaseInput(input: MediaReleaseInput): MediaReleaseInput {
  exactRecord(input, ["sessionId", "mediaId"], [], "invalid_request");
  const mediaId = inputString(input.mediaId, 48);
  if (!/^[0-9a-f]{48}$/.test(mediaId)) {
    throw protocolError("invalid_request", "The selected media identifier is invalid.");
  }
  return { sessionId: inputString(input.sessionId, 256), mediaId };
}

function validateArtifactListInput(input: ArtifactListInput): ArtifactListInput {
  exactRecord(input, ["sessionId"], ["cursor", "limit"], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    cursor: optionalOpaqueCursor(input.cursor),
    limit: optionalLimit(input.limit, 100),
  };
}

function validateArtifactReadInput(input: ArtifactReadInput): ArtifactReadInput {
  exactRecord(input, ["sessionId", "artifactId"], ["cursor", "limitBytes"], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    artifactId: opaqueArtifactId(input.artifactId, "invalid_request"),
    cursor: optionalOpaqueCursor(input.cursor),
    limitBytes: optionalLimit(input.limitBytes, 64 * 1024),
  };
}

function validateArtifactDecisionInput(input: ArtifactDecisionInput): ArtifactDecisionInput {
  exactRecord(input, ["sessionId", "artifactId"], [], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    artifactId: opaqueArtifactId(input.artifactId, "invalid_request"),
  };
}

function optionalOpaqueCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return opaqueArtifactId(value, "invalid_request");
}

function opaqueArtifactId(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{48}$/.test(value)) {
    throw protocolError(errorCode, "The artifact identifier is invalid.");
  }
  return value;
}

function artifactContentKind(value: unknown): ArtifactContentKind {
  if (!new Set(["text", "json", "diff", "unavailable"]).has(value as string)) {
    throw protocolError("invalid_daemon_response", "The daemon artifact content kind is invalid.");
  }
  return value as ArtifactContentKind;
}

function artifactActions(value: unknown): ArtifactAction[] {
  const actions = requireArray(value);
  if (
    actions.some((action) => !new Set(["read", "detach", "restore"]).has(action as string)) ||
    new Set(actions).size !== actions.length ||
    actions.some((action, index) => index > 0 && String(actions[index - 1]) > String(action))
  ) {
    throw protocolError("invalid_daemon_response", "The daemon artifact actions are invalid.");
  }
  return actions as ArtifactAction[];
}

function validArtifactStateActions(
  state: string,
  contentKind: ArtifactContentKind,
  actions: ArtifactAction[],
): boolean {
  if (state === "missing" || state === "unsupported") {
    return contentKind === "unavailable" && actions.length === 0;
  }
  if (state === "active") {
    return contentKind !== "unavailable" && contentKind !== "diff" && !actions.includes("restore");
  }
  if (state === "detached") {
    return (
      contentKind !== "diff" &&
      !actions.includes("detach") &&
      (contentKind !== "unavailable" || !actions.includes("read"))
    );
  }
  return false;
}

function boundedResponseString(value: unknown, maxBytes: number): string {
  const text = requireString(value);
  if (Buffer.byteLength(text) > maxBytes || containsForbiddenArtifactText(text)) {
    throw protocolError("invalid_daemon_response", "The daemon response field exceeds its limit.");
  }
  return text;
}

function optionalBoundedResponseString(value: unknown, maxBytes: number): string | null {
  return value === null ? null : boundedResponseString(value, maxBytes);
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : requiredInteger(value, minimum, maximum);
}

function requiredInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw protocolError("invalid_daemon_response", "The daemon numeric response field is invalid.");
  }
  return Number(value);
}

function optionalOpaqueResponse(value: unknown): string | null {
  return value === null ? null : opaqueArtifactId(value, "invalid_daemon_response");
}

function containsForbiddenArtifactText(value: string): boolean {
  return (
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ||
    /artifact:\/\//i.test(value) ||
    /\b[a-f0-9]{64}\b/i.test(value) ||
    /(?:https?:\/\/)?(?:\blocalhost\b|\b127\.0\.0\.1\b|\[::1\])/i.test(value) ||
    /(^|[\s"'=([{])(?:\/[^\s"',)\]}]+|[A-Za-z]:[\\/][^\s"',)\]}]+|\\\\[^\s"',)\]}]+)/m.test(value)
  );
}

function safeArtifactError(error: ErrorV1): ErrorV1 {
  const messages: Record<string, string> = {
    invalid_request: "The artifact request is invalid.",
    forbidden: "The artifact request is not authorized.",
    session_not_found: "The session was not found.",
    session_closed: "The session is closed.",
    artifact_not_found: "The artifact was not found.",
    artifact_expired: "The artifact view expired. Refresh the catalog.",
    artifact_backpressure: "Too many artifact views are active. Try again later.",
    artifact_missing: "The artifact content is no longer available.",
    artifact_unsupported: "This artifact content cannot be displayed.",
    content_too_large: "This artifact content is too large to display.",
    cursor_expired: "The artifact page expired. Refresh the catalog.",
    event_invalid: "The artifact history could not be displayed safely.",
    artifact_state_too_large: "The artifact state is too large to display.",
    artifact_state_backpressure: "The artifact state is at capacity.",
    catalog_too_large: "The artifact catalog is too large to display.",
    session_turn_active: "Wait for the active turn to finish.",
    runtime_unavailable: "Artifact support is temporarily unavailable.",
    daemon_unavailable: "The local OpenMinion daemon is unavailable.",
    daemon_timeout: "The local OpenMinion daemon timed out.",
    response_too_large: "The daemon artifact response exceeded its limit.",
    invalid_daemon_response: "The daemon returned an invalid artifact response.",
  };
  const message = messages[error.code];
  if (!message) {
    return clientError(
      "invalid_daemon_response",
      "The daemon returned an invalid artifact response.",
    );
  }
  return { ...error, message };
}

function artifactErrorFromResponse(status: number, payload: JsonRecord): ErrorV1 {
  exactRecord(payload, ["ok", "error", "meta"]);
  if (payload.ok !== false || !isRecord(payload.meta)) {
    throw protocolError("invalid_daemon_response", "The daemon error envelope is invalid.");
  }
  exactRecord(payload.error, ["code", "message", "details", "retryable", "retry_after_ms"]);
  const error = payload.error as JsonRecord;
  if (!isRecord(error.details)) {
    throw protocolError("invalid_daemon_response", "The daemon error envelope is invalid.");
  }
  const value = {
    code: requireString(error.code),
    message: requireString(error.message),
    retryable: requireBoolean(error.retryable),
    retryAfterMs: optionalNumber(error.retry_after_ms),
  };
  const statuses: Record<string, number> = {
    invalid_request: 400,
    event_invalid: 400,
    forbidden: 403,
    session_not_found: 404,
    artifact_not_found: 404,
    artifact_missing: 404,
    session_closed: 409,
    session_turn_active: 409,
    artifact_expired: 410,
    cursor_expired: 410,
    content_too_large: 413,
    catalog_too_large: 413,
    artifact_state_too_large: 413,
    artifact_unsupported: 415,
    artifact_backpressure: 429,
    artifact_state_backpressure: 429,
    runtime_unavailable: 503,
  };
  if (statuses[value.code] !== status) {
    throw protocolError("invalid_daemon_response", "The daemon artifact error status is invalid.");
  }
  return value;
}

function optionalMediaIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw protocolError("invalid_request", "The desktop attachments are invalid.");
  }
  const ids = value.map((item) => {
    if (typeof item !== "string" || !/^[0-9a-f]{48}$/.test(item)) {
      throw protocolError("invalid_request", "The desktop attachments are invalid.");
    }
    return item;
  });
  if (new Set(ids).size !== ids.length) {
    throw protocolError("invalid_request", "The desktop attachments are invalid.");
  }
  return ids;
}

function validMediaName(value: string): boolean {
  return (
    Boolean(value) &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value) <= 128
  );
}

function messageInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > TURN_BODY_BYTES) {
    throw protocolError("invalid_request", "The desktop message is invalid.");
  }
  return value;
}

function validateCancelInput(input: TurnCancelInput): TurnCancelInput {
  exactRecord(input, ["sessionId", "traceId"], [], "invalid_request");
  return {
    sessionId: inputString(input.sessionId, 256),
    traceId: inputString(input.traceId, 256),
  };
}

function validateApprovalDecisionInput(input: ApprovalDecisionInput): ApprovalDecisionInput {
  exactRecord(input, ["sessionId", "traceId", "approvalId", "decision"], [], "invalid_request");
  if (input.decision !== "allow_once" && input.decision !== "deny") {
    throw protocolError("invalid_request", "The desktop approval decision is invalid.");
  }
  return {
    sessionId: inputString(input.sessionId, 256),
    traceId: inputString(input.traceId, 256),
    approvalId: inputString(input.approvalId, 256),
    decision: input.decision,
  };
}

function exactRecord(
  value: unknown,
  required: string[],
  optional: string[] = [],
  errorCode = "invalid_daemon_response",
): asserts value is JsonRecord {
  if (!isRecord(value)) {
    throw protocolError(errorCode, "Fields do not match the desktop protocol.");
  }
  const record = value;
  const admitted = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !admitted.has(key))
  ) {
    throw protocolError(errorCode, "Fields do not match the desktop protocol.");
  }
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw protocolError("invalid_daemon_response", "Expected an object response.");
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw protocolError("invalid_daemon_response", "Expected an array response.");
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw protocolError("invalid_daemon_response", "Expected a string response field.");
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw protocolError("invalid_daemon_response", "Expected a boolean response field.");
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError("invalid_daemon_response", "Expected a numeric response field.");
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === null) {
    return null;
  }
  return requireBoolean(value);
}

function approvalDecision(value: unknown, nullable: true): ApprovalDecision | null;
function approvalDecision(value: unknown, nullable?: false): ApprovalDecision;
function approvalDecision(value: unknown, nullable = false): ApprovalDecision | null {
  if (nullable && value === null) {
    return null;
  }
  if (value !== "allow_once" && value !== "deny") {
    throw protocolError("invalid_daemon_response", "The daemon approval decision is invalid.");
  }
  return value;
}

function boundedArgumentKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw protocolError("invalid_daemon_response", "The daemon argument keys are invalid.");
  }
  const keys = value.map((key) => {
    if (typeof key !== "string" || Buffer.byteLength(key) > 256) {
      throw protocolError("invalid_daemon_response", "The daemon argument keys are invalid.");
    }
    return key;
  });
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => index > 0 && keys[index - 1] > key) ||
    Buffer.byteLength(JSON.stringify(keys)) > 8 * 1024
  ) {
    throw protocolError("invalid_daemon_response", "The daemon argument keys are invalid.");
  }
  return keys;
}

function inputString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim()) > maxBytes) {
    throw protocolError("invalid_request", "A required desktop field is invalid.");
  }
  return value.trim();
}

function optionalInputString(value: unknown, maxBytes = 16 * 1024): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return inputString(value, maxBytes);
}

function optionalLimit(value: unknown, maximum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw protocolError("invalid_request", "The desktop page limit is invalid.");
  }
  return Number(value);
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function snakeCaseDefined(values: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function isScalarEventFact(value: unknown): value is Exclude<SessionEventFact, readonly string[]> {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

class ClientFailure extends Error {
  readonly clientError: ErrorV1;

  constructor(error: ErrorV1) {
    super(error.code);
    this.clientError = error;
  }
}

function protocolError(code: string, message: string, retryable = false): ClientFailure {
  return new ClientFailure(clientError(code, message, retryable));
}

function clientError(
  code: string,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): ErrorV1 {
  return { code, message, retryable, retryAfterMs };
}

function failure(code: string, message: string, retryable = false): ClientFailureResult {
  return { ok: false, error: clientError(code, message, retryable) };
}

function failureFrom(_error: unknown): ClientFailureResult {
  const error = _error;
  if (error instanceof ClientFailure) {
    return { ok: false, error: error.clientError };
  }
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return failure("invalid_daemon_response", "The daemon returned an invalid response.");
  }
  if (error instanceof Error && error.message === "daemon_timeout") {
    return failure("daemon_timeout", "The local OpenMinion daemon timed out.", true);
  }
  return failure("daemon_unavailable", "The local OpenMinion daemon is unavailable.", true);
}

function failureFromPayload(payload: JsonRecord): ClientFailureResult {
  return { ok: false, error: errorFromPayload(payload) };
}

function resolveOnce<T>(result: ClientResult<T>, resolve: (result: ClientResult<T>) => void): void {
  resolve(result);
}

export {
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
  protocolError,
  failure,
  failureFrom,
};
