import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGES,
  ComputerActionContractError,
  buildActionInvocation,
  canonicalJson,
  canonicalSha256,
  createOrReplay,
  createRecord,
  matchDesktopGrant,
  parseAcknowledgement,
  parseActionIntent,
  parseActionInvocation,
  parseActionRecord,
  parseActionTarget,
  parseCancellation,
  parseCapabilityState,
  parseControl,
  parseDesktopGrant,
  parseDispatch,
  parseExpiry,
  parseResult,
  projectActionAudit,
  transition,
  type ActionInvocationV1,
  type ActionRecordV1,
  type ErrorCode,
  type TrustedActionContextV1,
} from "../../src/shared/computer-actions.js";

type Fixture = Record<string, unknown> & {
  valid_intent: Record<string, unknown>;
  valid_intent_canonical: string;
  valid_intent_sha256: string;
  invocation: Record<string, unknown>;
  grant: Record<string, unknown>;
  capability_state: Record<string, unknown>;
  acknowledgement: Record<string, unknown>;
  cancellation: Record<string, unknown>;
  dispatch: Record<string, unknown>;
  expiry: Record<string, unknown>;
  control: Record<string, unknown>;
  result: Record<string, unknown>;
  delivered_record: Record<string, unknown>;
  audit: Record<string, unknown>;
  fixed_errors: Record<string, string>;
  negative_cases: Array<{
    name: string;
    error: ErrorCode;
    input?: Record<string, unknown>;
    field?: string;
    value?: unknown;
  }>;
};

const fixturePath =
  process.env.OPENMINION_COMPUTER_ACTION_V1_FIXTURE ??
  resolve(process.cwd(), "tests/fixtures/openminion-desktop-computer-actions-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorCode(operation: () => unknown): ErrorCode {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerActionContractError);
    return (error as ComputerActionContractError).code;
  }
  throw new Error("expected ComputerActionContractError");
}

function trustedContext(invocation: ActionInvocationV1): TrustedActionContextV1 {
  return {
    action_id: invocation.action_id,
    idempotency_key: invocation.idempotency_key,
    daemon_id: invocation.daemon_id,
    desktop_client_id: invocation.desktop_client_id,
    user_id: invocation.user_id,
    session_id: invocation.session_id,
    trace_id: invocation.trace_id,
    turn_id: invocation.turn_id,
    tool_call_id: invocation.tool_call_id,
    actor_id: invocation.actor_id,
    actor_kind: "agent",
    target: invocation.target,
    requested_at: invocation.requested_at,
    expires_at: invocation.expires_at,
    approval: {
      approval_id: invocation.approval_id,
      session_id: invocation.session_id,
      trace_id: invocation.trace_id,
      tool_call_id: invocation.tool_call_id,
      actor_id: invocation.actor_id,
      state: "applied",
    },
    registered_risk_floor: "high",
  };
}

