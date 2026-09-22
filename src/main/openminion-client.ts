import type {
  ErrorV1,
  SessionCloseInput,
  SessionCreateInput,
  SessionEventsInput,
  SessionListInput,
  SessionLoadInput,
  TurnCancelInput,
  TurnResponseV1,
  TurnSubmitInput,
  TurnSubmitValue,
  TurnUsageDisplay,
} from "../shared/contracts.js";

const TURN_BODY_BYTES = 256 * 1024;

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

type JsonRecord = Record<string, unknown>;
type ClientFailureResult = { ok: false; error: ErrorV1 };

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

function turnUsageDisplay(value: unknown): TurnUsageDisplay {
  if (value === undefined) return "total";
  if (!new Set(["off", "total", "input_output", "input_output_calls"]).has(String(value))) {
    throw protocolError("invalid_daemon_response", "The turn usage display is invalid.");
  }
  return value as TurnUsageDisplay;
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
  usageValue,
  turnUsageDisplay,
  errorValue,
  protocolError,
  failure,
  failureFrom,
};
