import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1 as const;

export const ERROR_MESSAGES = {
  invalid_action: "The action request is invalid.",
  unsupported_action: "The action is not supported.",
  approval_required: "Current approval is required.",
  approval_mismatch: "The approval does not match the action.",
  grant_required: "A current desktop grant is required.",
  grant_revoked: "The desktop grant is not active.",
  permission_revoked: "The required system permission is not active.",
  frame_stale: "The grounded frame is no longer current.",
  target_changed: "The action target has changed.",
  executor_unavailable: "The desktop executor is unavailable.",
  expired: "The action has expired.",
  replay_conflict: "The action identity conflicts with an earlier request.",
  cancelled: "The action was cancelled.",
  result_conflict: "The action result conflicts with terminal state.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;
export type Risk = "low" | "medium" | "high" | "critical";
export type ActionKind = "pointer_move" | "click" | "scroll" | "key_press" | "wait";
export type Capability =
  | "computer.pointer"
  | "computer.click"
  | "computer.scroll"
  | "computer.keyboard"
  | "computer.wait";
export type CancellationReason =
  | "user_stop"
  | "session_cancel"
  | "grant_revoked"
  | "permission_revoked"
  | "source_changed"
  | "app_shutdown"
  | "expired";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ActionErrorV1 = DeepReadonly<{
  schema_version?: never;
  code: ErrorCode;
  message: string;
}>;
export type ActionTargetV1 = DeepReadonly<{
  capture_id: string;
  frame_id: string;
  source_kind: "display" | "region";
  parent_source_kind: "display";
  frame_width: number;
  frame_height: number;
  scale_millis: number;
  frame_captured_at: string;
  frame_expires_at: string;
}>;
export type ComputerActionV1 = DeepReadonly<
  | { kind: "pointer_move"; x_bps: number; y_bps: number; duration_ms: number }
  | {
      kind: "click";
      x_bps: number;
      y_bps: number;
      button: "left" | "right" | "middle";
      count: 1 | 2;
    }
  | { kind: "scroll"; delta_x_bps: number; delta_y_bps: number }
  | { kind: "key_press"; keys: string[]; modifiers: string[] }
  | { kind: "wait"; duration_ms: number }
>;
export type ActionIntentV1 = DeepReadonly<{
  schema_version: 1;
  action: ComputerActionV1;
  requested_risk: Risk;
}>;
export type ActionIdentityV1 = DeepReadonly<{
  schema_version: 1;
  action_id: string;
  idempotency_key: string;
  daemon_id: string;
  desktop_client_id: string;
  user_id: string;
  session_id: string;
  trace_id: string;
  turn_id: string;
  tool_call_id: string;
  actor_id: string;
}>;
export type ActionInvocationV1 = DeepReadonly<
  ActionIdentityV1 & {
    actor_kind: "agent";
    capability: Capability;
    target: ActionTargetV1;
    action: ComputerActionV1;
    requested_at: string;
    expires_at: string;
    requested_risk: Risk;
    effective_risk: "high" | "critical";
    approval_mode: "approve_each";
    approval_id: string;
  }
>;
export type CapabilityStateV1 = DeepReadonly<{
  schema_version: 1;
  daemon_id: string;
  desktop_client_id: string;
  user_id: string;
  session_id: string;
  capability: Capability;
  availability: "unavailable" | "available" | "revoked";
  reason:
    | "available"
    | "unsupported"
    | "permission_missing"
    | "permission_revoked"
    | "user_paused"
    | "session_closed"
    | "client_disconnected";
  observed_at: string;
}>;
export type DesktopGrantV1 = DeepReadonly<{
  schema_version: 1;
  grant_id: string;
  daemon_id: string;
  desktop_client_id: string;
  user_id: string;
  session_id: string;
  actor_id: string;
  actor_kind: "agent";
  capabilities: Capability[];
  action_kinds: ActionKind[];
  target: ActionTargetV1;
  issued_at: string;
  expires_at: string;
  state: "active" | "revoked" | "expired";
  revoked_at: string | null;
  revocation_reason:
    | "user_stop"
    | "session_cancel"
    | "daemon_disconnect"
    | "permission_revoked"
    | "source_changed"
    | "app_shutdown"
    | "expired"
    | null;
}>;
export type ActionAcknowledgementV1 = DeepReadonly<
  ActionIdentityV1 & {
    state: "accepted" | "rejected";
    acknowledged_at: string;
    error: ActionErrorV1 | null;
  }
>;
export type ActionCancellationV1 = DeepReadonly<
  ActionIdentityV1 & {
    reason: CancellationReason;
    requested_at: string;
  }
>;
export type ActionDispatchFactV1 = DeepReadonly<
  ActionIdentityV1 & {
    kind: "dispatched";
    dispatched_at: string;
  }
>;
export type ActionExpireFactV1 = DeepReadonly<
  ActionIdentityV1 & {
    kind: "expire";
    observed_at: string;
  }
>;
export type ActionControlFactV1 = DeepReadonly<
  ActionIdentityV1 & {
    kind: "disconnect" | "restart" | "executor_unavailable";
    observed_at: string;
  }
>;
export type ActionResultV1 = DeepReadonly<
  ActionIdentityV1 & {
    state: "interrupted_before_delivery" | "delivered" | "outcome_unknown";
    started_at: string;
    ended_at: string;
    duration_ms: number;
    post_action_frame_id: string | null;
    error: ActionErrorV1 | null;
  }
>;
export type ActionFactV1 =
  | ActionAcknowledgementV1
  | ActionCancellationV1
  | ActionDispatchFactV1
  | ActionExpireFactV1
  | ActionControlFactV1
  | ActionResultV1;
export type ActionRecordV1 = DeepReadonly<{
  schema_version: 1;
  invocation: ActionInvocationV1;
  invocation_hash: string;
  phase: "pending" | "dispatched" | "accepted" | "cancel_requested" | "terminal";
  pre_cancel_phase: "dispatched" | "accepted" | null;
  dispatch: ActionDispatchFactV1 | null;
  acknowledgement: ActionAcknowledgementV1 | null;
  cancellation: ActionCancellationV1 | null;
  expiry: ActionExpireFactV1 | null;
  control: ActionControlFactV1 | null;
  result: ActionResultV1 | null;
  terminal_state:
    | "rejected"
    | "interrupted_before_delivery"
    | "delivered"
    | "outcome_unknown"
    | null;
  error: ActionErrorV1 | null;
  created_at: string;
  updated_at: string;
}>;
export type ActionAuditProjectionV1 = DeepReadonly<{
  schema_version: 1;
  action_id: string;
  session_id: string;
  trace_id: string;
  turn_id: string;
  tool_call_id: string;
  actor_kind: "agent";
  capability: Capability;
  action_kind: ActionKind;
  source_kind: "display" | "region";
  requested_risk: Risk;
  effective_risk: "high" | "critical";
  approval_mode: "approve_each";
  approval_present: true;
  phase: ActionRecordV1["phase"];
  terminal_state: ActionRecordV1["terminal_state"];
  error_code: ErrorCode | null;
  requested_at: string;
  acknowledged_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}>;
export type AppliedApprovalFactV1 = DeepReadonly<{
  approval_id: string;
  session_id: string;
  trace_id: string;
  tool_call_id: string;
  actor_id: string;
  state: "applied";
}>;
export type TrustedActionContextV1 = DeepReadonly<{
  action_id: string;
  idempotency_key: string;
  daemon_id: string;
  desktop_client_id: string;
  user_id: string;
  session_id: string;
  trace_id: string;
  turn_id: string;
  tool_call_id: string;
  actor_id: string;
  actor_kind: "agent";
  target: ActionTargetV1;
  requested_at: string;
  expires_at: string;
  approval: AppliedApprovalFactV1 | null;
  registered_risk_floor: "high";
}>;

export class ComputerActionContractError extends Error {
  readonly code: ErrorCode;
  readonly error: ActionErrorV1;
  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ComputerActionContractError";
    this.code = code;
    this.error = immutable({ code, message: ERROR_MESSAGES[code] });
  }
}