describe("computer action golden parity contracts", () => {
  it("accepts the five fixed action shapes and rejects unsafe model input", () => {
    const actions = [
      { kind: "pointer_move", x_bps: 0, y_bps: 10000, duration_ms: 2000 },
      { kind: "click", x_bps: 2500, y_bps: 7500, button: "left", count: 2 },
      { kind: "scroll", delta_x_bps: -100, delta_y_bps: 100 },
      {
        kind: "key_press",
        keys: ["a", "enter"],
        modifiers: ["control", "shift"],
      },
      { kind: "wait", duration_ms: 1 },
    ];
    for (const action of actions) {
      expect(
        parseActionIntent({ schema_version: 1, action, requested_risk: "high" }).action,
      ).toEqual(action);
    }

    expect(
      errorCode(() =>
        parseActionIntent({
          schema_version: 1,
          action: { kind: "text_entry", text: "never-repeat-this-model-value" },
          requested_risk: "high",
        }),
      ),
    ).toBe("unsupported_action");
    expect(
      errorCode(() => parseActionIntent('{"schema_version":1,"schema_version":1,"action":{}}')),
    ).toBe("invalid_action");
    expect(
      errorCode(() =>
        parseActionIntent({
          schema_version: 1,
          action: {
            kind: "click",
            x_bps: 0.5,
            y_bps: 1,
            button: "left",
            count: 1,
          },
          requested_risk: "high",
        }),
      ),
    ).toBe("invalid_action");
  });

  it("builds only from trusted identity and current approval facts", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    expect(buildActionInvocation(fixture.valid_intent, trustedContext(invocation))).toEqual(
      invocation,
    );

    const critical = buildActionInvocation(
      { ...fixture.valid_intent, requested_risk: "critical" },
      trustedContext(invocation),
    );
    expect(critical.effective_risk).toBe("critical");

    const missing: TrustedActionContextV1 = {
      ...trustedContext(invocation),
      approval: null,
    };
    expect(errorCode(() => buildActionInvocation(fixture.valid_intent, missing))).toBe(
      "approval_required",
    );

    const validContext = trustedContext(invocation);
    const mismatch: TrustedActionContextV1 = {
      ...validContext,
      approval: {
        ...validContext.approval!,
        session_id: "different-session",
      },
    };
    expect(errorCode(() => buildActionInvocation(fixture.valid_intent, mismatch))).toBe(
      "approval_mismatch",
    );
  });

  it("validates capability and grant coupling before state", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const grant = parseDesktopGrant(fixture.grant);
    expect(matchDesktopGrant(invocation, grant, "2026-08-22T12:00:00.500Z")).toEqual(grant);
    expect(parseCapabilityState(fixture.capability_state)).toEqual(fixture.capability_state);

    const wrongSession = clone(fixture.grant);
    wrongSession.session_id = "different-session";
    wrongSession.state = "revoked";
    wrongSession.revoked_at = "2026-08-22T12:00:00.250Z";
    wrongSession.revocation_reason = "user_stop";
    expect(
      errorCode(() =>
        matchDesktopGrant(invocation, parseDesktopGrant(wrongSession), "2026-08-22T12:00:00.500Z"),
      ),
    ).toBe("grant_required");

    const future = clone(fixture.grant);
    future.issued_at = "2026-08-22T12:00:01.000Z";
    expect(
      errorCode(() =>
        matchDesktopGrant(invocation, parseDesktopGrant(future), "2026-08-22T12:00:00.500Z"),
      ),
    ).toBe("grant_revoked");
  });

  it("validates every reverse-wire fact family", () => {
    expect(parseAcknowledgement(fixture.acknowledgement)).toEqual(fixture.acknowledgement);
    expect(parseCancellation(fixture.cancellation)).toEqual(fixture.cancellation);
    expect(parseDispatch(fixture.dispatch)).toEqual(fixture.dispatch);
    expect(parseExpiry(fixture.expiry)).toEqual(fixture.expiry);
    expect(parseControl(fixture.control)).toEqual(fixture.control);
    expect(parseResult(fixture.result)).toEqual(fixture.result);
  });

  it("reduces delivery, cancellation, expiry, and control facts deterministically", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    let delivered = createRecord(invocation, "2026-08-22T12:00:00.000Z");
    delivered = transition(delivered, parseDispatch(fixture.dispatch), "2026-08-22T12:00:00.100Z");
    delivered = transition(
      delivered,
      parseAcknowledgement(fixture.acknowledgement),
      "2026-08-22T12:00:00.200Z",
    );
    delivered = transition(delivered, parseResult(fixture.result), "2026-08-22T12:00:00.500Z");
    expect(delivered).toEqual(fixture.delivered_record);

    let cancelled = createRecord(invocation, "2026-08-22T12:00:00.000Z");
    cancelled = transition(cancelled, parseDispatch(fixture.dispatch), "2026-08-22T12:00:00.100Z");
    cancelled = transition(
      cancelled,
      parseCancellation(fixture.cancellation),
      "2026-08-22T12:00:00.300Z",
    );
    expect(cancelled.phase).toBe("cancel_requested");
    expect(cancelled.pre_cancel_phase).toBe("dispatched");

    const expiry = parseExpiry(fixture.expiry);
    const expiredPending = transition(
      createRecord(invocation, invocation.requested_at),
      expiry,
      expiry.observed_at,
    );
    expect(expiredPending.terminal_state).toBe("rejected");
    expect(expiredPending.error?.code).toBe("expired");

    let disconnected = createRecord(invocation, invocation.requested_at);
    disconnected = transition(
      disconnected,
      parseDispatch(fixture.dispatch),
      "2026-08-22T12:00:00.100Z",
    );
    disconnected = transition(
      disconnected,
      parseControl(fixture.control),
      "2026-08-22T12:00:00.300Z",
    );
    expect(disconnected.terminal_state).toBe("outcome_unknown");
  });

  it("rejects unreachable or conflicting record history", () => {
    const raw = clone(fixture.delivered_record);
    raw.acknowledgement = null;
    expect(errorCode(() => parseActionRecord(raw))).toBe("invalid_action");

    const expiredCancellation = clone(fixture.delivered_record);
    expiredCancellation.phase = "cancel_requested";
    expiredCancellation.pre_cancel_phase = "accepted";
    expiredCancellation.cancellation = {
      ...fixture.cancellation,
      reason: "expired",
    };
    expiredCancellation.expiry = null;
    expiredCancellation.result = null;
    expiredCancellation.terminal_state = null;
    expiredCancellation.error = null;
    expiredCancellation.updated_at = "2026-08-22T12:00:00.300Z";
    expect(errorCode(() => parseActionRecord(expiredCancellation))).toBe("invalid_action");
  });

  it("rejects lexical floats, invalid Unicode, and year zero", () => {
    const intentJson = JSON.stringify(fixture.valid_intent);
    expect(
      errorCode(() => parseActionIntent(intentJson.replace('"x_bps":2500', '"x_bps":2500.0'))),
    ).toBe("invalid_action");
    expect(
      errorCode(() => parseActionIntent(intentJson.replace('"x_bps":2500', '"x_bps":25e2'))),
    ).toBe("invalid_action");
    expect(
      errorCode(() => parseActionInvocation({ ...fixture.invocation, daemon_id: "\ud800" })),
    ).toBe("invalid_action");
    expect(parseActionInvocation({ ...fixture.invocation, daemon_id: "\ufeff" }).daemon_id).toBe(
      "\ufeff",
    );
    expect(
      errorCode(() => parseActionInvocation({ ...fixture.invocation, daemon_id: "\u3000" })),
    ).toBe("invalid_action");
    expect(
      errorCode(() =>
        parseActionTarget({
          ...(fixture.invocation.target as Record<string, unknown>),
          frame_captured_at: "0000-08-22T11:59:59.000Z",
        }),
      ),
    ).toBe("invalid_action");
  });

  it("matches trusted-context and approval error precedence", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const context = trustedContext(invocation);
    const malformedTarget = {
      ...context,
      target: { ...context.target, frame_width: 1 },
      approval: null,
    } as TrustedActionContextV1;
    expect(errorCode(() => buildActionInvocation(fixture.valid_intent, malformedTarget))).toBe(
      "approval_required",
    );

    const malformedTime = {
      ...context,
      requested_at: "not-a-time",
      approval: { ...context.approval!, session_id: "different-session" },
    } as TrustedActionContextV1;
    expect(errorCode(() => buildActionInvocation(fixture.valid_intent, malformedTime))).toBe(
      "invalid_action",
    );

    const validApprovalMalformedTarget = {
      ...context,
      target: { ...context.target, frame_width: 1 },
    } as TrustedActionContextV1;
    expect(
      errorCode(() => buildActionInvocation(fixture.valid_intent, validApprovalMalformedTarget)),
    ).toBe("invalid_action");

    const malformedApprovalId = {
      ...context,
      approval: { ...context.approval!, approval_id: " " },
    } as TrustedActionContextV1;
    expect(errorCode(() => buildActionInvocation(fixture.valid_intent, malformedApprovalId))).toBe(
      "approval_mismatch",
    );
  });

  it("normalizes malformed injected clocks to result conflict", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const grant = parseDesktopGrant(fixture.grant);
    const record = createRecord(invocation, invocation.requested_at);
    const dispatch = parseDispatch(fixture.dispatch);

    expect(errorCode(() => matchDesktopGrant(invocation, grant, "bad-clock"))).toBe(
      "result_conflict",
    );
    expect(errorCode(() => createRecord(invocation, "bad-clock"))).toBe("result_conflict");
    expect(errorCode(() => createOrReplay(record, invocation, "bad-clock"))).toBe(
      "result_conflict",
    );
    expect(errorCode(() => transition(record, dispatch, "bad-clock"))).toBe("result_conflict");
  });

  it("freezes parsed values and revalidates duplicate transitions", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const dispatch = parseDispatch(fixture.dispatch);
    const record = transition(
      createRecord(invocation, invocation.requested_at),
      dispatch,
      dispatch.dispatched_at,
    );
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.invocation)).toBe(true);
    expect(Object.isFrozen(record.invocation.action)).toBe(true);
    expect(() => {
      (record as unknown as { phase: string }).phase = "pending";
    }).toThrow(TypeError);

    const invalidDuplicate = structuredClone(record) as unknown as {
      phase: string;
    };
    invalidDuplicate.phase = "pending";
    expect(
      errorCode(() =>
        transition(invalidDuplicate as unknown as ActionRecordV1, dispatch, dispatch.dispatched_at),
      ),
    ).toBe("invalid_action");
    const replayed = transition(record, dispatch, dispatch.dispatched_at);
    expect(replayed).toEqual(record);
    expect(Object.isFrozen(replayed)).toBe(true);
  });

  it("rejects wrong fact identity, receipt order, and unreachable control history", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const pending = createRecord(invocation, invocation.requested_at);
    const dispatch = parseDispatch(fixture.dispatch);
    expect(
      errorCode(() =>
        transition(
          pending,
          { ...dispatch, session_id: "different-session" },
          dispatch.dispatched_at,
        ),
      ),
    ).toBe("result_conflict");
    expect(errorCode(() => transition(pending, dispatch, invocation.requested_at))).toBe(
      "result_conflict",
    );

    const pendingControl = transition(
      pending,
      parseControl({ ...fixture.control, observed_at: dispatch.dispatched_at }),
      dispatch.dispatched_at,
    );
    expect(pendingControl.terminal_state).toBe("rejected");
    expect(
      errorCode(() =>
        parseActionRecord({
          ...pendingControl,
          terminal_state: "outcome_unknown",
        }),
      ),
    ).toBe("invalid_action");

    const rejectedAck = {
      ...fixture.acknowledgement,
      state: "rejected",
      error: {
        code: "grant_revoked",
        message: ERROR_MESSAGES.grant_revoked,
      },
    };
    let rejected = transition(pending, dispatch, dispatch.dispatched_at);
    rejected = transition(
      rejected,
      parseAcknowledgement(rejectedAck),
      fixture.acknowledgement.acknowledged_at as string,
    );
    expect(
      errorCode(() =>
        parseActionRecord({
          ...rejected,
          control: fixture.control,
          terminal_state: "outcome_unknown",
          error: {
            code: "executor_unavailable",
            message: ERROR_MESSAGES.executor_unavailable,
          },
          updated_at: fixture.control.observed_at,
        }),
      ),
    ).toBe("invalid_action");

    const dispatched = transition(pending, dispatch, dispatch.dispatched_at);
    const controlled = transition(
      dispatched,
      parseControl(fixture.control),
      fixture.control.observed_at as string,
    );
    expect(controlled.terminal_state).toBe("outcome_unknown");
    expect(
      errorCode(() =>
        parseActionRecord({
          ...controlled,
          expiry: fixture.expiry,
          updated_at: fixture.expiry.observed_at,
        }),
      ),
    ).toBe("invalid_action");

    const accepted = transition(
      dispatched,
      parseAcknowledgement(fixture.acknowledgement),
      fixture.acknowledgement.acknowledged_at as string,
    );
    const acceptedControl = transition(
      accepted,
      parseControl(fixture.control),
      fixture.control.observed_at as string,
    );
    expect(parseActionRecord(acceptedControl).terminal_state).toBe("outcome_unknown");

    const cancelling = transition(
      dispatched,
      parseCancellation(fixture.cancellation),
      fixture.cancellation.requested_at as string,
    );
    const cancellingControl = transition(
      cancelling,
      parseControl(fixture.control),
      fixture.control.observed_at as string,
    );
    expect(parseActionRecord(cancellingControl).terminal_state).toBe("outcome_unknown");
  });

  it("enforces replay identity and canonical hash", () => {
    const invocation = parseActionInvocation(fixture.invocation);
    const record = createOrReplay(null, invocation, invocation.requested_at);
    expect(createOrReplay(record, invocation, record.updated_at)).toEqual(record);
    expect(
      errorCode(() =>
        createOrReplay(
          record,
          {
            ...invocation,
            requested_risk: "critical",
            effective_risk: "critical",
          },
          record.updated_at,
        ),
      ),
    ).toBe("replay_conflict");
  });

  it("keeps the module dependency-free and unreachable from native owners", () => {
    const source = readFileSync(resolve(process.cwd(), "src/shared/computer-actions.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:electron|node:child_process)["']/u);
    expect(source).not.toMatch(
      /src\/(?:main|preload|renderer)|desktopCapturer|webContents|ipcMain|ipcRenderer/u,
    );
    expect(source.match(/^import .*;$/gmu)).toEqual(['import { createHash } from "node:crypto";']);
  });

  it("matches the reviewed cross-language golden artifact", () => {
    const intent = parseActionIntent(fixture.valid_intent);
    expect(canonicalJson(intent)).toBe(fixture.valid_intent_canonical);
    expect(canonicalSha256(intent)).toBe(fixture.valid_intent_sha256);
    expect(parseActionInvocation(fixture.invocation)).toEqual(fixture.invocation);
    expect(parseDesktopGrant(fixture.grant)).toEqual(fixture.grant);
    expect(parseCapabilityState(fixture.capability_state)).toEqual(fixture.capability_state);
    expect(parseAcknowledgement(fixture.acknowledgement)).toEqual(fixture.acknowledgement);
    expect(parseCancellation(fixture.cancellation)).toEqual(fixture.cancellation);
    expect(parseDispatch(fixture.dispatch)).toEqual(fixture.dispatch);
    expect(parseExpiry(fixture.expiry)).toEqual(fixture.expiry);
    expect(parseControl(fixture.control)).toEqual(fixture.control);
    expect(parseResult(fixture.result)).toEqual(fixture.result);
    expect(parseActionRecord(fixture.delivered_record)).toEqual(fixture.delivered_record);

    const invocation = parseActionInvocation(fixture.invocation);
    let record: ActionRecordV1 = createRecord(invocation, invocation.requested_at);
    record = transition(record, parseDispatch(fixture.dispatch), "2026-08-22T12:00:00.100Z");
    record = transition(
      record,
      parseAcknowledgement(fixture.acknowledgement),
      "2026-08-22T12:00:00.200Z",
    );
    record = transition(record, parseResult(fixture.result), "2026-08-22T12:00:00.500Z");
    expect(record).toEqual(fixture.delivered_record);
    expect(projectActionAudit(record)).toEqual(fixture.audit);
    expect(ERROR_MESSAGES).toEqual(fixture.fixed_errors);

    for (const negative of fixture.negative_cases) {
      if (negative.input !== undefined) {
        expect(
          errorCode(() => parseActionIntent(negative.input!)),
          negative.name,
        ).toBe(negative.error);
        continue;
      }
      if (negative.name === "lowered_effective_risk") {
        expect(
          errorCode(() =>
            parseActionInvocation({
              ...fixture.invocation,
              [negative.field!]: negative.value,
            }),
          ),
          negative.name,
        ).toBe(negative.error);
        continue;
      }
      const conflicting = {
        ...invocation,
        requested_risk: negative.value,
        effective_risk: negative.value,
      } as ActionInvocationV1;
      expect(
        errorCode(() => createOrReplay(record, conflicting, record.updated_at)),
        negative.name,
      ).toBe(negative.error);
    }
  });
});
