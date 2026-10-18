import { randomUUID } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
import type {
  ApprovalDecisionInput,
  ApprovalDecisionV1,
  ApprovalEventV1,
  ArtifactContentV1,
  ArtifactDecisionInput,
  ArtifactDecisionValue,
  ArtifactListInput,
  ArtifactListValue,
  ArtifactReadInput,
  ClientResult,
  ErrorV1,
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
  SessionSummaryV1,
  TurnCancelInput,
  TurnCancellationValue,
  TurnEventV1,
  TurnInputDropInput,
  TurnInputEnqueueInput,
  TurnInputListInput,
  TurnInputMoveInput,
  TurnInputQueueEntry,
  TurnInputQueueStatus,
  TurnInputRunNextInput,
  TurnSubmitInput,
  TurnSubmitValue,
} from "../shared/contracts.js";
import type { ReportValue } from "../shared/reports.js";
import type {
  DelegationAction,
  DelegationControlValue,
  DelegationInspection,
  DelegationTask,
  DelegationTimelineEntry,
  PendingTaskAction,
  RuntimeTask,
  SchedulerReadiness,
  TaskControlValue,
  TaskDelivery,
  TaskError,
  TaskRun,
} from "../shared/tasks.js";
import type { DesktopStore } from "./desktop-store.js";
import { publicStatusText } from "./focus-status.js";
import { type RunCommand, runCommand } from "./installation.js";
import {
  EVENT_FACTS,
  errorValue,
  failure,
  failureFrom,
  optionalString,
  protocolError,
  requireArray,
  requireRecord,
  requireString,
  responseEvent,
  turnUsageDisplay,
  usageValue,
  validateApprovalDecisionInput,
  validateCancelInput,
  validateCloseInput,
  validateCreateInput,
  validateEventsInput,
  validateListInput,
  validateLoadInput,
  validateSubmitInput,
} from "./openminion-client.js";

export type CliCommandContext = { executable: string; args: readonly string[] };
type DraftSession = SessionSummaryV1 & { isDraft: true };
type TranscriptRecord = Record<string, unknown>;
type ActiveTurn = {
  identity: TurnSubmitValue | null;
  disconnected: boolean;
  replaySupported: boolean;
  lastSequence: number | null;
  receivedResponse: boolean;
  outcome: "complete" | "error" | "cancelled";
  emit: (event: TurnEventV1) => void;
};

const TURN_INPUT_QUEUE_STATUSES = new Set<TurnInputQueueStatus>([
  "queued",
  "reserved",
  "running",
  "completed",
  "cancelled",
  "failed",
  "dropped",
  "steer_deferred",
]);

function turnInputQueueEntry(value: unknown): TurnInputQueueEntry {
  const row = requireRecord(value);
  const status = requireString(row.status) as TurnInputQueueStatus;
  if (
    !TURN_INPUT_QUEUE_STATUSES.has(status) ||
    !Number.isSafeInteger(row.status_version) ||
    Number(row.status_version) < 1
  )
    throw protocolError("invalid_daemon_response", "OpenMinion returned an invalid queued prompt.");
  return {
    queueId: requireString(row.queue_id),
    sessionId: requireString(row.session_id),
    agentId: requireString(row.agent_id),
    text: requireString(row.text),
    status,
    statusVersion: Number(row.status_version),
    createdAt: requireString(row.created_at),
    traceId: optionalString(row.trace_id ?? null),
  };
}

function queueIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value).trim();
  if (!identifier || identifier.length > 512 || /\s|\0/.test(identifier))
    throw protocolError("invalid_request", `Choose a valid ${label}.`);
  return identifier;
}

function toolProgressEvent(
  chunk: Record<string, unknown>,
  detail: Record<string, unknown>,
  identity: TurnSubmitValue,
): TurnEventV1 {
  const phase = chunk.kind === "tool_started" ? ("started" as const) : ("completed" as const);
  const base = {
    schemaVersion: 1 as const,
    kind: "tool" as const,
    phase,
    sessionId: identity.sessionId,
    traceId: identity.traceId,
    toolName: requireString(detail.tool_name),
    callId: requireString(detail.call_id),
    state: requireString(detail.state),
    createdAt: requireString(chunk.ts),
  };
  if (phase === "started") {
    return { ...base, ok: null, durationMs: null, exitCode: null };
  }
  if (
    typeof detail.ok !== "boolean" ||
    !Number.isSafeInteger(detail.duration_ms) ||
    Number(detail.duration_ms) < 0 ||
    (detail.exit_code !== undefined &&
      detail.exit_code !== null &&
      !Number.isSafeInteger(detail.exit_code)) ||
    (detail.content !== undefined && typeof detail.content !== "string") ||
    (detail.truncated !== undefined && typeof detail.truncated !== "boolean")
  ) {
    throw protocolError("invalid_daemon_response", "OpenMinion returned invalid tool progress.");
  }
  return {
    ...base,
    ok: detail.ok,
    durationMs: Number(detail.duration_ms),
    exitCode: detail.exit_code == null ? null : Number(detail.exit_code),
    ...(typeof detail.content === "string" ? { content: detail.content } : {}),
    ...(typeof detail.truncated === "boolean" ? { truncated: detail.truncated } : {}),
  };
}

function approvalEvent(detail: Record<string, unknown>, identity: TurnSubmitValue): TurnEventV1 {
  if (detail.session_id !== identity.sessionId || detail.trace_id !== identity.traceId) {
    throw protocolError(
      "stream_identity_mismatch",
      "The approval identity did not match the turn.",
    );
  }
  const phase = requireString(detail.phase);
  const decision = optionalString(detail.decision ?? null);
  const outcome = requireString(detail.outcome);
  const requestedAt = optionalString(detail.requested_at ?? null);
  const expiresAt = optionalString(detail.expires_at ?? null);
  const resolvedAt = optionalString(detail.resolved_at ?? null);
  if (
    (phase !== "requested" && phase !== "resolved") ||
    (decision !== null && decision !== "allow_once" && decision !== "deny") ||
    !["pending", "applied", "denied", "expired", "cancelled"].includes(outcome) ||
    (phase === "requested" &&
      (outcome !== "pending" || decision !== null || !requestedAt || !expiresAt || resolvedAt)) ||
    (phase === "resolved" && (!resolvedAt || outcome === "pending"))
  ) {
    throw protocolError(
      "invalid_daemon_response",
      "OpenMinion returned an invalid approval event.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "approval",
    phase,
    sessionId: identity.sessionId,
    traceId: identity.traceId,
    approvalId: requireString(detail.approval_id),
    toolName: requireString(detail.tool_name),
    consentPreview: requireString(detail.consent_preview),
    requestedAt,
    expiresAt,
    decision,
    outcome: outcome as ApprovalEventV1["outcome"],
    resolvedAt,
  };
}

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
    sessionTarget: optionalString(row.session_target ?? null),
    validActions: requireArray(row.valid_actions ?? []).filter(
      (action): action is "pause" | "resume" | "cancel" =>
        action === "pause" || action === "resume" || action === "cancel",
    ),
    recentRuns: requireArray(row.recent_runs ?? []).map(runtimeTaskRun),
  };
}

function taskError(value: unknown): TaskError | null {
  if (value === null || value === undefined) return null;
  const row = requireRecord(value);
  return {
    code: optionalString(row.code ?? null),
    message: optionalString(row.message ?? null),
  };
}

function taskDelivery(value: unknown): TaskDelivery | null {
  if (value === null || value === undefined) return null;
  const row = requireRecord(value);
  return {
    state: optionalString(row.state ?? null),
    mode: optionalString(row.mode ?? null),
    targets: requireArray(row.targets ?? []).map(requireString),
    error: taskError(row.error),
  };
}

function runtimeTaskRun(value: unknown): TaskRun {
  const row = requireRecord(value);
  const attempts = row.attempts;
  return {
    runId: requireString(row.run_id),
    state: optionalString(row.state ?? null),
    summary: optionalString(row.summary ?? null),
    attempts: typeof attempts === "number" && Number.isFinite(attempts) ? attempts : null,
    dueAt: optionalString(row.due_at ?? null),
    availableAt: optionalString(row.available_at ?? null),
    startedAt: optionalString(row.started_at ?? null),
    finishedAt: optionalString(row.finished_at ?? null),
    isolatedSessionId: optionalString(row.isolated_session_id ?? null),
    error: taskError(row.error),
    delivery: taskDelivery(row.delivery),
    deliveryTargets: requireArray(row.delivery_targets ?? []).map(requireString),
  };
}