const CAPABILITY_BY_ACTION: Record<ActionKind, Capability> = {
  pointer_move: "computer.pointer",
  click: "computer.click",
  scroll: "computer.scroll",
  key_press: "computer.keyboard",
  wait: "computer.wait",
};
const ACTION_KINDS = Object.keys(CAPABILITY_BY_ACTION) as ActionKind[];
const CAPABILITIES = Object.values(CAPABILITY_BY_ACTION);
const RISKS: Risk[] = ["low", "medium", "high", "critical"];
const IDENTITY_KEYS = [
  "schema_version",
  "action_id",
  "idempotency_key",
  "daemon_id",
  "desktop_client_id",
  "user_id",
  "session_id",
  "trace_id",
  "turn_id",
  "tool_call_id",
  "actor_id",
] as const;
const KEY_TOKENS = new Set([
  "backspace",
  "delete",
  "end",
  "enter",
  "escape",
  "home",
  "page_down",
  "page_up",
  "space",
  "tab",
  "arrow_down",
  "arrow_left",
  "arrow_right",
  "arrow_up",
]);
const MODIFIERS = new Set(["alt", "control", "meta", "shift"]);
const PYTHON_WHITESPACE_ONLY =
  /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const GRANT_REVOCATION_REASONS = [
  "user_stop",
  "session_cancel",
  "daemon_disconnect",
  "permission_revoked",
  "source_changed",
  "app_shutdown",
  "expired",
] as const;

