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
  TurnSubmitInput,
  TurnSubmitValue,
} from "../shared/contracts.js";
import type { ReportValue } from "../shared/reports.js";
import type {
  PendingTaskAction,
  RuntimeTask,
  SchedulerReadiness,
  TaskControlValue,
  TaskDelivery,
  TaskError,
  TaskRun,
} from "../shared/tasks.js";
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
type ActiveTurn = { identity: TurnSubmitValue | null };

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
      if (
        Object.keys(value).some(
          (key) =>
            ![
              "kind",
              "sessionId",
              "agentFilter",
              "agentId",
              "skillId",
              "proposalId",
              "toolView",
            ].includes(key),
        )
      )
        throw protocolError("invalid_request", "Choose a supported report.");
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
      if (
        value.agentId !== undefined &&
        (value.kind !== "mcp" ||
          typeof value.agentId !== "string" ||
          !value.agentId.trim() ||
          value.agentId.length > 512 ||
          /[\s\0]/.test(value.agentId))
      )
        throw protocolError("invalid_request", "Choose an exact agent ID.");
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
        if (value.sessionId !== undefined)
          throw protocolError("invalid_request", "Skill discovery does not take a session ID.");
        if (value.skillId) {
          const payload = await this.#request(`/v1/skills/${encodeURIComponent(value.skillId)}`);
          if (payload.ok !== true)
            throw protocolError("report_unavailable", "Skill details are unavailable.");
          const skill = requireRecord(payload.skill);
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
        const payload = await this.#request("/v1/skills");
        if (payload.ok !== true)
          throw protocolError("report_unavailable", "Skill discovery is unavailable.");
        const skills = requireArray(payload.skills)
          .map((item) => requireString(requireRecord(item).skill_id))
          .slice(0, 20);
        return {
          kind: "skills",
          text: skills.length
            ? `Skills:\n${skills.map((id) => `  - ${id} · catalog`).join("\n")}\nUse /skills <skill-id> to view details.`
            : "(no skills)",
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
          if (Object.keys(review).length)
            lines.push(`  review   ${optionalString(review.status ?? null) ?? ""}`);
          if (record.applied_addition) lines.push("  applied  yes");
          lines.push(
            `Review and apply from the operator CLI: openminion skill proposal-inspect ${value.proposalId}`,
          );
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
        if (value.sessionId !== undefined)
          throw protocolError("invalid_request", "MCP status does not take a session ID.");
        const query = value.agentId ? `?agent_id=${encodeURIComponent(value.agentId)}` : "";
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
          `  configured  ${configured.join(", ") || "(none)"}`,
          `  exposed     ${exposed.join(", ") || "(none)"}`,
          `  tools       ${exposedCount} exposed · ${registeredCount} registered`,
        ];
        for (const [name, item] of Object.entries(failed))
          lines.push(`  failed      ${name}: ${requireString(requireRecord(item).message)}`);
        return { kind: "mcp", text: lines.join("\n") };
      }
      if (value.kind === "graph") {
        if (value.sessionId !== undefined)
          throw protocolError("invalid_request", "Graph help does not take a session ID.");
        const context = this.#requireContext();
        const result = await this.#run(
          context.executable,
          [...context.args, "graph", "--help"],
          30_000,
        );
        if (result.exitCode !== 0)
          throw protocolError("report_unavailable", "Graph help is unavailable.");
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
    const context = this.#requireContext();
    const result = await this.#run(context.executable, [...context.args, ...args], 30_000);
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
              if (response.statusCode !== 200) {
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