function schedulerReadiness(value: unknown): SchedulerReadiness | null {
  if (value === null || value === undefined) return null;
  const row = requireRecord(value);
  return {
    state: requireString(row.state),
    hostedBy: optionalString(row.hosted_by ?? null),
    reason: optionalString(row.reason ?? null),
    lastHeartbeatAt: optionalString(row.last_heartbeat_at ?? null),
    checkCommand: optionalString(row.check_command ?? null),
  };
}

function pendingTaskAction(value: unknown): PendingTaskAction {
  const row = requireRecord(value);
  return {
    decisionId: requireString(row.decision_id),
    taskId: optionalString(row.task_id ?? null),
    reason: optionalString(row.reason ?? null),
    tool: optionalString(row.tool ?? null),
  };
}

function taskControlValue(payload: Record<string, unknown>, tasks: unknown[]): TaskControlValue {
  return {
    tasks: tasks.map(runtimeTask),
    pendingActions: requireArray(payload.pending_actions ?? []).map(pendingTaskAction),
    scheduler: schedulerReadiness(payload.scheduler),
  };
}

function delegationTask(value: unknown): DelegationTask {
  const row = requireRecord(value);
  return {
    taskId: requireString(row.task_id),
    a2aTraceId: optionalString(row.trace_id ?? null),
    agentId: optionalString(row.agent_id ?? null),
    method: optionalString(row.method ?? null),
    state: optionalString(row.state ?? row.status ?? null),
    currentStep: optionalString(row.current_step ?? null),
    progress:
      typeof row.progress === "number" && Number.isFinite(row.progress) ? row.progress : null,
    createdAt: optionalString(row.created_at ?? null),
    updatedAt: optionalString(row.updated_at ?? null),
  };
}

function delegationTimelineEntry(value: unknown): DelegationTimelineEntry {
  const row = requireRecord(value);
  return {
    timestamp: optionalString(row.timestamp ?? null),
    messageId: optionalString(row.message_id ?? null),
    a2aTraceId: optionalString(row.a2a_trace_id ?? null),
    fromAgent: optionalString(row.from_agent ?? null),
    toAgent: optionalString(row.to_agent ?? null),
    type: optionalString(row.type ?? null),
    method: optionalString(row.method ?? null),
    status: optionalString(row.status ?? null),
    taskId: optionalString(row.task_id ?? null),
    errorCode: optionalString(row.error_code ?? null),
  };
}

function delegationInspection(value: unknown): DelegationInspection {
  const outputs = requireRecord(value);
  const links = requireRecord(outputs.links);
  const childSession = requireRecord(outputs.child_session);
  const rawContent = requireRecord(outputs.raw_content);
  return {
    support: requireString(outputs.support),
    authority: requireString(outputs.authority),
    task: delegationTask(outputs.task),
    links: {
      invocationId: optionalString(links.invocation_id ?? null),
      sourceExecutionId: optionalString(links.source_execution_id ?? null),
      handoffId: optionalString(links.handoff_id ?? null),
    },
    timeline: requireArray(outputs.timeline).map(delegationTimelineEntry),
    childSession: {
      status: requireString(childSession.status),
      sessionId: optionalString(childSession.session_id ?? null),
    },
    rawContentStatus: requireString(rawContent.status),
  };
}

function delegationControlValue(
  payload: Record<string, unknown>,
  action: DelegationAction,
): DelegationControlValue {
  const outputs = requireRecord(payload.outputs ?? {});
  const inspection = action === "inspect" ? delegationInspection(outputs) : null;
  return {
    action,
    status: requireString(payload.status),
    agentId: optionalString(payload.agent_id ?? null),
    taskId: optionalString(payload.task_id ?? null),
    a2aTraceId: optionalString(payload.trace_id ?? null),
    content: action === "inspect" ? null : optionalString(payload.content ?? null),
    tasks:
      action === "list"
        ? requireArray(outputs.jobs ?? []).map(delegationTask)
        : inspection
          ? [inspection.task]
          : [],
    inspection,
  };
}

function scheduleArguments(input: unknown): string[] {
  const schedule = requireRecord(input);
  if (
    Object.keys(schedule).some(
      (key) => !["name", "instruction", "kind", "value", "timezone"].includes(key),
    )
  )
    throw protocolError("invalid_request", "Choose the schedule settings shown in the form.");
  const name = requireString(schedule.name).trim();
  const instruction = requireString(schedule.instruction).trim();
  const timing = requireString(schedule.value).trim();
  const timezone = requireString(schedule.timezone).trim();
  if (
    !name ||
    name.length > 120 ||
    !instruction ||
    instruction.length > 32_000 ||
    /\0/.test(name + instruction + timing + timezone)
  )
    throw protocolError("invalid_request", "Enter a name and an instruction for this schedule.");
  const args = ["schedule", "create", `--name=${name}`, `--instruction=${instruction}`];
  if (schedule.kind === "at") {
    if (!Number.isFinite(Date.parse(timing)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timing))
      throw protocolError("invalid_request", "Choose a date and time with a timezone.");
    args.push(`--at=${timing}`);
  } else if (schedule.kind === "every") {
    const minutes = Number(timing);
    if (!Number.isSafeInteger(minutes * 60_000) || minutes <= 0)
      throw protocolError("invalid_request", "Enter a positive interval in minutes.");
    args.push(`--every-ms=${minutes * 60_000}`);
  } else if (schedule.kind === "cron") {
    if (!timing || timing.length > 256 || !timezone || timezone.length > 128)
      throw protocolError("invalid_request", "Enter a cron expression and timezone.");
    args.push(`--cron=${timing}`, `--tz=${timezone}`);
  } else throw protocolError("invalid_request", "Choose a schedule type.");
  return args;
}

export class CliClient {
  readonly #context: () => CliCommandContext | null;
  readonly #run: RunCommand;
  readonly #drafts = new Map<string, DraftSession>();
  readonly #active = new Map<string, ActiveTurn>();
  readonly #taskControls = new Set<string>();