function fail(code: ErrorCode): never {
  throw new ComputerActionContractError(code);
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      immutable(child);
    }
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_action");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("invalid_action");
}
function oneOf<T extends string>(value: unknown, admitted: readonly T[]): T {
  if (typeof value !== "string" || !admitted.includes(value as T)) fail("invalid_action");
  return value as T;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
    fail("invalid_action");
  return value as number;
}
function identity(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    PYTHON_WHITESPACE_ONLY.test(value) ||
    Buffer.byteLength(value, "utf8") > maximum ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    fail("invalid_action");
  return value;
}
function hex(value: unknown, size: 48 | 64): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${size}}$`, "u").test(value))
    fail("invalid_action");
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.startsWith("0000-") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    fail("invalid_action");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail("invalid_action");
  return value;
}
function injectedTimestamp(value: unknown): string {
  try {
    return timestamp(value);
  } catch {
    fail("result_conflict");
  }
}
function time(value: string): number {
  return Date.parse(value);
}
function errorValue(value: unknown): ActionErrorV1 {
  const raw = object(value);
  exact(raw, ["code", "message"]);
  const code = oneOf(raw.code, Object.keys(ERROR_MESSAGES) as ErrorCode[]);
  if (raw.message !== ERROR_MESSAGES[code]) fail("invalid_action");
  return immutable({ code, message: ERROR_MESSAGES[code] });
}
function nullableError(value: unknown): ActionErrorV1 | null {
  return value === null ? null : errorValue(value);
}

function parseAction(value: unknown): ComputerActionV1 {
  const raw = object(value);
  const kind = raw.kind;
  if (
    kind === "text_entry" ||
    kind === "computer.text" ||
    (typeof kind === "string" && !ACTION_KINDS.includes(kind as ActionKind))
  )
    fail("unsupported_action");
  const admitted = oneOf(kind, ACTION_KINDS);
  if (admitted === "pointer_move") {
    exact(raw, ["kind", "x_bps", "y_bps", "duration_ms"]);
    return {
      kind: admitted,
      x_bps: integer(raw.x_bps, 0, 10000),
      y_bps: integer(raw.y_bps, 0, 10000),
      duration_ms: integer(raw.duration_ms, 0, 2000),
    };
  }
  if (admitted === "click") {
    exact(raw, ["kind", "x_bps", "y_bps", "button", "count"]);
    return {
      kind: admitted,
      x_bps: integer(raw.x_bps, 0, 10000),
      y_bps: integer(raw.y_bps, 0, 10000),
      button: oneOf(raw.button, ["left", "right", "middle"]),
      count: integer(raw.count, 1, 2) as 1 | 2,
    };
  }
  if (admitted === "scroll") {
    exact(raw, ["kind", "delta_x_bps", "delta_y_bps"]);
    const delta_x_bps = integer(raw.delta_x_bps, -10000, 10000);
    const delta_y_bps = integer(raw.delta_y_bps, -10000, 10000);
    if (delta_x_bps === 0 && delta_y_bps === 0) fail("invalid_action");
    return { kind: admitted, delta_x_bps, delta_y_bps };
  }
  if (admitted === "key_press") {
    exact(raw, ["kind", "keys", "modifiers"]);
    if (
      !Array.isArray(raw.keys) ||
      raw.keys.length < 1 ||
      raw.keys.length > 4 ||
      raw.keys.some(
        (key) => typeof key !== "string" || (!/^[a-z0-9]$/u.test(key) && !KEY_TOKENS.has(key)),
      )
    )
      fail("invalid_action");
    if (
      !Array.isArray(raw.modifiers) ||
      raw.modifiers.some((item) => typeof item !== "string" || !MODIFIERS.has(item))
    )
      fail("invalid_action");
    const modifiers = raw.modifiers as string[];
    if (modifiers.join("\0") !== [...new Set(modifiers)].sort().join("\0")) fail("invalid_action");
    return {
      kind: admitted,
      keys: [...raw.keys] as string[],
      modifiers: [...modifiers],
    };
  }
  exact(raw, ["kind", "duration_ms"]);
  return { kind: "wait", duration_ms: integer(raw.duration_ms, 1, 5000) };
}

export function parseActionIntent(
  payload: string | Uint8Array | Record<string, unknown>,
): ActionIntentV1 {
  let value: unknown;
  try {
    value =
      typeof payload === "string" || payload instanceof Uint8Array
        ? new JsonParser(
            typeof payload === "string"
              ? payload
              : new TextDecoder("utf-8", { fatal: true }).decode(payload),
          ).parse()
        : { ...payload };
  } catch {
    fail("invalid_action");
  }
  const raw = object(value);
  exact(raw, ["schema_version", "action", "requested_risk"]);
  if (raw.schema_version !== 1) fail("invalid_action");
  return immutable({
    schema_version: 1,
    action: parseAction(raw.action),
    requested_risk: oneOf(raw.requested_risk, RISKS),
  });
}

export function parseActionTarget(value: unknown): ActionTargetV1 {
  const raw = object(value);
  exact(raw, [
    "capture_id",
    "frame_id",
    "source_kind",
    "parent_source_kind",
    "frame_width",
    "frame_height",
    "scale_millis",
    "frame_captured_at",
    "frame_expires_at",
  ]);
  const target: ActionTargetV1 = {
    capture_id: hex(raw.capture_id, 48),
    frame_id: hex(raw.frame_id, 48),
    source_kind: oneOf(raw.source_kind, ["display", "region"]),
    parent_source_kind: oneOf(raw.parent_source_kind, ["display"]),
    frame_width: integer(raw.frame_width, 64, 7680),
    frame_height: integer(raw.frame_height, 64, 7680),
    scale_millis: integer(raw.scale_millis, 500, 4000),
    frame_captured_at: timestamp(raw.frame_captured_at),
    frame_expires_at: timestamp(raw.frame_expires_at),
  };
  if (time(target.frame_captured_at) >= time(target.frame_expires_at)) fail("invalid_action");
  return immutable(target);
}

function parseIdentity(raw: Record<string, unknown>): ActionIdentityV1 {
  return {
    schema_version: raw.schema_version === 1 ? 1 : fail("invalid_action"),
    action_id: hex(raw.action_id, 48),
    idempotency_key: hex(raw.idempotency_key, 64),
    daemon_id: identity(raw.daemon_id, 128),
    desktop_client_id: identity(raw.desktop_client_id, 128),
    user_id: identity(raw.user_id, 128),
    session_id: identity(raw.session_id, 256),
    trace_id: identity(raw.trace_id, 128),
    turn_id: identity(raw.turn_id, 128),
    tool_call_id: identity(raw.tool_call_id, 128),
    actor_id: identity(raw.actor_id, 128),
  };
}
function identityPart(value: ActionIdentityV1): Record<string, unknown> {
  return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, value[key]]));
}

export function parseActionInvocation(value: unknown): ActionInvocationV1 {
  const raw = object(value);
  exact(raw, [
    ...IDENTITY_KEYS,
    "actor_kind",
    "capability",
    "target",
    "action",
    "requested_at",
    "expires_at",
    "requested_risk",
    "effective_risk",
    "approval_mode",
    "approval_id",
  ]);
  const base = parseIdentity(raw);
  const action = parseAction(raw.action);
  const target = parseActionTarget(raw.target);
  const requested_at = timestamp(raw.requested_at);
  const expires_at = timestamp(raw.expires_at);
  const requested_risk = oneOf(raw.requested_risk, RISKS);
  const invocation: ActionInvocationV1 = {
    ...base,
    actor_kind: oneOf(raw.actor_kind, ["agent"]),
    capability: oneOf(raw.capability, CAPABILITIES),
    target,
    action,
    requested_at,
    expires_at,
    requested_risk,
    effective_risk: oneOf(raw.effective_risk, ["high", "critical"]),
    approval_mode: oneOf(raw.approval_mode, ["approve_each"]),
    approval_id: identity(raw.approval_id, 128),
  };
  if (
    invocation.capability !== CAPABILITY_BY_ACTION[action.kind] ||
    invocation.effective_risk !== (requested_risk === "critical" ? "critical" : "high")
  )
    fail("invalid_action");
  if (
    !(time(requested_at) < time(expires_at)) ||
    time(expires_at) - time(requested_at) > 5000 ||
    !(
      time(target.frame_captured_at) < time(requested_at) &&
      time(requested_at) < time(target.frame_expires_at)
    ) ||
    time(requested_at) - time(target.frame_captured_at) > 30000 ||
    time(expires_at) > time(target.frame_expires_at)
  )
    fail("invalid_action");
  return immutable(invocation);
}

export function buildActionInvocation(
  intent: ActionIntentV1 | Record<string, unknown>,
  context: TrustedActionContextV1,
): ActionInvocationV1 {
  const parsed =
    "schema_version" in intent && "action" in intent
      ? parseActionIntent(intent as Record<string, unknown>)
      : fail("invalid_action");
  const ids = [
    context.daemon_id,
    context.desktop_client_id,
    context.user_id,
    context.trace_id,
    context.turn_id,
    context.tool_call_id,
    context.actor_id,
  ];
  ids.forEach((item) => {
    identity(item, 128);
  });
  identity(context.session_id, 256);
  hex(context.action_id, 48);
  hex(context.idempotency_key, 64);
  timestamp(context.requested_at);
  timestamp(context.expires_at);
  if (context.actor_kind !== "agent" || context.registered_risk_floor !== "high")
    fail("invalid_action");
  const approval = context.approval;
  if (approval === null) fail("approval_required");
  let approvalId: string;
  try {
    approvalId = identity(approval.approval_id, 128);
  } catch {
    fail("approval_mismatch");
  }
  if (
    approval.state !== "applied" ||
    approval.session_id !== context.session_id ||
    approval.trace_id !== context.trace_id ||
    approval.tool_call_id !== context.tool_call_id ||
    approval.actor_id !== context.actor_id
  )
    fail("approval_mismatch");
  return parseActionInvocation({
    schema_version: 1,
    action_id: context.action_id,
    idempotency_key: context.idempotency_key,
    daemon_id: context.daemon_id,
    desktop_client_id: context.desktop_client_id,
    user_id: context.user_id,
    session_id: context.session_id,
    trace_id: context.trace_id,
    turn_id: context.turn_id,
    tool_call_id: context.tool_call_id,
    actor_id: context.actor_id,
    actor_kind: "agent",
    capability: CAPABILITY_BY_ACTION[parsed.action.kind],
    target: context.target,
    action: parsed.action,
    requested_at: context.requested_at,
    expires_at: context.expires_at,
    requested_risk: parsed.requested_risk,
    effective_risk: parsed.requested_risk === "critical" ? "critical" : "high",
    approval_mode: "approve_each",
    approval_id: approvalId,
  });
}

export function parseCapabilityState(value: unknown): CapabilityStateV1 {
  const raw = object(value);
  exact(raw, [
    "schema_version",
    "daemon_id",
    "desktop_client_id",
    "user_id",
    "session_id",
    "capability",
    "availability",
    "reason",
    "observed_at",
  ]);
  const state: CapabilityStateV1 = {
    schema_version: raw.schema_version === 1 ? 1 : fail("invalid_action"),
    daemon_id: identity(raw.daemon_id, 128),
    desktop_client_id: identity(raw.desktop_client_id, 128),
    user_id: identity(raw.user_id, 128),
    session_id: identity(raw.session_id, 256),
    capability: oneOf(raw.capability, CAPABILITIES),
    availability: oneOf(raw.availability, ["unavailable", "available", "revoked"]),
    reason: oneOf(raw.reason, [
      "available",
      "unsupported",
      "permission_missing",
      "permission_revoked",
      "user_paused",
      "session_closed",
      "client_disconnected",
    ]),
    observed_at: timestamp(raw.observed_at),
  };
  const admitted =
    state.availability === "available"
      ? ["available"]
      : state.availability === "unavailable"
        ? [
            "unsupported",
            "permission_missing",
            "user_paused",
            "session_closed",
            "client_disconnected",
          ]
        : ["permission_revoked", "user_paused", "session_closed", "client_disconnected"];
  if (!admitted.includes(state.reason)) fail("invalid_action");
  return immutable(state);
}

export function parseDesktopGrant(value: unknown): DesktopGrantV1 {
  const raw = object(value);
  exact(raw, [
    "schema_version",
    "grant_id",
    "daemon_id",
    "desktop_client_id",
    "user_id",
    "session_id",
    "actor_id",
    "actor_kind",
    "capabilities",
    "action_kinds",
    "target",
    "issued_at",
    "expires_at",
    "state",
    "revoked_at",
    "revocation_reason",
  ]);
  if (!Array.isArray(raw.capabilities) || !Array.isArray(raw.action_kinds)) fail("invalid_action");
  const capabilities = raw.capabilities.map((item) => oneOf(item, CAPABILITIES));
  const action_kinds = raw.action_kinds.map((item) => oneOf(item, ACTION_KINDS));
  if (
    capabilities.length === 0 ||
    action_kinds.length === 0 ||
    capabilities.join("\0") !== [...new Set(capabilities)].sort().join("\0") ||
    action_kinds.join("\0") !== [...new Set(action_kinds)].sort().join("\0") ||
    action_kinds
      .map((kind) => CAPABILITY_BY_ACTION[kind])
      .sort()
      .join("\0") !== capabilities.join("\0")
  )
    fail("invalid_action");
  const grant: DesktopGrantV1 = {
    schema_version: raw.schema_version === 1 ? 1 : fail("invalid_action"),
    grant_id: hex(raw.grant_id, 48),
    daemon_id: identity(raw.daemon_id, 128),
    desktop_client_id: identity(raw.desktop_client_id, 128),
    user_id: identity(raw.user_id, 128),
    session_id: identity(raw.session_id, 256),
    actor_id: identity(raw.actor_id, 128),
    actor_kind: oneOf(raw.actor_kind, ["agent"]),
    capabilities,
    action_kinds,
    target: parseActionTarget(raw.target),
    issued_at: timestamp(raw.issued_at),
    expires_at: timestamp(raw.expires_at),
    state: oneOf(raw.state, ["active", "revoked", "expired"]),
    revoked_at: raw.revoked_at === null ? null : timestamp(raw.revoked_at),
    revocation_reason:
      raw.revocation_reason === null
        ? null
        : oneOf(raw.revocation_reason, GRANT_REVOCATION_REASONS),
  };
  const lifetime = time(grant.expires_at) - time(grant.issued_at);
  if (
    lifetime < 1 ||
    lifetime > 30000 ||
    time(grant.expires_at) > time(grant.target.frame_expires_at)
  )
    fail("invalid_action");
  if (
    grant.state === "active"
      ? grant.revoked_at !== null || grant.revocation_reason !== null
      : grant.state === "revoked"
        ? grant.revoked_at === null ||
          time(grant.revoked_at) < time(grant.issued_at) ||
          time(grant.revoked_at) >= time(grant.expires_at) ||
          grant.revocation_reason === null ||
          grant.revocation_reason === "expired"
        : grant.revoked_at === null ||
          time(grant.revoked_at) < time(grant.expires_at) ||
          grant.revocation_reason !== "expired"
  )
    fail("invalid_action");
  return immutable(grant);
}

export function matchDesktopGrant(
  invocation: ActionInvocationV1,
  grant: DesktopGrantV1 | null,
  now: string,
): DesktopGrantV1 {
  now = injectedTimestamp(now);
  invocation = parseActionInvocation(invocation);
  if (grant === null) fail("grant_required");
  grant = parseDesktopGrant(grant);
  const same = [
    "daemon_id",
    "desktop_client_id",
    "user_id",
    "session_id",
    "actor_id",
    "actor_kind",
  ] as const;
  if (
    same.some((key) => grant[key] !== invocation[key]) ||
    canonicalJson(grant.target) !== canonicalJson(invocation.target) ||
    !grant.capabilities.includes(invocation.capability) ||
    !grant.action_kinds.includes(invocation.action.kind)
  )
    fail("grant_required");
  if (
    grant.state !== "active" ||
    time(now) < time(grant.issued_at) ||
    time(now) >= time(grant.expires_at)
  )
    fail("grant_revoked");
  if (time(now) >= time(invocation.expires_at)) fail("expired");
  return grant;
}

function parseFactBase(
  value: unknown,
  extra: readonly string[],
): [Record<string, unknown>, ActionIdentityV1] {
  const raw = object(value);
  exact(raw, [...IDENTITY_KEYS, ...extra]);
  return [raw, parseIdentity(raw)];
}
export function parseAcknowledgement(value: unknown): ActionAcknowledgementV1 {
  const [raw, base] = parseFactBase(value, ["state", "acknowledged_at", "error"]);
  const state = oneOf(raw.state, ["accepted", "rejected"]);
  const error = nullableError(raw.error);
  if (
    (state === "accepted") !== (error === null) ||
    (state === "rejected" &&
      error !== null &&
      ![
        "grant_required",
        "grant_revoked",
        "permission_revoked",
        "frame_stale",
        "target_changed",
        "executor_unavailable",
        "expired",
      ].includes(error.code))
  )
    fail("invalid_action");
  return immutable({
    ...base,
    state,
    acknowledged_at: timestamp(raw.acknowledged_at),
    error,
  });
}
export function parseCancellation(value: unknown): ActionCancellationV1 {
  const [raw, base] = parseFactBase(value, ["reason", "requested_at"]);
  return immutable({
    ...base,
    reason: oneOf(raw.reason, [
      "user_stop",
      "session_cancel",
      "grant_revoked",
      "permission_revoked",
      "source_changed",
      "app_shutdown",
      "expired",
    ]),
    requested_at: timestamp(raw.requested_at),
  });
}
export function parseDispatch(value: unknown): ActionDispatchFactV1 {
  const [raw, base] = parseFactBase(value, ["kind", "dispatched_at"]);
  return immutable({
    ...base,
    kind: oneOf(raw.kind, ["dispatched"]),
    dispatched_at: timestamp(raw.dispatched_at),
  });
}
export function parseExpiry(value: unknown): ActionExpireFactV1 {
  const [raw, base] = parseFactBase(value, ["kind", "observed_at"]);
  return immutable({
    ...base,
    kind: oneOf(raw.kind, ["expire"]),
    observed_at: timestamp(raw.observed_at),
  });
}
export function parseControl(value: unknown): ActionControlFactV1 {
  const [raw, base] = parseFactBase(value, ["kind", "observed_at"]);
  return immutable({
    ...base,
    kind: oneOf(raw.kind, ["disconnect", "restart", "executor_unavailable"]),
    observed_at: timestamp(raw.observed_at),
  });
}
export function parseResult(value: unknown): ActionResultV1 {
  const [raw, base] = parseFactBase(value, [
    "state",
    "started_at",
    "ended_at",
    "duration_ms",
    "post_action_frame_id",
    "error",
  ]);
  const state = oneOf(raw.state, ["interrupted_before_delivery", "delivered", "outcome_unknown"]);
  const started_at = timestamp(raw.started_at);
  const ended_at = timestamp(raw.ended_at);
  const duration_ms = integer(raw.duration_ms, 0, 30000);
  const error = nullableError(raw.error);
  const post_action_frame_id =
    raw.post_action_frame_id === null ? null : hex(raw.post_action_frame_id, 48);
  if (
    time(ended_at) - time(started_at) !== duration_ms ||
    (state === "delivered" ? error !== null : post_action_frame_id !== null) ||
    (state === "interrupted_before_delivery" &&
      (error === null ||
        ![
          "cancelled",
          "grant_revoked",
          "permission_revoked",
          "frame_stale",
          "target_changed",
          "expired",
          "executor_unavailable",
        ].includes(error.code))) ||
    (state === "outcome_unknown" && error?.code !== "executor_unavailable")
  )
    fail("invalid_action");
  return immutable({
    ...base,
    state,
    started_at,
    ended_at,
    duration_ms,
    post_action_frame_id,
    error,
  });
}

function parseFact(value: unknown): ActionFactV1 {
  const raw = object(value);
  if ("dispatched_at" in raw) return parseDispatch(raw);
  if ("acknowledged_at" in raw) return parseAcknowledgement(raw);
  if ("requested_at" in raw) return parseCancellation(raw);
  if ("ended_at" in raw) return parseResult(raw);
  if (raw.kind === "expire") return parseExpiry(raw);
  return parseControl(raw);
}

function factIdentity(value: ActionIdentityV1): unknown[] {
  return IDENTITY_KEYS.map((key) => value[key]);
}
function sameFactIdentity(left: ActionIdentityV1, right: ActionIdentityV1): boolean {
  return canonicalJson(factIdentity(left)) === canonicalJson(factIdentity(right));
}
function cancellationError(reason: CancellationReason): ActionErrorV1 {
  const code: ErrorCode =
    reason === "user_stop" || reason === "session_cancel" || reason === "app_shutdown"
      ? "cancelled"
      : reason === "source_changed"
        ? "target_changed"
        : reason;
  return immutable({ code, message: ERROR_MESSAGES[code] });
}
function copyRecord(record: ActionRecordV1, update: Partial<ActionRecordV1>): ActionRecordV1 {
  return parseActionRecord({ ...record, ...update });
}

export function createRecord(invocation: ActionInvocationV1, now: string): ActionRecordV1 {
  now = injectedTimestamp(now);
  invocation = parseActionInvocation(invocation);
  if (time(invocation.requested_at) > time(now)) fail("result_conflict");
  if (time(now) >= time(invocation.expires_at)) fail("expired");
  return parseActionRecord({
    schema_version: 1,
    invocation,
    invocation_hash: canonicalSha256(invocation),
    phase: "pending",
    pre_cancel_phase: null,
    dispatch: null,
    acknowledgement: null,
    cancellation: null,
    expiry: null,
    control: null,
    result: null,
    terminal_state: null,
    error: null,
    created_at: now,
    updated_at: now,
  });
}
export function createOrReplay(
  existing: ActionRecordV1 | null,
  invocation: ActionInvocationV1,
  now: string,
): ActionRecordV1 {
  now = injectedTimestamp(now);
  invocation = parseActionInvocation(invocation);
  if (existing === null) return createRecord(invocation, now);
  existing = parseActionRecord(existing);
  if (time(now) < time(existing.updated_at)) fail("result_conflict");
  if (
    existing.invocation.action_id === invocation.action_id &&
    existing.invocation.idempotency_key === invocation.idempotency_key &&
    existing.invocation_hash === canonicalSha256(invocation)
  )
    return existing;
  fail("replay_conflict");
}

export function transition(
  record: ActionRecordV1,
  fact: ActionFactV1,
  now: string,
): ActionRecordV1 {
  now = injectedTimestamp(now);
  record = parseActionRecord(record);
  fact = parseFact(fact);
  if (
    time(now) < time(record.updated_at) ||
    !sameFactIdentity(record.invocation, fact) ||
    time(factTime(fact)) > time(now)
  )
    fail("result_conflict");
  if (
    "kind" in fact &&
    fact.kind === "expire" &&
    (fact.observed_at !== now || time(now) < time(record.invocation.expires_at))
  )
    fail("result_conflict");
  const stored = storedFact(record, fact);
  if (stored !== null && canonicalJson(stored) === canonicalJson(fact)) return record;
  if (record.phase === "terminal") {
    if ("kind" in fact && fact.kind === "expire") return record;
    fail("result_conflict");
  }
  if ("kind" in fact && fact.kind === "dispatched") {
    if (
      record.phase !== "pending" ||
      time(fact.dispatched_at) < time(record.invocation.requested_at) ||
      time(fact.dispatched_at) >= time(record.invocation.expires_at)
    )
      fail("result_conflict");
    return copyRecord(record, {
      phase: "dispatched",
      dispatch: fact,
      updated_at: now,
    });
  }
  if ("kind" in fact && fact.kind === "expire") return applyExpiry(record, fact, now);
  if ("kind" in fact) {
    if (
      time(fact.observed_at) < time(record.created_at) ||
      (record.dispatch !== null && time(fact.observed_at) < time(record.dispatch.dispatched_at))
    )
      fail("result_conflict");
    return copyRecord(record, {
      phase: "terminal",
      pre_cancel_phase: null,
      control: fact,
      terminal_state: record.phase === "pending" ? "rejected" : "outcome_unknown",
      error: {
        code: "executor_unavailable",
        message: ERROR_MESSAGES.executor_unavailable,
      },
      updated_at: now,
    });
  }
  if ("acknowledged_at" in fact) return applyAcknowledgement(record, fact, now);
  if ("reason" in fact) return applyCancellation(record, fact, now);
  return applyResult(record, fact, now);
}

function applyAcknowledgement(
  record: ActionRecordV1,
  fact: ActionAcknowledgementV1,
  now: string,
): ActionRecordV1 {
  if (record.dispatch === null || time(fact.acknowledged_at) < time(record.dispatch.dispatched_at))
    fail("result_conflict");
  if (fact.state === "accepted") {
    if (time(fact.acknowledged_at) >= time(record.invocation.expires_at)) fail("result_conflict");
    if (record.phase === "dispatched")
      return copyRecord(record, {
        phase: "accepted",
        acknowledgement: fact,
        updated_at: now,
      });
    if (record.phase === "cancel_requested" && record.pre_cancel_phase === "dispatched")
      return copyRecord(record, {
        pre_cancel_phase: "accepted",
        acknowledgement: fact,
        updated_at: now,
      });
    fail("result_conflict");
  }
  const expired = time(fact.acknowledged_at) >= time(record.invocation.expires_at);
  if (
    !(
      record.phase === "dispatched" ||
      (record.phase === "cancel_requested" && record.pre_cancel_phase === "dispatched")
    ) ||
    fact.error === null ||
    (fact.error.code === "expired") !== expired
  )
    fail("result_conflict");
  return copyRecord(record, {
    phase: "terminal",
    pre_cancel_phase: null,
    acknowledgement: fact,
    terminal_state: "rejected",
    error: fact.error,
    updated_at: now,
  });
}
function applyCancellation(
  record: ActionRecordV1,
  fact: ActionCancellationV1,
  now: string,
): ActionRecordV1 {
  if (fact.reason === "expired" || time(fact.requested_at) < time(record.invocation.requested_at))
    fail("result_conflict");
  if (record.phase === "pending")
    return copyRecord(record, {
      phase: "terminal",
      cancellation: fact,
      terminal_state: "rejected",
      error: cancellationError(fact.reason),
      updated_at: now,
    });
  if (
    !(["dispatched", "accepted"] as string[]).includes(record.phase) ||
    record.dispatch === null ||
    time(fact.requested_at) < time(record.dispatch.dispatched_at)
  )
    fail("result_conflict");
  return copyRecord(record, {
    phase: "cancel_requested",
    pre_cancel_phase: record.phase as "dispatched" | "accepted",
    cancellation: fact,
    updated_at: now,
  });
}
function applyExpiry(
  record: ActionRecordV1,
  fact: ActionExpireFactV1,
  now: string,
): ActionRecordV1 {
  if (record.phase === "pending")
    return copyRecord(record, {
      phase: "terminal",
      expiry: fact,
      terminal_state: "rejected",
      error: { code: "expired", message: ERROR_MESSAGES.expired },
      updated_at: now,
    });
  if (record.phase === "dispatched" || record.phase === "accepted") {
    const cancellation: ActionCancellationV1 = {
      ...(identityPart(record.invocation) as ActionIdentityV1),
      reason: "expired",
      requested_at: now,
    };
    return copyRecord(record, {
      phase: "cancel_requested",
      pre_cancel_phase: record.phase,
      cancellation,
      expiry: fact,
      updated_at: now,
    });
  }
  if (record.phase === "cancel_requested")
    return record.expiry === null ? copyRecord(record, { expiry: fact, updated_at: now }) : record;
  fail("result_conflict");
}
function applyResult(record: ActionRecordV1, fact: ActionResultV1, now: string): ActionRecordV1 {
  if (record.phase !== "accepted" && record.phase !== "cancel_requested") fail("result_conflict");
  const anchor = record.acknowledgement?.acknowledged_at ?? record.dispatch?.dispatched_at;
  if (
    anchor === undefined ||
    time(fact.started_at) < time(anchor) ||
    time(fact.started_at) >= time(record.invocation.expires_at)
  )
    fail("result_conflict");
  if (
    record.cancellation !== null &&
    fact.state === "interrupted_before_delivery" &&
    fact.error?.code !== cancellationError(record.cancellation.reason).code
  )
    fail("result_conflict");
  return copyRecord(record, {
    phase: "terminal",
    pre_cancel_phase: null,
    result: fact,
    terminal_state: fact.state,
    error: fact.error,
    updated_at: now,
  });
}
function factTime(fact: ActionFactV1): string {
  if ("dispatched_at" in fact) return fact.dispatched_at;
  if ("acknowledged_at" in fact) return fact.acknowledged_at;
  if ("requested_at" in fact) return fact.requested_at;
  if ("ended_at" in fact) return fact.ended_at;
  return fact.observed_at;
}
function storedFact(record: ActionRecordV1, fact: ActionFactV1): ActionFactV1 | null {
  if ("dispatched_at" in fact) return record.dispatch;
  if ("acknowledged_at" in fact) return record.acknowledgement;
  if ("requested_at" in fact) return record.cancellation;
  if ("ended_at" in fact) return record.result;
  if (fact.kind === "expire") return record.expiry;
  return record.control;
}

export function parseActionRecord(value: unknown): ActionRecordV1 {
  const raw = object(value);
  exact(raw, [
    "schema_version",
    "invocation",
    "invocation_hash",
    "phase",
    "pre_cancel_phase",
    "dispatch",
    "acknowledgement",
    "cancellation",
    "expiry",
    "control",
    "result",
    "terminal_state",
    "error",
    "created_at",
    "updated_at",
  ]);
  const record: ActionRecordV1 = {
    schema_version: raw.schema_version === 1 ? 1 : fail("invalid_action"),
    invocation: parseActionInvocation(raw.invocation),
    invocation_hash: hex(raw.invocation_hash, 64),
    phase: oneOf(raw.phase, ["pending", "dispatched", "accepted", "cancel_requested", "terminal"]),
    pre_cancel_phase:
      raw.pre_cancel_phase === null
        ? null
        : oneOf(raw.pre_cancel_phase, ["dispatched", "accepted"] as const),
    dispatch: raw.dispatch === null ? null : parseDispatch(raw.dispatch),
    acknowledgement:
      raw.acknowledgement === null ? null : parseAcknowledgement(raw.acknowledgement),
    cancellation: raw.cancellation === null ? null : parseCancellation(raw.cancellation),
    expiry: raw.expiry === null ? null : parseExpiry(raw.expiry),
    control: raw.control === null ? null : parseControl(raw.control),
    result: raw.result === null ? null : parseResult(raw.result),
    terminal_state:
      raw.terminal_state === null
        ? null
        : oneOf(raw.terminal_state, [
            "rejected",
            "interrupted_before_delivery",
            "delivered",
            "outcome_unknown",
          ] as const),
    error: nullableError(raw.error),
    created_at: timestamp(raw.created_at),
    updated_at: timestamp(raw.updated_at),
  };
  validateRecord(record);
  return immutable(record);
}

function validateRecord(record: ActionRecordV1): void {
  if (
    record.invocation_hash !== canonicalSha256(record.invocation) ||
    time(record.updated_at) < time(record.created_at) ||
    time(record.invocation.requested_at) > time(record.created_at) ||
    time(record.created_at) >= time(record.invocation.expires_at)
  )
    fail("invalid_action");
  const facts = [
    record.dispatch,
    record.acknowledgement,
    record.cancellation,
    record.expiry,
    record.control,
    record.result,
  ].filter((fact): fact is ActionFactV1 => fact !== null);
  if (
    facts.some(
      (fact) =>
        !sameFactIdentity(record.invocation, fact) ||
        time(factTime(fact)) > time(record.updated_at),
    )
  )
    fail("invalid_action");
  const d = record.dispatch,
    a = record.acknowledgement,
    c = record.cancellation,
    e = record.expiry,
    r = record.result;
  if (
    d !== null &&
    (time(d.dispatched_at) < time(record.invocation.requested_at) ||
      time(d.dispatched_at) >= time(record.invocation.expires_at))
  )
    fail("invalid_action");
  if (
    a !== null &&
    (d === null ||
      time(a.acknowledged_at) < time(d.dispatched_at) ||
      (a.state === "accepted" && time(a.acknowledged_at) >= time(record.invocation.expires_at)) ||
      (a.state === "rejected" &&
        (a.error?.code === "expired") !==
          time(a.acknowledged_at) >= time(record.invocation.expires_at)))
  )
    fail("invalid_action");
  if (
    c !== null &&
    (time(c.requested_at) < time(record.invocation.requested_at) ||
      (d !== null && time(c.requested_at) < time(d.dispatched_at)) ||
      (a !== null && time(a.acknowledged_at) >= time(c.requested_at)) ||
      (c.reason === "expired" && (e === null || c.requested_at !== e.observed_at)))
  )
    fail("invalid_action");
  if (
    e !== null &&
    (time(e.observed_at) < time(record.invocation.expires_at) ||
      (c !== null && time(e.observed_at) < time(c.requested_at)))
  )
    fail("invalid_action");
  if (
    record.control !== null &&
    (time(record.control.observed_at) < time(record.created_at) ||
      (d !== null && time(record.control.observed_at) < time(d.dispatched_at)))
  )
    fail("invalid_action");
  const anchor = a?.acknowledged_at ?? d?.dispatched_at;
  if (
    r !== null &&
    (anchor === undefined ||
      time(r.started_at) < time(anchor) ||
      time(r.started_at) >= time(record.invocation.expires_at))
  )
    fail("invalid_action");
  if (record.phase === "pending") {
    if (
      [
        record.pre_cancel_phase,
        d,
        a,
        c,
        e,
        record.control,
        r,
        record.terminal_state,
        record.error,
      ].some((item) => item !== null)
    )
      fail("invalid_action");
    return;
  }
  if (record.phase === "dispatched") {
    if (
      d === null ||
      [
        record.pre_cancel_phase,
        a,
        c,
        e,
        record.control,
        r,
        record.terminal_state,
        record.error,
      ].some((item) => item !== null)
    )
      fail("invalid_action");
    return;
  }
  if (record.phase === "accepted") {
    if (
      d === null ||
      a?.state !== "accepted" ||
      [record.pre_cancel_phase, c, e, record.control, r, record.terminal_state, record.error].some(
        (item) => item !== null,
      )
    )
      fail("invalid_action");
    return;
  }
  if (record.phase === "cancel_requested") {
    if (
      d === null ||
      c === null ||
      record.pre_cancel_phase !== (a === null ? "dispatched" : "accepted") ||
      (a !== null && a.state !== "accepted") ||
      [record.control, r, record.terminal_state, record.error].some((item) => item !== null)
    )
      fail("invalid_action");
    return;
  }
  if (record.pre_cancel_phase !== null || record.terminal_state === null || !validTerminal(record))
    fail("invalid_action");
}
function validTerminal(record: ActionRecordV1): boolean {
  const resultHistory =
    record.result !== null &&
    record.control === null &&
    record.dispatch !== null &&
    (record.acknowledgement === null
      ? record.cancellation !== null
      : record.acknowledgement.state === "accepted") &&
    (record.expiry === null || record.cancellation !== null) &&
    !(
      record.cancellation !== null &&
      record.result.state === "interrupted_before_delivery" &&
      record.result.error?.code !== cancellationError(record.cancellation.reason).code
    );
  if (record.terminal_state === "delivered")
    return resultHistory && record.result?.state === "delivered" && record.error === null;
  if (record.terminal_state === "interrupted_before_delivery")
    return (
      resultHistory &&
      record.result?.state === "interrupted_before_delivery" &&
      canonicalJson(record.error) === canonicalJson(record.result.error)
    );
  if (record.terminal_state === "outcome_unknown")
    return (
      record.error?.code === "executor_unavailable" &&
      ((resultHistory && record.result?.state === "outcome_unknown") || validControlHistory(record))
    );
  if (record.error === null || record.result !== null) return false;
  if (record.acknowledgement !== null)
    return (
      record.acknowledgement.state === "rejected" &&
      record.dispatch !== null &&
      record.control === null &&
      canonicalJson(record.error) === canonicalJson(record.acknowledgement.error) &&
      (record.expiry === null || record.cancellation !== null)
    );
  const owners = [record.cancellation, record.expiry, record.control].filter(
    (item) => item !== null,
  );
  if (record.dispatch !== null || owners.length !== 1) return false;
  return record.cancellation !== null
    ? canonicalJson(record.error) === canonicalJson(cancellationError(record.cancellation.reason))
    : record.expiry !== null
      ? record.error.code === "expired"
      : record.error.code === "executor_unavailable";
}

function validControlHistory(record: ActionRecordV1): boolean {
  if (record.control === null || record.result !== null || record.dispatch === null) return false;
  if (record.acknowledgement !== null && record.acknowledgement.state !== "accepted") return false;
  return record.expiry === null || record.cancellation !== null;
}

export function projectActionAudit(record: ActionRecordV1): ActionAuditProjectionV1 {
  record = parseActionRecord(record);
  const invocation = record.invocation;
  return immutable({
    schema_version: 1,
    action_id: invocation.action_id,
    session_id: invocation.session_id,
    trace_id: invocation.trace_id,
    turn_id: invocation.turn_id,
    tool_call_id: invocation.tool_call_id,
    actor_kind: "agent",
    capability: invocation.capability,
    action_kind: invocation.action.kind,
    source_kind: invocation.target.source_kind,
    requested_risk: invocation.requested_risk,
    effective_risk: invocation.effective_risk,
    approval_mode: "approve_each",
    approval_present: true,
    phase: record.phase,
    terminal_state: record.terminal_state,
    error_code: record.error?.code ?? null,
    requested_at: invocation.requested_at,
    acknowledged_at: record.acknowledgement?.acknowledged_at ?? null,
    started_at: record.result?.started_at ?? null,
    ended_at: record.result?.ended_at ?? null,
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("invalid_action");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }
  fail("invalid_action");
}

class JsonParser {
  private index = 0;
  constructor(private readonly source: string) {}
  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error("trailing JSON");
    return value;
  }
  private space(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
  }
  private value(): unknown {
    this.space();
    const char = this.source[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (this.source.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.index),
    );
    if (match === null) throw new Error("invalid JSON");
    if (/[.eE]/u.test(match[0])) throw new Error("non-integer JSON number");
    this.index += match[0].length;
    return Number(match[0]);
  }
  private object(): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.space();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.space();
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
      this.space();
      if (this.source[this.index++] !== ":") throw new Error("missing colon");
      result[key] = this.value();
      this.space();
      const next = this.source[this.index++];
      if (next === "}") return result;
      if (next !== ",") throw new Error("missing comma");
    }
  }
  private array(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.space();
      const next = this.source[this.index++];
      if (next === "]") return result;
      if (next !== ",") throw new Error("missing comma");
    }
  }
  private string(): string {
    const start = this.index;
    if (this.source[this.index++] !== '"') throw new Error("expected string");
    let escaped = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return JSON.parse(this.source.slice(start, this.index)) as string;
    }
    throw new Error("unterminated string");
  }
}