  constructor(
    context: () => CliCommandContext | null,
    run: RunCommand = runCommand,
    private readonly store?: DesktopStore,
  ) {
    this.#context = context;
    this.#run = run;
    for (const session of store?.draftSessions() ?? [])
      this.#drafts.set(session.sessionId, { ...session, isDraft: true });
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
      if (
        Object.keys(value).some(
          (key) =>
            ![
              "kind",
              "sessionId",
              "agentFilter",
              "skillId",
              "proposalId",
              "toolView",
              "graphView",
              "commandName",
              "arguments",
            ].includes(key),
        )
      )
        throw protocolError("invalid_request", "Choose a supported report.");
      if (value.graphView !== undefined && (value.kind !== "graph" || value.graphView !== "status"))
        throw protocolError("invalid_request", "Choose graph status.");
      if (this.#configuring)
        throw protocolError("settings_busy", "Wait for Settings to finish applying.");
      if (
        value.toolView !== undefined &&
        (value.kind !== "tools" || (value.toolView !== "status" && value.toolView !== "list"))
      )
        throw protocolError("invalid_request", "Choose tool status or list.");
      if (
        value.agentFilter !== undefined &&
        (value.kind !== "agents" ||
          typeof value.agentFilter !== "string" ||
          value.agentFilter.length > 512)
      )
        throw protocolError("invalid_request", "Choose an exact agent ID or name.");
      if (
        value.skillId !== undefined &&
        (value.kind !== "skills" ||
          typeof value.skillId !== "string" ||
          !value.skillId.trim() ||
          value.skillId.length > 512 ||
          /[\s\0/]/.test(value.skillId))
      )
        throw protocolError("invalid_request", "Choose an exact skill ID.");
      if (
        value.proposalId !== undefined &&
        (value.kind !== "learning" ||
          typeof value.proposalId !== "string" ||
          !value.proposalId.trim() ||
          value.proposalId.length > 512 ||
          /[\s\0/]/.test(value.proposalId))
      )
        throw protocolError("invalid_request", "Choose an exact proposal ID.");
      if (value.kind === "commands" || value.kind === "command") {
        const { sessionId } = validateLoadInput({ sessionId: value.sessionId } as SessionLoadInput);
        if (
          Object.keys(value).some(
            (key) => !["kind", "sessionId", "commandName", "arguments"].includes(key),
          )
        )
          throw protocolError("invalid_request", "Choose a session command.");
        const path = `/v1/sessions/${encodeURIComponent(sessionId)}/custom-commands`;
        if (value.kind === "commands") {
          if (value.commandName !== undefined || value.arguments !== undefined)
            throw protocolError("invalid_request", "Command discovery takes a conversation only.");
          if (this.#drafts.has(sessionId)) return { kind: "commands", commands: [] };
          const payload = await this.#request(path);
          if (payload.ok !== true || payload.session_id !== sessionId)
            throw protocolError(
              "invalid_daemon_response",
              "OpenMinion did not return this conversation's commands.",
            );
          return {
            kind: "commands",
            commands: requireArray(payload.commands).map((item) => {
              const command = requireRecord(item);
              return {
                name: requireString(command.name),
                description: requireString(command.description),
                usage: requireString(command.usage),
              };
            }),
          };
        }
        const name = requireString(value.commandName);
        const argumentsText = requireString(value.arguments);
        if (
          !/^\/[a-z][a-z0-9_-]*$/.test(name) ||
          name.length > 512 ||
          argumentsText.length > 32_000 ||
          argumentsText.includes("\0")
        )
          throw protocolError(
            "invalid_request",
            "Choose a discovered command and valid arguments.",
          );
        const payload = await this.#request(`${path}/${encodeURIComponent(name.slice(1))}/render`, {
          arguments: argumentsText,
        });
        if (payload.ok !== true || payload.session_id !== sessionId || payload.name !== name)
          throw protocolError(
            "invalid_daemon_response",
            "OpenMinion did not render the requested command.",
          );
        return { kind: "command", prompt: requireString(payload.prompt) };
      }
      if (value.commandName !== undefined || value.arguments !== undefined)
        throw protocolError("invalid_request", "Command arguments require a custom command.");
      if (value.kind === "status") {
        if (Object.keys(value).some((key) => !["kind", "sessionId"].includes(key)))
          throw protocolError("invalid_request", "Choose a conversation for status.");
        return { kind: "status", session: await this.#reportSession(value.sessionId) };
      }
      if (value.kind === "agents") {
        if (Object.keys(value).some((key) => !["kind", "sessionId", "agentFilter"].includes(key)))
          throw protocolError("invalid_request", "Choose an agent report or exact filter.");
        let activeAgentId: string | null = null;
        if (value.sessionId !== undefined) {
          const session = await this.#reportSession(value.sessionId);
          activeAgentId = session.activeAgentId ?? (await this.#endpoint()).defaultAgent;
        }
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
          activeAgentId,
          agents: agents.filter(
            (agent) =>
              !value.agentFilter ||
              agent.id === value.agentFilter ||
              agent.label === value.agentFilter,
          ),
        };
      }
      if (value.kind === "tools") {
        if (value.toolView === "status") {
          const sessionId =
            value.sessionId === undefined
              ? null
              : validateLoadInput({
                  sessionId: value.sessionId,
                } as SessionLoadInput).sessionId;
          const payload = await this.#request(
            `/v1/tools/exposure${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
          );
          if (payload.ok !== true)
            throw protocolError("report_unavailable", "Tool status is unavailable.");
          const exposure = requireRecord(payload.exposure);
          const lines = ["Tool exposure profiles:"];
          for (const item of requireArray(exposure.profiles)) {
            const profile = requireRecord(item);
            if (typeof profile.active !== "boolean")
              throw protocolError(
                "invalid_daemon_response",
                "OpenMinion did not report tool profile availability.",
              );
            lines.push(
              `  ${profile.active ? "active" : "hidden"}  ${requireString(profile.profile_id)} (${requireString(profile.tier)})  ${requireString(profile.dependency_readiness)}`,
            );
            for (const item of requireArray(profile.dependency_statuses)) {
              const dependency = requireRecord(item);
              const hints = requireArray(dependency.setup_hints ?? []);
              const detail =
                dependency.state === "ready"
                  ? optionalString(dependency.version ?? dependency.resolved_path ?? null)
                  : hints.length
                    ? optionalString(requireRecord(hints[0]).label ?? null)
                    : null;
              lines.push(
                `    ${requireString(dependency.dependency_id)}: ${requireString(dependency.state)}${detail ? ` · ${detail}` : ""}`,
              );
            }
          }
          if (lines.length === 1) lines.push("  (none)");
          const otherTools = requireArray(exposure.unprofiled_dependency_tools);
          if (otherTools.length) lines.push("Other tool dependencies:");
          for (const item of otherTools) {
            const tool = requireRecord(item);
            const dependencies = requireArray(tool.dependency_statuses).map((item) =>
              requireString(requireRecord(item).dependency_id),
            );
            lines.push(
              `  ${requireString(tool.tool_name)}: ${requireString(tool.dependency_readiness)}${dependencies.length ? ` (${dependencies.join(", ")})` : ""}`,
            );
          }
          if (exposure.security_lab !== undefined) {
            const lab = requireRecord(exposure.security_lab);
            if (lab.state !== "not_configured")
              lines.push(
                `Security lab: ${requireString(lab.state)}${lab.reason ? ` · ${requireString(lab.reason)}` : ""}`,
              );
          }
          return { kind: "tools", text: lines.join("\n") };
        }
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
      if (value.kind === "skills") {
        if (
          Object.keys(value).some((key) => !["kind", "skillId", "sessionId"].includes(key)) ||
          (value.skillId !== undefined && value.sessionId !== undefined)
        )
          throw protocolError(
            "invalid_request",
            "Choose a conversation catalog or an exact skill ID.",
          );
        if (value.skillId) {
          const payload = await this.#request(`/v1/skills/${encodeURIComponent(value.skillId)}`);
          if (payload.ok !== true)
            throw protocolError("report_unavailable", "Skill details are unavailable.");
          const skill = requireRecord(payload.skill);
          if (requireString(skill.skill_id) !== value.skillId)
            throw protocolError(
              "invalid_daemon_response",
              "OpenMinion returned a different skill.",
            );
          const sections = requireRecord(skill.sections ?? {});
          const lines = [
            `Skill: ${optionalString(skill.display_name ?? null) || requireString(skill.name)}`,
            `  id       ${requireString(skill.skill_id)}`,
            `  status   ${requireString(skill.status)}`,
            `  scope    ${requireString(skill.scope)}`,
            `  risk     ${requireString(skill.risk_class)}`,
            `  version  ${requireString(skill.version_hash)}`,
          ];
          const tools = requireArray(skill.tools ?? []).map(requireString);
          const tags = requireArray(skill.tags ?? []).map(requireString);
          if (tools.length) lines.push(`  tools    ${tools.join(", ")}`);
          if (tags.length) lines.push(`  tags     ${tags.join(", ")}`);
          for (const [key, content] of Object.entries(sections)) {
            if (typeof content === "string" && content.trim())
              lines.push(
                "",
                `${key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}:`,
                content.trim(),
              );
          }
          return { kind: "skills", text: lines.join("\n") };
        }
        let agentId: string | null = null;
        if (value.sessionId !== undefined) {
          const session = await this.#reportSession(value.sessionId);
          agentId = session.activeAgentId ?? (await this.#endpoint()).defaultAgent;
        }
        const payload = await this.#request(
          agentId ? `/v1/skills?agent_id=${encodeURIComponent(agentId)}` : "/v1/skills",
        );
        if (payload.ok !== true)
          throw protocolError("report_unavailable", "Skill discovery is unavailable.");
        return {
          kind: "skills",
          agentId,
          skills: requireArray(payload.skills).map((item) =>
            requireString(requireRecord(item).skill_id),
          ),
        };
      }
      if (value.kind === "learning") {
        if (value.sessionId !== undefined)
          throw protocolError("invalid_request", "Skill learning does not take a session ID.");
        if (value.proposalId) {
          const payload = await this.#request(
            `/v1/skills/proposals/${encodeURIComponent(value.proposalId)}`,
          );
          if (payload.ok !== true)
            throw protocolError("report_unavailable", "Learning proposal is unavailable.");
          const record = requireRecord(payload.proposal);
          const proposal = requireRecord(record.proposal ?? {});
          const draft = requireRecord(proposal.proposed_skill_definition ?? {});
          const review = requireRecord(record.review ?? {});
          const lines = [
            `Learning proposal: ${value.proposalId}`,
            `  state    ${optionalString(record.queue_state ?? null) ?? ""}`,
            `  workflow ${optionalString(record.source_task_shape_ref ?? null) ?? ""}`,
            `  name     ${optionalString(draft.display_name ?? null) || optionalString(draft.name ?? null) || ""}`,
            `  risk     ${optionalString(draft.risk_class ?? null) ?? ""}`,
            `  replay   ${record.replay_proof ? "recorded" : "missing"}`,
          ];
          const reviewStatus = optionalString(review.status ?? null) ?? "";
          if (reviewStatus) lines.push(`  review   ${reviewStatus}`);
          const addition = requireRecord(record.applied_addition ?? {});
          if (Object.keys(addition).length) {
            lines.push("  applied  yes");
            const skillId = requireString(addition.added_skill_id);
            const versionHash = requireString(addition.version_hash);
            lines.push(
              `Admit from the operator CLI: openminion skill admit --skill-id ${skillId} --version-hash ${versionHash} --expected-active-version-hash none --target-status verified --reason "Reviewed and approved proposal"`,
            );
          } else if (reviewStatus === "accepted") {
            lines.push(`Apply from the operator CLI: skillctl proposal-apply ${value.proposalId}`);
          } else {
            lines.push(
              `Inspect from the operator CLI: skillctl proposal-inspect ${value.proposalId}`,
            );
          }
          return { kind: "learning", text: lines.join("\n") };
        }
        const [statusPayload, inboxPayload] = await Promise.all([
          this.#request("/v1/skills/suggestions/status"),
          this.#request("/v1/skills/suggestions/inbox"),
        ]);
        if (statusPayload.ok !== true || inboxPayload.ok !== true)
          throw protocolError("report_unavailable", "Skill learning is unavailable.");
        const status = requireRecord(statusPayload.status);
        const suggestions = requireArray(inboxPayload.suggestions).slice(0, 20);
        const lines = [
          "Skill learning:",
          `  pending        ${Number(status.pending_count ?? 0)}`,
          `  surfaced       ${Number(status.surfaced_count ?? 0)}`,
          `  accepted       ${Number(status.accepted_count ?? 0)}`,
          `  rejected       ${Number(status.rejected_count ?? 0)}`,
          `  deferred       ${Number(status.deferred_count ?? 0)}`,
          `  auto-dismissed ${Number(status.auto_dismissed_count ?? 0)}`,
        ];
        if (suggestions.length) {
          lines.push("Pending proposals:");
          for (const item of suggestions) {
            const row = requireRecord(item);
            lines.push(
              `  - ${requireString(row.proposal_id)} · ${optionalString(row.display_name ?? null) || requireString(row.proposal_id)}`,
            );
          }
          lines.push("Use /learning <proposal_id> to view details.");
        } else lines.push("No pending skill proposals.");
        return { kind: "learning", text: lines.join("\n") };
      }
      if (value.kind === "mcp") {
        if (Object.keys(value).some((key) => !["kind", "sessionId"].includes(key)))
          throw protocolError("invalid_request", "Choose a conversation for MCP status.");
        let agentId: string | null = null;
        if (value.sessionId !== undefined) {
          const session = await this.#reportSession(value.sessionId);
          agentId = session.activeAgentId ?? (await this.#endpoint()).defaultAgent;
        }
        const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
        const payload = await this.#request(`/v1/runtime/capabilities${query}`);
        if (payload.ok !== true)
          throw protocolError("report_unavailable", "MCP status is unavailable.");
        const capabilities = requireRecord(payload.capabilities);
        const tools = requireRecord(capabilities.tools);
        const exposure = requireRecord(tools.mcp_exposure);
        const mcp = requireRecord(capabilities.mcp);
        const configured = requireArray(exposure.configured_servers).map(requireString);
        const exposed = requireArray(exposure.exposed_servers).map(requireString);
        const failed = requireRecord(mcp.failed_servers);
        const exposedCount = exposure.exposed_runtime_tool_count;
        const registeredCount = exposure.registered_runtime_tool_count;
        if (typeof exposedCount !== "number" || typeof registeredCount !== "number")
          throw protocolError("invalid_daemon_response", "Expected MCP tool counts.");
        const lines = [
          "MCP:",
          ...(agentId ? [`  agent       ${agentId}`] : []),
          `  configured  ${configured.join(", ") || "(none)"}`,
          `  exposed     ${exposed.join(", ") || "(none)"}`,
          `  tools       ${exposedCount} exposed · ${registeredCount} registered`,
        ];
        for (const [name, item] of Object.entries(failed))
          lines.push(`  failed      ${name}: ${requireString(requireRecord(item).message)}`);
        return { kind: "mcp", text: lines.join("\n") };
      }
      if (value.kind === "graph") {
        if (Object.keys(value).some((key) => !["kind", "graphView"].includes(key)))
          throw protocolError(
            "invalid_request",
            "Graph reports use this installation's configuration.",
          );
        const context = this.#requireContext();
        const result = await this.#run(
          context.executable,
          [...context.args, "graph", value.graphView === "status" ? "status" : "--help"],
          30_000,
        );
        if (result.exitCode !== 0)
          throw protocolError("report_unavailable", "OpenMinion could not read the graph report.");
        return { kind: "graph", text: result.stdout };
      }
      if (value.kind === "tokens") {
        const { sessionId } = validateLoadInput({
          sessionId: value.sessionId,
        } as SessionLoadInput);
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
      throw protocolError(
        "invalid_request",
        "Choose agents, tools, tokens, skills, MCP, or graph.",
      );
    });
  }

  controlTools(input: unknown): Promise<ClientResult<{ text: string }>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      const { sessionId } = validateLoadInput({ sessionId: value.sessionId } as SessionLoadInput);
      const action = value.action;
      if (action !== "activate" && action !== "deactivate")
        throw protocolError("invalid_request", "Choose activate or deactivate.");
      const fields =
        action === "activate"
          ? [
              "targetKind",
              "credentialScopes",
              "dependencies",
              "approved",
              "ttlSeconds",
              "reason",
              "approvedBy",
              "policySource",
            ]
          : [];
      if (
        Object.keys(value).some(
          (key) =>
            !["sessionId", "action", "profileId", "targetId", "taskId", ...fields].includes(key),
        )
      )
        throw protocolError("invalid_request", "Use only this tool profile action's fields.");
      const profileId = requireString(value.profileId).trim();
      if (!profileId || profileId.length > 512 || /[\s\0]/.test(profileId))
        throw protocolError("invalid_request", "Choose an exact tool profile ID.");
      const body: Record<string, unknown> = { session_id: sessionId, profile_id: profileId };
      for (const [key, field] of [
        ["targetId", "target_id"],
        ["taskId", "task_id"],
        ["targetKind", "target_kind"],
        ["reason", "activation_reason"],
        ["approvedBy", "approved_by"],
        ["policySource", "policy_source"],
      ]) {
        if (value[key] === undefined) continue;
        const text = requireString(value[key]);
        if (text.length > 4096 || text.includes("\0"))
          throw protocolError("invalid_request", "Tool profile fields must be valid text.");
        body[field] = text;
      }
      for (const [key, field] of [
        ["credentialScopes", "credential_scopes"],
        ["dependencies", "dependencies"],
      ]) {
        if (value[key] === undefined) continue;
        const items = requireArray(value[key]).map(requireString);
        if (
          items.length > 100 ||
          items.some((item) => !item.trim() || item.length > 512 || item.includes("\0"))
        )
          throw protocolError("invalid_request", "Choose valid credential and dependency names.");
        body[field] = items;
      }
      if (value.approved !== undefined) {
        if (typeof value.approved !== "boolean")
          throw protocolError("invalid_request", "Approval must be an explicit choice.");
        body.approved = value.approved;
      }
      if (value.ttlSeconds !== undefined) {
        if (
          typeof value.ttlSeconds !== "number" ||
          !Number.isFinite(value.ttlSeconds) ||
          value.ttlSeconds <= 0
        )
          throw protocolError("invalid_request", "Expiry must be a positive number of seconds.");
        body.ttl_seconds = value.ttlSeconds;
      }
      if (this.#configuring || this.#taskControls.has(sessionId))
        throw protocolError("task_control_busy", "Wait for the current operation to finish.");
      if (this.#active.has(sessionId))
        throw protocolError(
          "session_turn_active",
          "Finish or stop this turn before changing tool access.",
        );
      if (this.#drafts.has(sessionId))
        throw protocolError("session_not_found", "Send a message before changing tool access.");
      this.#taskControls.add(sessionId);
      try {
        const loaded = await this.load({ sessionId, messageLimit: 1 });
        if (!loaded.ok) throw protocolError(loaded.error.code, loaded.error.message);
        const payload = await this.#request(`/v1/tools/exposure/${action}`, body);
        if (payload.ok !== true)
          throw protocolError("tool_exposure_failed", "OpenMinion could not change tool access.");
        if (action === "deactivate") {
          if (typeof payload.deactivated !== "boolean")
            throw protocolError(
              "invalid_daemon_response",
              "OpenMinion did not report whether access changed.",
            );
          return { text: `${payload.deactivated ? "Deactivated" : "Not active"}: ${profileId}` };
        }
        const activation = requireRecord(payload.activation);
        if (activation.profile_id !== profileId)
          throw protocolError(
            "invalid_daemon_response",
            "OpenMinion returned a different tool profile.",
          );
        return { text: `Activated: ${profileId} (${requireString(activation.audit_id)})` };
      } finally {
        this.#taskControls.delete(sessionId);
      }
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
        throw protocolError(
          "session_not_found",
          "Send a message before exporting this conversation.",
        );
      return this.#command(["export", "transcript", "--session-id", sessionId, "--format", "md"]);
    });
  }

  controlTasks(input: unknown): Promise<ClientResult<TaskControlValue>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (
        Object.keys(value).some(
          (key) => !["sessionId", "action", "taskId", "schedule"].includes(key),
        )
      )
        throw protocolError("invalid_request", "Choose a supported task operation.");
      const { sessionId } = validateLoadInput({
        sessionId: value.sessionId,
      } as SessionLoadInput);
      if (sessionId.startsWith("-") || sessionId.includes("\0"))
        throw protocolError("invalid_request", "Choose a saved conversation.");
      const action = requireString(value.action);
      if (!["list", "show", "pause", "resume", "cancel", "schedule"].includes(action))
        throw protocolError("invalid_request", "Choose a supported task action.");
      if (action !== "schedule" && value.schedule !== undefined)
        throw protocolError(
          "invalid_request",
          "Schedule fields are only valid when creating a schedule.",
        );
      if (["list", "schedule"].includes(action) && value.taskId !== undefined)
        throw protocolError("invalid_request", "This operation does not take a task ID.");
      const taskId = ["list", "schedule"].includes(action) ? null : requireString(value.taskId);
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
      let scheduled = false;
      try {
        const loaded = await this.load({ sessionId, messageLimit: 1 });
        if (!loaded.ok) throw protocolError(loaded.error.code, loaded.error.message);
        const scope = ["--session", sessionId, "--json"];
        if (loaded.value.session.activeAgentId)
          scope.push("--agent-id", loaded.value.session.activeAgentId);
        if (action === "schedule") {
          const result = requireRecord(
            await this.#json([...scheduleArguments(value.schedule), ...scope]),
          );
          if (result.ok !== true)
            throw protocolError("schedule_failed", "OpenMinion did not create this schedule.");
          scheduled = true;
        }
        const list = action === "list" || action === "schedule";
        const args = ["tasks", list ? "list" : action, ...(taskId ? [taskId] : []), ...scope];
        const payload = requireRecord(await this.#json(args));
        if (payload.ok !== true) {
          const detail =
            payload.error && typeof payload.error === "object"
              ? requireRecord(payload.error)
              : null;
          throw protocolError(
            optionalString(payload.error_code ?? detail?.code ?? null) ?? "task_control_failed",
            (typeof payload.error === "string" && payload.error) ||
              optionalString(detail?.message ?? null) ||
              "OpenMinion did not complete this task operation.",
          );
        }
        return taskControlValue(payload, list ? requireArray(payload.tasks) : [payload.task]);
      } catch (error) {
        if (scheduled)
          throw protocolError(
            "schedule_refresh_failed",
            "Your schedule was created. Refresh the work list to see its details.",
          );
        throw error;
      } finally {
        if (mutating) this.#taskControls.delete(sessionId);
      }
    });
  }

  controlDelegation(input: unknown): Promise<ClientResult<DelegationControlValue>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (
        Object.keys(value).some(
          (key) =>
            ![
              "sessionId",
              "action",
              "targetAgentId",
              "instruction",
              "taskId",
              "timeoutSeconds",
              "limit",
            ].includes(key),
        )
      )
        throw protocolError("invalid_request", "Choose a supported delegation operation.");
      const { sessionId } = validateLoadInput({
        sessionId: value.sessionId,
      } as SessionLoadInput);
      const action = requireString(value.action) as DelegationAction;
      if (
        !["sync", "async", "list", "status", "resume", "result", "inspect", "cancel"].includes(
          action,
        )
      )
        throw protocolError("invalid_request", "Choose a supported delegation action.");
      if (action === "resume")
        throw protocolError(
          "unsupported_operation",
          "OpenMinion does not resume delegated jobs. Start new delegated work instead.",
        );
      const start = action === "sync" || action === "async";
      const list = action === "list";
      const lifecycle = !start && !list;
      if (
        (!start && (value.targetAgentId !== undefined || value.instruction !== undefined)) ||
        (!start && value.timeoutSeconds !== undefined) ||
        (!list && value.limit !== undefined) ||
        (!lifecycle && value.taskId !== undefined)
      )
        throw protocolError("invalid_request", "Use only the fields for this delegation action.");
      const targetAgentId = start ? requireString(value.targetAgentId).trim() : "";
      const instruction = start ? requireString(value.instruction).trim() : "";
      const timeoutSeconds = start ? Number(value.timeoutSeconds ?? 120) : 30;
      const taskId = lifecycle ? requireString(value.taskId).trim() : "";
      const limit = list ? Number(value.limit ?? 20) : 20;
      if (start && (!targetAgentId || targetAgentId.length > 512 || /[\s\0]/.test(targetAgentId)))
        throw protocolError("invalid_request", "Choose an exact target agent ID.");
      if (start && (!instruction || instruction.length > 32_000 || instruction.includes("\0")))
        throw protocolError("invalid_request", "Enter a delegation instruction.");
      if (
        start &&
        (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
      )
        throw protocolError("invalid_request", "Choose a timeout from 1 to 3600 seconds.");
      if (
        lifecycle &&
        (!taskId || taskId.length > 512 || taskId.startsWith("-") || /[\s\0]/.test(taskId))
      )
        throw protocolError("invalid_request", "Choose an exact delegated task ID.");
      if (list && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200))
        throw protocolError("invalid_request", "Choose a list limit from 1 to 200.");
      const mutating = start || action === "cancel";
      if (this.#configuring || this.#taskControls.has(sessionId))
        throw protocolError("task_control_busy", "Wait for the current operation to finish.");
      if (mutating && this.#active.has(sessionId))
        throw protocolError(
          "session_turn_active",
          "Finish or stop this turn before changing delegated work.",
        );
      if (mutating) this.#taskControls.add(sessionId);
      try {
        const loaded = await this.load({ sessionId, messageLimit: 1 });
        if (!loaded.ok) throw protocolError(loaded.error.code, loaded.error.message);
        const parentAgentId = loaded.value.session.activeAgentId;
        if (!parentAgentId)
          throw protocolError("delegation_unavailable", "This conversation has no active agent.");
        const context = this.#requireContext();
        const command = start ? "delegate" : `delegate-${action}`;
        const help = await this.#run(
          context.executable,
          [...context.args, "agent", command, "--help"],
          30_000,
        );
        if (
          help.exitCode !== 0 ||
          !help.stdout.includes("--parent-agent-id") ||
          !help.stdout.includes("--session-id")
        )
          throw protocolError(
            "delegation_unavailable",
            "This OpenMinion runtime does not support this conversation-scoped delegation action. Update the runtime before using it.",
          );
        const scope = ["--parent-agent-id", parentAgentId, "--session-id", sessionId, "--json"];
        const args = start
          ? [
              "agent",
              "delegate",
              `--target-agent-id=${targetAgentId}`,
              `--instruction=${instruction}`,
              "--mode",
              action,
              "--timeout-seconds",
              String(timeoutSeconds),
              ...scope,
            ]
          : list
            ? ["agent", "delegate-list", "--limit", String(limit), ...scope]
            : ["agent", `delegate-${action}`, "--task-id", taskId, ...scope];
        const payload = requireRecord(
          await this.#json(args, start ? (timeoutSeconds + 10) * 1000 : 30_000),
        );
        if (payload.ok !== true) {
          const error = requireRecord(payload.error ?? {});
          throw protocolError(
            optionalString(error.code ?? null) ?? "delegation_failed",
            optionalString(error.message ?? null) ?? "OpenMinion could not complete delegation.",
          );
        }
        return delegationControlValue(payload, action);
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
        this.store?.promoteDraftSession(id);
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
        title: value.title ?? "New conversation",
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
      this.store?.rememberDraftSession(draft);
      this.#drafts.set(draft.sessionId, draft);
      return draft;
    });
  }

  load(input: SessionLoadInput): Promise<ClientResult<SessionLoadValue>> {
    return this.#control(async () => {
      const value = validateLoadInput(input);
      const draft = this.#drafts.get(value.sessionId);
      if (draft)
        return {
          session: draft,
          messages: [],
          nextMessageCursor: "0",
          messagesHasMore: false,
        };
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
        .map((row) => {
          const metadata = requireRecord(row.metadata ?? {});
          // PyPI 0.0.19 exports the same runtime stats inside message metadata.
          const stats =
            row.stats === undefined && metadata.run_stats_json !== undefined
              ? JSON.parse(requireString(metadata.run_stats_json))
              : row.stats;
          return {
            schemaVersion: 1 as const,
            id: requireString(row.id),
            sessionId: value.sessionId,
            role: (row.role === "inbound" || row.role === "user" ? "user" : "assistant") as
              | "user"
              | "assistant",
            body: requireString(row.body),
            profileName: optionalString(metadata.display_name ?? null),
            ...(stats === undefined ? {} : { usage: usageValue(stats) }),
            createdAt: requireString(row.created_at),
          };
        });
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
          "Finish or cancel the turn before closing this conversation.",
        );
      const draft = this.#drafts.get(value.sessionId);
      if (draft) {
        this.store?.removeDraft(value.sessionId);
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
      const closed = summary(
        requireRecord(await this.#json(["sessions", "show", value.sessionId, "--json"])),
        true,
      );
      this.store?.removeDraft(value.sessionId);
      return closed;
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
      const pending: ActiveTurn = {
        identity: null,
        disconnected: false,
        replaySupported: false,
        lastSequence: 0,
        receivedResponse: false,
        outcome: "complete",
        emit,
      };
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
        approval_transport: "turn_stream",
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

  async reconnect(input: TurnCancelInput): Promise<ClientResult<TurnSubmitValue>> {
    let active: ActiveTurn | undefined;
    try {
      const value = validateCancelInput(input);
      active = this.#active.get(value.sessionId);
      if (!active?.identity || active.identity.traceId !== value.traceId)
        return failure("trace_not_found", "This turn is not tracked by Desktop.");
      if (!active.disconnected)
        return failure("stream_connected", "This turn is already connected or reconnecting.");
      active.disconnected = false;
      const status = await this.#request(`/v1/turn/${encodeURIComponent(value.traceId)}/status`);
      const stream = requireRecord(status.stream);
      if (
        status.ok !== true ||
        status.trace_id !== value.traceId ||
        status.session_id !== value.sessionId ||
        stream.schema_version !== "openminion.turn-stream.v1" ||
        !Number.isSafeInteger(stream.replay_floor_sequence) ||
        Number(stream.replay_floor_sequence) < 1
      )
        throw protocolError(
          "stream_identity_mismatch",
          "OpenMinion returned a different turn identity.",
        );
      if (!active.replaySupported || active.lastSequence === null)
        throw protocolError(
          "stream_replay_unavailable",
          "This turn is still active, but its live updates cannot be restored. Check its status again later.",
        );
      if (active.lastSequence < Number(stream.replay_floor_sequence) - 1)
        throw protocolError(
          "stream_replay_gap",
          "This turn is still active, but some live updates are no longer available. Check its status again later.",
        );
      const endpoint = await this.#endpoint();
      const cursor = active.lastSequence;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: endpoint.host,
            port: endpoint.port,
            path: `/v1/turn/${encodeURIComponent(value.traceId)}/stream?after_sequence=${cursor}`,
            method: "GET",
            headers: { "X-IPC-Token": endpoint.token, Accept: "text/event-stream" },
          },
          resolve,
        );
        req.setTimeout(30_000, () => req.destroy(new Error("daemon_timeout")));
        req.on("error", reject);
        req.end();
      });
      if (response.statusCode === 404) {
        response.destroy();
        throw protocolError("trace_not_found", "The runtime no longer has this live turn.");
      }
      if (
        response.statusCode !== 200 ||
        !response.headers["content-type"]?.startsWith("text/event-stream")
      ) {
        response.destroy();
        throw protocolError(
          "stream_reconnect_failed",
          "OpenMinion could not reconnect this turn.",
          true,
        );
      }
      response.setTimeout(0);
      return await this.#stream(
        response,
        active,
        value.sessionId,
        value.traceId,
        active.emit,
        true,
      );
    } catch (error) {
      const result = failureFrom(error);
      if (active?.identity) {
        active.disconnected = true;
        const unavailable = result.error.code === "trace_not_found";
        if (unavailable) this.#active.delete(active.identity.sessionId);
        active.emit({
          schemaVersion: 1,
          kind: "connection",
          sessionId: active.identity.sessionId,
          traceId: active.identity.traceId,
          state: unavailable ? "unavailable" : "disconnected",
          error: result.error,
        });
      }
      return result;
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

  listTurnInputs(input: TurnInputListInput): Promise<ClientResult<TurnInputQueueEntry[]>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (Object.keys(value).some((key) => key !== "sessionId"))
        throw protocolError("invalid_request", "Choose a conversation to view its queue.");
      const sessionId = queueIdentifier(value.sessionId, "session ID");
      const payload = await this.#request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/turn-inputs?status=queued&status=steer_deferred`,
      );
      return requireArray(payload.entries).map((entry) => {
        const queued = turnInputQueueEntry(entry);
        if (queued.sessionId !== sessionId)
          throw protocolError(
            "invalid_daemon_response",
            "OpenMinion returned a queued prompt for another conversation.",
          );
        return queued;
      });
    });
  }

  enqueueTurnInput(input: TurnInputEnqueueInput): Promise<ClientResult<TurnInputQueueEntry>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (Object.keys(value).some((key) => !["sessionId", "agentId", "text"].includes(key)))
        throw protocolError("invalid_request", "Queue only the message shown in the composer.");
      const sessionId = queueIdentifier(value.sessionId, "session ID");
      const agentId = queueIdentifier(value.agentId, "agent ID");
      const text = requireString(value.text).trim();
      if (!text || text.length > 250_000 || text.includes("\0"))
        throw protocolError("invalid_request", "Enter a message before queueing it.");
      const payload = await this.#request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/turn-inputs`,
        {
          agent_id: agentId,
          text,
          intent: "queue_next",
          source_client: "desktop",
          idempotency_key: randomUUID(),
        },
        "POST",
        202,
      );
      return turnInputQueueEntry(payload.entry);
    });
  }

  dropTurnInput(input: TurnInputDropInput): Promise<ClientResult<TurnInputQueueEntry>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (
        Object.keys(value).some(
          (key) => !["sessionId", "queueId", "statusVersion"].includes(key),
        ) ||
        !Number.isSafeInteger(value.statusVersion) ||
        Number(value.statusVersion) < 1
      )
        throw protocolError("invalid_request", "Choose a current queued prompt to remove.");
      const sessionId = queueIdentifier(value.sessionId, "session ID");
      const queueId = queueIdentifier(value.queueId, "queue ID");
      const payload = await this.#request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/turn-inputs/${encodeURIComponent(queueId)}`,
        { status_version: Number(value.statusVersion) },
        "DELETE",
      );
      return turnInputQueueEntry(payload.entry);
    });
  }

  moveTurnInput(input: TurnInputMoveInput): Promise<ClientResult<TurnInputQueueEntry>> {
    return this.#control(async () => {
      const value = requireRecord(input);
      if (
        Object.keys(value).some(
          (key) =>
            !["sessionId", "queueId", "statusVersion", "beforeQueueId", "afterQueueId"].includes(
              key,
            ),
        ) ||
        !Number.isSafeInteger(value.statusVersion) ||
        Number(value.statusVersion) < 1 ||
        (value.beforeQueueId === undefined) === (value.afterQueueId === undefined)
      )
        throw protocolError("invalid_request", "Choose one new position for this prompt.");
      const sessionId = queueIdentifier(value.sessionId, "session ID");
      const queueId = queueIdentifier(value.queueId, "queue ID");
      const body: Record<string, unknown> = {
        status_version: Number(value.statusVersion),
      };
      if (value.beforeQueueId !== undefined)
        body.before_queue_id = queueIdentifier(value.beforeQueueId, "queue position");
      if (value.afterQueueId !== undefined)
        body.after_queue_id = queueIdentifier(value.afterQueueId, "queue position");
      const payload = await this.#request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/turn-inputs/${encodeURIComponent(queueId)}/move`,
        body,
      );
      return turnInputQueueEntry(payload.entry);
    });
  }

  async cancelAndRunNext(
    input: TurnInputRunNextInput,
    emit: (event: TurnEventV1) => void,
  ): Promise<ClientResult<TurnSubmitValue>> {
    let pending: ActiveTurn | null = null;
    let sessionId = "";
    try {
      const value = requireRecord(input);
      if (
        Object.keys(value).some(
          (key) => !["sessionId", "traceId", "agentId", "expectedQueueId"].includes(key),
        )
      )
        throw protocolError("invalid_request", "Choose the current turn and next prompt.");
      sessionId = queueIdentifier(value.sessionId, "session ID");
      const traceId = queueIdentifier(value.traceId, "trace ID");
      const agentId = queueIdentifier(value.agentId, "agent ID");
      const expectedQueueId = queueIdentifier(value.expectedQueueId, "queue ID");
      const current = this.#active.get(sessionId);
      if (current?.identity?.traceId !== traceId)
        throw protocolError("trace_not_found", "This turn is not active in Desktop.");
      const payload = await this.#request(
        `/v1/turn/${encodeURIComponent(traceId)}/cancel-and-run-next`,
        {
          session_id: sessionId,
          agent_id: agentId,
          expected_queue_id: expectedQueueId,
        },
        "POST",
        202,
      );
      const nextTraceId = queueIdentifier(payload.next_trace_id, "next trace ID");
      const entry = turnInputQueueEntry(payload.entry);
      if (
        payload.ok !== true ||
        payload.cancelled !== true ||
        payload.trace_id !== traceId ||
        entry.queueId !== expectedQueueId ||
        entry.status !== "running" ||
        entry.traceId !== nextTraceId
      )
        throw protocolError(
          "invalid_daemon_response",
          "OpenMinion did not start the expected queued prompt.",
        );
      pending = {
        identity: null,
        disconnected: false,
        replaySupported: false,
        lastSequence: 0,
        receivedResponse: false,
        outcome: "complete",
        emit,
      };
      this.#active.set(sessionId, pending);
      const endpoint = await this.#endpoint();
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: endpoint.host,
            port: endpoint.port,
            path: `/v1/turn/${encodeURIComponent(nextTraceId)}/stream?after_sequence=0`,
            method: "GET",
            headers: { "X-IPC-Token": endpoint.token, Accept: "text/event-stream" },
          },
          resolve,
        );
        req.setTimeout(30_000, () => req.destroy(new Error("daemon_timeout")));
        req.on("error", reject);
        req.end();
      });
      if (
        response.statusCode !== 200 ||
        !response.headers["content-type"]?.startsWith("text/event-stream")
      ) {
        response.destroy();
        throw protocolError(
          "stream_reconnect_failed",
          "OpenMinion started the queued prompt, but Desktop could not attach its response.",
          true,
        );
      }
      response.setTimeout(0);
      return await this.#stream(response, pending, sessionId, nextTraceId, emit);
    } catch (error) {
      if (pending && this.#active.get(sessionId) === pending) this.#active.delete(sessionId);
      return failureFrom(error);
    }
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
      return {
        ok: true,
        value: { sessionId: validateCloseInput(input).sessionId },
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  decide(input: ApprovalDecisionInput): Promise<ClientResult<ApprovalDecisionV1>> {
    return this.#control(async () => {
      const value = validateApprovalDecisionInput(input);
      const payload = await this.#request("/v1/approvals/resume", {
        session_id: value.sessionId,
        trace_id: value.traceId,
        approval_id: value.approvalId,
        decision: value.decision,
      });
      if (payload.ok !== true) {
        throw protocolError("invalid_daemon_response", "OpenMinion did not resolve the approval.");
      }
      const outcome = requireString(payload.outcome) as ApprovalDecisionV1["outcome"];
      if (outcome !== "applied" && outcome !== "denied") {
        throw protocolError(
          "invalid_daemon_response",
          "OpenMinion returned an invalid approval outcome.",
        );
      }
      const result = {
        schemaVersion: 1 as const,
        sessionId: requireString(payload.session_id),
        traceId: requireString(payload.trace_id),
        approvalId: requireString(payload.approval_id),
        decision: requireString(payload.decision),
        outcome,
        resolvedAt: requireString(payload.resolved_at),
      };
      if (
        result.sessionId !== value.sessionId ||
        result.traceId !== value.traceId ||
        result.approvalId !== value.approvalId ||
        result.decision !== value.decision
      ) {
        throw protocolError(
          "invalid_daemon_response",
          "The resolved approval identity did not match.",
        );
      }
      return { ...result, decision: value.decision };
    });
  }

  async listArtifacts(_input: ArtifactListInput): Promise<ClientResult<ArtifactListValue>> {
    return unsupported("Artifact browsing");
  }

  async readArtifact(_input: ArtifactReadInput): Promise<ClientResult<ArtifactContentV1>> {
    return unsupported("Artifact browsing");
  }

  async detachArtifact(
    _input: ArtifactDecisionInput,
  ): Promise<ClientResult<ArtifactDecisionValue>> {
    return unsupported("Artifact changes");
  }

  async restoreArtifact(
    _input: ArtifactDecisionInput,
  ): Promise<ClientResult<ArtifactDecisionValue>> {
    return unsupported("Artifact changes");
  }

  async uploadMedia(_input: unknown): Promise<ClientResult<MediaAttachmentV1>> {
    return unsupported("Attachments and screenshots");
  }

  async releaseMedia(_input: MediaReleaseInput): Promise<ClientResult<MediaReleaseValue>> {
    return unsupported("Attachments and screenshots");
  }

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

  async #command(args: string[], timeoutMs = 30_000): Promise<string> {
    const context = this.#requireContext();
    const result = await this.#run(context.executable, [...context.args, ...args], timeoutMs);
    if (result.exitCode !== 0)
      throw protocolError(
        "cli_command_failed",
        "OpenMinion could not complete this operation. Check the runtime connection and configuration.",
      );
    return result.stdout;
  }

  async #json(args: string[], timeoutMs = 30_000): Promise<unknown> {
    const context = this.#requireContext();
    const result = await this.#run(context.executable, [...context.args, ...args], timeoutMs);
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      if (result.exitCode === 0) throw error;
      throw protocolError(
        "cli_command_failed",
        "OpenMinion could not complete this operation. Check the runtime connection and configuration.",
      );
    }
  }

  async #reportSession(id: unknown): Promise<SessionSummaryV1> {
    const { sessionId } = validateLoadInput({ sessionId: id } as SessionLoadInput);
    if (sessionId.startsWith("-") || sessionId.includes("\0"))
      throw protocolError("invalid_request", "Choose a valid session ID.");
    const draft = this.#drafts.get(sessionId);
    if (draft) return draft;
    const session = summary(
      requireRecord(await this.#json(["sessions", "show", sessionId, "--json"])),
      true,
    );
    if (session.sessionId !== sessionId)
      throw protocolError("invalid_daemon_response", "The returned session does not match.");
    return session;
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

  async #request(
    path: string,
    body?: Record<string, unknown>,
    method: "GET" | "POST" | "DELETE" = body === undefined ? "GET" : "POST",
    acceptedStatus = 200,
  ): Promise<Record<string, unknown>> {
    const endpoint = await this.#endpoint();
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? "" : JSON.stringify(body);
      const req = request(
        {
          hostname: endpoint.host,
          port: endpoint.port,
          path,
          method,
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
              if (response.statusCode !== acceptedStatus) {
                const error = errorValue(payload.error);
                throw protocolError(error.code, error.message, error.retryable, error.retryAfterMs);
              }
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
    reconnecting = false,
  ): Promise<ClientResult<TurnSubmitValue>> {
    return new Promise((resolve) => {
      let buffer = "";
      let bytes = 0;
      let terminal = false;
      let receivedMeta = false;
      const fail = (interrupted = false, detail?: ErrorV1) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(startupTimer);
        if (interrupted && active.identity) {
          active.disconnected = true;
          const result = detail
            ? { ok: false as const, error: detail }
            : failure(
                "stream_interrupted",
                "Connection interrupted. The turn may still be running.",
                active.replaySupported && active.lastSequence !== null,
              );
          if (detail && !detail.retryable) active.replaySupported = false;
          emit({
            schemaVersion: 1,
            kind: "connection",
            sessionId,
            traceId,
            state: "disconnected",
            error: result.error,
          });
          resolve(result);
          response.destroy();
          return;
        }
        if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
        const result = failure(
          "daemon_stream_failed",
          "The OpenMinion stream ended unexpectedly. Reload the conversation before sending again.",
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
      const startupTimer = setTimeout(() => fail(true), 30_000);
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
                  receivedMeta ||
                  (!reconnecting && active.identity) ||
                  data.session_id !== sessionId ||
                  data.trace_id !== traceId ||
                  data.stream_schema_version !== "openminion.turn-stream.v1"
                )
                  throw protocolError(
                    "stream_identity_mismatch",
                    "OpenMinion returned a different turn identity.",
                  );
                if (
                  reconnecting &&
                  (!Number.isSafeInteger(data.replay_floor_sequence) ||
                    Number(data.replay_floor_sequence) < 1 ||
                    active.lastSequence === null ||
                    active.lastSequence < Number(data.replay_floor_sequence) - 1)
                )
                  throw protocolError(
                    "stream_replay_gap",
                    "This turn is still active, but some live updates are no longer available. Check its status again later.",
                  );
                active.replaySupported =
                  Array.isArray(data.capabilities) &&
                  data.capabilities.includes("active_turn_replay");
                active.identity = {
                  requestId: requireString(data.request_id),
                  traceId: requireString(data.trace_id),
                  sessionId,
                };
                receivedMeta = true;
                clearTimeout(startupTimer);
                if (reconnecting)
                  emit({
                    schemaVersion: 1,
                    kind: "connection",
                    sessionId,
                    traceId,
                    state: "reconnected",
                    error: null,
                  });
                else emit({ schemaVersion: 1, kind: "started", ...active.identity });
                resolve({ ok: true, value: active.identity });
              } else {
                if (
                  !receivedMeta ||
                  !active.identity ||
                  (row.event !== "error" && data.trace_id !== active.identity.traceId)
                )
                  throw protocolError(
                    "stream_identity_mismatch",
                    "OpenMinion returned a different turn identity.",
                  );
                if (row.event === "chunk") {
                  const eventId = lines.find((item) => item.startsWith("id: "))?.slice(4);
                  if (data.sequence !== undefined || eventId !== undefined) {
                    if (
                      !Number.isSafeInteger(data.sequence) ||
                      Number(data.sequence) < 1 ||
                      eventId !== `${traceId}:${data.sequence}` ||
                      data.event_id !== eventId
                    )
                      throw protocolError(
                        "invalid_daemon_response",
                        "OpenMinion returned an invalid stream cursor.",
                      );
                    if (
                      active.lastSequence !== null &&
                      Number(data.sequence) <= active.lastSequence
                    ) {
                      newline = buffer.indexOf("\n\n");
                      continue;
                    }
                    if (
                      active.lastSequence !== null &&
                      Number(data.sequence) !== active.lastSequence + 1
                    )
                      throw protocolError(
                        "stream_replay_gap",
                        "This turn is still active, but some live updates are no longer available. Check its status again later.",
                      );
                    active.lastSequence = Number(data.sequence);
                  } else {
                    if (reconnecting)
                      throw protocolError(
                        "invalid_daemon_response",
                        "OpenMinion omitted the replay cursor.",
                      );
                    active.lastSequence = null;
                  }
                  const detail = requireRecord(data.data);
                  if (data.kind === "status") {
                    const label = publicStatusText(detail);
                    if (label !== null)
                      emit({
                        schemaVersion: 1,
                        kind: "progress",
                        progressKind: "status",
                        sessionId,
                        traceId: active.identity.traceId,
                        statusKey: requireString(detail.status_key),
                        label,
                        detailText: null,
                        createdAt: requireString(data.ts),
                      });
                  }
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
                  if (data.kind === "tool_started" || data.kind === "tool_completed")
                    emit(toolProgressEvent(data, detail, active.identity));
                  if (data.kind === "approval") {
                    emit(approvalEvent(detail, active.identity));
                  }
                } else if (row.event === "response") {
                  const response = responseEvent(data, active.identity);
                  active.receivedResponse = true;
                  this.#drafts.delete(sessionId);
                  if (response.errors.length)
                    active.outcome = response.errors.some((error) => error.code === "cancelled")
                      ? "cancelled"
                      : "error";
                  emit(response);
                } else if (row.event === "error") {
                  active.outcome = "error";
                  emit({
                    schemaVersion: 1,
                    kind: "error",
                    sessionId,
                    traceId: active.identity.traceId,
                    error: errorValue(data),
                  });
                } else if (row.event === "done") {
                  if (!["complete", "error"].includes(String(data.status)))
                    throw protocolError(
                      "invalid_daemon_response",
                      "OpenMinion returned an invalid stream outcome.",
                    );
                  if (data.status === "error") active.outcome = "error";
                  if (active.outcome === "complete" && !active.receivedResponse)
                    throw protocolError(
                      "invalid_daemon_response",
                      "OpenMinion omitted the turn response.",
                    );
                  terminal = true;
                  response.destroy();
                  clearTimeout(startupTimer);
                  if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
                  emit({
                    schemaVersion: 1,
                    kind: "done",
                    sessionId,
                    traceId: active.identity.traceId,
                    outcome: active.outcome,
                  });
                } else
                  throw protocolError(
                    "invalid_daemon_response",
                    "OpenMinion returned an unsupported stream event.",
                  );
              }
            }
            newline = buffer.indexOf("\n\n");
          }
        } catch (error) {
          if (reconnecting) fail(true, failureFrom(error).error);
          else fail();
        }
      });
      response.on("error", () => fail(true));
      response.on("close", () => {
        if (!terminal) fail(true);
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
  const messageCount = row.turns ?? null;
  if (
    messageCount !== null &&
    (typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 0)
  )
    throw protocolError("invalid_daemon_response", "OpenMinion returned an invalid message count.");
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
    channel: optionalString(row.channel ?? null),
    messageCount,
    updatedLabel: detail ? null : optionalString(row.age ?? null),
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
