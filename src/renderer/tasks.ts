import type {
  DelegationAction,
  DelegationControlInput,
  DelegationControlValue,
  ScheduleInput,
  TaskControlInput,
  TaskControlValue,
  TaskRun,
  TaskUpdateInput,
} from "../shared/tasks.js";

export function schedulerReadinessText(
  scheduler: NonNullable<TaskControlValue["scheduler"]>,
): string {
  if (scheduler.paused) {
    return "Scheduled work is paused. Saved schedules will not dispatch until resumed.";
  }
  return scheduler.state === "ready"
    ? "Scheduled work is ready to run."
    : "Saved schedules remain manageable, but execution readiness is degraded.";
}

export function localDateTimeToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (!match) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const expected = match.slice(1, 7).map((part) => Number(part ?? 0));
  const actual = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return actual.every((part, index) => part === expected[index]) ? date.toISOString() : null;
}

export function renderDelegation(
  root: Document,
  container: HTMLElement,
  value: DelegationControlValue | null,
  busy: boolean,
  onAction: (input: Omit<DelegationControlInput, "sessionId">) => Promise<string | undefined>,
  onOpenSession: (sessionId: string) => Promise<string | undefined>,
): void {
  if (value) {
    const summary = root.createElement("section");
    summary.className = "runtime-task";
    const heading = root.createElement("h3");
    heading.textContent = value.taskId ? `Delegation ${value.taskId}` : "Delegation result";
    const facts = root.createElement("p");
    facts.textContent = [
      `Status: ${value.status}`,
      value.agentId && `Agent: ${value.agentId}`,
      value.taskId && `Task: ${value.taskId}`,
      value.a2aTraceId && `A2A trace: ${value.a2aTraceId}`,
      value.content,
    ]
      .filter(Boolean)
      .join("\n");
    summary.append(heading, facts);
    container.append(summary);
  }

  if (value?.inspection) {
    const inspection = value.inspection;
    const tree = root.createElement("section");
    tree.className = "delegation-inspection";
    const heading = root.createElement("h3");
    heading.textContent = "Delegation details";
    const treeControls = root.createElement("div");
    treeControls.className = "delegation-tree";
    treeControls.setAttribute("role", "group");
    treeControls.setAttribute("aria-label", "Delegation participants");
    const details = root.createElement("p");
    details.className = "delegation-node-details";
    details.setAttribute("role", "status");
    const parent = root.createElement("button");
    parent.type = "button";
    parent.className = "command-option";
    parent.textContent = `Parent${inspection.links.invocationId ? ` · invocation ${inspection.links.invocationId}` : " · invocation not recorded"}`;
    const child = root.createElement("button");
    child.type = "button";
    child.className = "command-option delegation-child-node";
    child.textContent = `${inspection.task.agentId ?? "Delegated agent"} · ${inspection.task.state ?? "status unknown"}`;
    const selectNode = (selected: "parent" | "child") => {
      parent.setAttribute("aria-pressed", String(selected === "parent"));
      child.setAttribute("aria-pressed", String(selected === "child"));
      details.textContent =
        selected === "parent"
          ? [
              `Invocation: ${inspection.links.invocationId ?? "Not recorded"}`,
              `Source execution: ${inspection.links.sourceExecutionId ?? "Not recorded"}`,
              `Handoff: ${inspection.links.handoffId ?? "Not recorded"}`,
            ].join("\n")
          : [
              `Task: ${inspection.task.taskId}`,
              `Agent: ${inspection.task.agentId ?? "Not recorded"}`,
              `State: ${inspection.task.state ?? "Unknown"}`,
              `Step: ${inspection.task.currentStep ?? "Not recorded"}`,
              `Progress: ${inspection.task.progress ?? "Unknown"}`,
              `A2A trace: ${inspection.task.a2aTraceId ?? "Not recorded"}`,
            ].join("\n");
    };
    parent.addEventListener("click", () => selectNode("parent"));
    child.addEventListener("click", () => selectNode("child"));
    treeControls.append(parent, child);
    tree.append(heading, treeControls, details);
    selectNode("child");

    const links = root.createElement("div");
    links.className = "delegation-links";
    if (inspection.childSession.status === "available" && inspection.childSession.sessionId) {
      const openSession = root.createElement("button");
      openSession.type = "button";
      openSession.className = "secondary-tool";
      openSession.textContent = "Open child conversation";
      openSession.addEventListener("click", async () => {
        const error = await onOpenSession(inspection.childSession.sessionId!);
        details.textContent = error ?? details.textContent;
      });
      links.append(openSession);
    } else {
      const unavailable = root.createElement("p");
      unavailable.textContent = `Child conversation: ${inspection.childSession.status}`;
      links.append(unavailable);
    }
    const toggleTimeline = root.createElement("button");
    toggleTimeline.type = "button";
    toggleTimeline.className = "secondary-tool";
    toggleTimeline.textContent = "Show protocol timeline";
    toggleTimeline.setAttribute("aria-expanded", "false");
    const timeline = root.createElement("section");
    timeline.className = "delegation-timeline";
    timeline.hidden = true;
    const timelineHeading = root.createElement("h3");
    timelineHeading.textContent = "A2A protocol timeline";
    timeline.append(timelineHeading);
    if (inspection.timeline.length) {
      for (const event of inspection.timeline) {
        const row = root.createElement("p");
        row.textContent = [
          event.timestamp ?? "Time not recorded",
          event.type ?? "event",
          event.status ?? "status unknown",
          event.fromAgent && event.toAgent && `${event.fromAgent} → ${event.toAgent}`,
          event.errorCode && `Error: ${event.errorCode}`,
        ]
          .filter(Boolean)
          .join(" · ");
        timeline.append(row);
      }
    } else {
      const empty = root.createElement("p");
      empty.textContent = "No protocol events were recorded.";
      timeline.append(empty);
    }
    toggleTimeline.addEventListener("click", () => {
      timeline.hidden = !timeline.hidden;
      toggleTimeline.textContent = timeline.hidden
        ? "Show protocol timeline"
        : "Hide protocol timeline";
      toggleTimeline.setAttribute("aria-expanded", String(!timeline.hidden));
      if (!timeline.hidden) timelineHeading.focus();
    });
    timelineHeading.tabIndex = -1;
    links.append(toggleTimeline);
    tree.append(links, timeline);
    container.append(tree);
  }

  if (value?.tasks.length && value.action === "list") {
    for (const task of value.tasks) {
      const card = root.createElement("section");
      card.className = "runtime-task";
      const heading = root.createElement("h3");
      heading.textContent = task.agentId ?? task.taskId;
      const facts = root.createElement("p");
      facts.textContent = [
        `Task: ${task.taskId}`,
        `State: ${task.state ?? "Unknown"}`,
        task.a2aTraceId && `A2A trace: ${task.a2aTraceId}`,
      ]
        .filter(Boolean)
        .join("\n");
      const inspect = root.createElement("button");
      inspect.type = "button";
      inspect.className = "secondary-tool";
      inspect.textContent = "Inspect";
      inspect.addEventListener(
        "click",
        () => void onAction({ action: "inspect", taskId: task.taskId }),
      );
      card.append(heading, facts, inspect);
      container.append(card);
    }
  }

  container.append(delegationStartForm(root, busy, onAction));
  container.append(delegationTaskForm(root, busy, onAction));
}

function delegationStartForm(
  root: Document,
  busy: boolean,
  onAction: (input: Omit<DelegationControlInput, "sessionId">) => Promise<string | undefined>,
): HTMLFormElement {
  const form = root.createElement("form");
  form.className = "schedule-form delegation-form";
  const heading = root.createElement("h3");
  heading.textContent = "Delegate work";
  const targetLabel = root.createElement("label");
  targetLabel.textContent = "Target agent ID";
  const target = root.createElement("input");
  target.id = "delegate-target";
  target.required = true;
  target.maxLength = 512;
  target.disabled = busy;
  targetLabel.append(target);
  const instructionLabel = root.createElement("label");
  instructionLabel.textContent = "Instruction";
  const instruction = root.createElement("textarea");
  instruction.id = "delegate-instruction";
  instruction.required = true;
  instruction.maxLength = 32_000;
  instruction.disabled = busy;
  instructionLabel.append(instruction);
  const modeLabel = root.createElement("label");
  modeLabel.textContent = "Run mode";
  const mode = root.createElement("select");
  mode.id = "delegate-mode";
  mode.disabled = busy;
  for (const [id, label] of [
    ["async", "Background task"],
    ["sync", "Wait for result"],
  ]) {
    const option = root.createElement("option");
    option.value = id!;
    option.textContent = label!;
    mode.append(option);
  }
  modeLabel.append(mode);
  const timeoutLabel = root.createElement("label");
  timeoutLabel.textContent = "Timeout in seconds";
  const timeout = root.createElement("input");
  timeout.id = "delegate-timeout";
  timeout.type = "number";
  timeout.min = "1";
  timeout.max = "3600";
  timeout.value = "120";
  timeout.disabled = busy;
  timeoutLabel.append(timeout);
  const error = root.createElement("p");
  error.setAttribute("role", "alert");
  const submit = root.createElement("button");
  submit.type = "submit";
  submit.className = "secondary-tool";
  submit.textContent = "Delegate";
  submit.disabled = busy;
  form.append(heading, targetLabel, instructionLabel, modeLabel, timeoutLabel, error, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "Delegating…";
    const failure = await onAction({
      action: mode.value as "sync" | "async",
      targetAgentId: target.value,
      instruction: instruction.value,
      timeoutSeconds: Number(timeout.value),
    });
    submit.disabled = busy;
    error.textContent = failure ?? "";
  });
  return form;
}

function delegationTaskForm(
  root: Document,
  busy: boolean,
  onAction: (input: Omit<DelegationControlInput, "sessionId">) => Promise<string | undefined>,
): HTMLFormElement {
  const form = root.createElement("form");
  form.className = "schedule-form delegation-form";
  const heading = root.createElement("h3");
  heading.textContent = "Inspect or control a delegated task";
  const taskLabel = root.createElement("label");
  taskLabel.textContent = "Task ID";
  const taskId = root.createElement("input");
  taskId.id = "delegate-task-id";
  taskId.required = true;
  taskId.maxLength = 512;
  taskLabel.append(taskId);
  const actionLabel = root.createElement("label");
  actionLabel.textContent = "Action";
  const action = root.createElement("select");
  action.id = "delegate-task-action";
  for (const [id, label] of [
    ["inspect", "Inspect tree and timeline"],
    ["status", "Refresh status"],
    ["result", "Read latest result"],
    ["cancel", "Cancel task"],
  ]) {
    const option = root.createElement("option");
    option.value = id!;
    option.textContent = label!;
    action.append(option);
  }
  const syncBusyState = () => {
    const mutating = action.value === "cancel";
    taskId.disabled = busy && mutating;
    action.disabled = busy && mutating;
    submit.disabled = busy && mutating;
  };
  actionLabel.append(action);
  const error = root.createElement("p");
  error.setAttribute("role", "alert");
  const submit = root.createElement("button");
  submit.type = "submit";
  submit.className = "secondary-tool";
  submit.textContent = "Apply";
  action.addEventListener("change", syncBusyState);
  syncBusyState();
  form.append(heading, taskLabel, actionLabel, error, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "Reading delegated work…";
    const failure = await onAction({
      action: action.value as DelegationAction,
      taskId: taskId.value,
    });
    syncBusyState();
    error.textContent = failure ?? "";
  });
  return form;
}

export function renderTasks(
  root: Document,
  container: HTMLElement,
  value: TaskControlValue,
  busy: boolean,
  onAction: (input: Omit<TaskControlInput, "sessionId">) => void,
  onSchedule: (schedule: ScheduleInput) => Promise<string | undefined>,
  onOpenSession: (sessionId: string) => Promise<string | undefined> = async () =>
    "This result conversation is not available.",
): void {
  if (value.scheduler) {
    const readiness = root.createElement("section");
    readiness.className = "task-readiness";
    readiness.textContent = [
      `Global scheduler: ${value.scheduler.state}`,
      schedulerReadinessText(value.scheduler),
      value.scheduler.reason && `Reason: ${value.scheduler.reason}`,
      value.scheduler.lastHeartbeatAt && `Last heartbeat: ${value.scheduler.lastHeartbeatAt}`,
      value.scheduler.paused !== null &&
        `Dispatch: ${value.scheduler.paused ? "paused" : "running"}`,
      value.scheduler.updatedAt && `Revision: ${value.scheduler.updatedAt}`,
      value.scheduler.updatedBy && `Changed by: ${value.scheduler.updatedBy}`,
      value.scheduler.checkCommand && `Check: ${value.scheduler.checkCommand}`,
    ]
      .filter(Boolean)
      .join("\n");
    container.append(readiness);
    if (value.scheduler.updatedAt) {
      const refreshScheduler = root.createElement("button");
      refreshScheduler.type = "button";
      refreshScheduler.className = "secondary-tool";
      refreshScheduler.textContent = "Refresh scheduler status";
      refreshScheduler.addEventListener("click", () => onAction({ action: "scheduler-status" }));
      readiness.append(refreshScheduler);
    }
    if (value.scheduler.updatedAt && value.scheduler.paused !== null) {
      if (value.scheduler.paused) {
        const resume = root.createElement("button");
        resume.type = "button";
        resume.className = "secondary-tool";
        resume.textContent = "Resume scheduling for all agents";
        resume.addEventListener("click", () => {
          if (resume.dataset.confirmed !== "true") {
            resume.dataset.confirmed = "true";
            resume.textContent = "Confirm resume for all agents";
            return;
          }
          onAction({
            action: "scheduler-resume",
            expectedUpdatedAt: value.scheduler!.updatedAt!,
            confirm: true,
          });
        });
        readiness.append(resume);
      } else {
        const reasonLabel = root.createElement("label");
        reasonLabel.textContent = "Reason for pausing all scheduled task dispatch";
        const reason = root.createElement("input");
        reason.placeholder = "Reason for pausing all scheduled task dispatch";
        reason.maxLength = 500;
        const reasonError = root.createElement("p");
        reasonError.setAttribute("role", "alert");
        const pause = root.createElement("button");
        pause.type = "button";
        pause.className = "secondary-tool";
        pause.textContent = "Pause scheduling for all agents";
        pause.addEventListener("click", () => {
          if (!reason.value.trim()) {
            reasonError.textContent = "Enter a reason before pausing the scheduler.";
            return;
          }
          if (pause.dataset.confirmed !== "true") {
            pause.dataset.confirmed = "true";
            pause.textContent = "Confirm pause for all agents";
            reason.disabled = true;
            return;
          }
          reasonError.textContent = "";
          onAction({
            action: "scheduler-pause",
            reason: reason.value.trim(),
            expectedUpdatedAt: value.scheduler!.updatedAt!,
            confirm: true,
          });
        });
        reasonLabel.append(reason);
        readiness.append(reasonLabel, reasonError, pause);
      }
    }
  }

  if (value.pendingActions.length) {
    const decisions = root.createElement("section");
    decisions.className = "task-decisions";
    const heading = root.createElement("h3");
    heading.textContent = "Pending decisions";
    decisions.append(heading);
    for (const pending of value.pendingActions) {
      const details = root.createElement("p");
      details.textContent = [
        `Decision: ${pending.decisionId}`,
        pending.taskId && `Task: ${pending.taskId}`,
        pending.tool && `Tool: ${pending.tool}`,
        pending.reason && `Reason: ${pending.reason}`,
      ]
        .filter(Boolean)
        .join("\n");
      decisions.append(details);
      const guidance = root.createElement("p");
      guidance.textContent =
        "Inspect this blocker in Focus. Approval continuation remains with the active turn.";
      decisions.append(guidance);
    }
    container.append(decisions);
  }

  for (const task of value.tasks) {
    const card = root.createElement("section");
    card.className = "runtime-task";
    const title = root.createElement("h3");
    title.textContent = task.title ?? task.id;
    const details = root.createElement("p");
    details.textContent = [
      `ID: ${task.id}`,
      `Status: ${task.status ?? "Not reported"}`,
      task.kind && `Type: ${task.kind}`,
      task.schedule && `Schedule: ${task.schedule}`,
      task.dueAt && `Next: ${task.dueAt}`,
      task.operatorState && `Operator state: ${task.operatorState}`,
      task.resumeAction && `Resume: ${task.resumeAction}`,
      task.sessionTarget && `Session target: ${task.sessionTarget}`,
    ]
      .filter(Boolean)
      .join("\n");
    card.append(title, details);
    if (task.recentRuns.length) {
      const runs = root.createElement("section");
      runs.className = "task-runs";
      const heading = root.createElement("h4");
      heading.textContent = "Recent runs";
      runs.append(heading);
      for (const run of task.recentRuns) runs.append(renderRun(root, run, onOpenSession));
      card.append(runs);
    }
    for (const action of ["show", ...task.validActions] as const) {
      if (action === "update") {
        const update = root.createElement("button");
        update.type = "button";
        update.className = "secondary-tool";
        update.textContent = "Update";
        update.setAttribute("aria-label", `Update ${task.title ?? task.id}`);
        update.disabled = busy;
        const form = taskUpdateForm(root, task, busy, onAction);
        form.hidden = true;
        update.addEventListener("click", () => {
          form.hidden = !form.hidden;
          update.setAttribute("aria-expanded", String(!form.hidden));
        });
        update.setAttribute("aria-expanded", "false");
        card.append(update, form);
        continue;
      }
      const button = root.createElement("button");
      button.type = "button";
      button.className = "secondary-tool";
      button.textContent = {
        show: "Details",
        pause: "Pause",
        resume: "Resume",
        cancel: "Cancel",
        "run-now": "Run now",
        "delete-history": "Delete run history",
      }[action];
      button.setAttribute("aria-label", `${button.textContent} ${task.title ?? task.id}`);
      button.disabled = busy && action !== "show";
      if (action === "delete-history" || action === "cancel") {
        button.addEventListener("click", () => {
          if (button.dataset.confirmed !== "true") {
            button.dataset.confirmed = "true";
            button.textContent =
              action === "cancel" ? "Confirm cancel task" : "Confirm delete run history";
            button.setAttribute("aria-label", `${button.textContent} ${task.title ?? task.id}`);
            return;
          }
          onAction({ action, taskId: task.id, confirm: true });
        });
      } else {
        button.addEventListener("click", () => onAction({ action, taskId: task.id }));
      }
      card.append(button);
    }
    if (
      task.supportsExpandedRuns === true &&
      task.recentRuns.length >= (value.recentRunsLimit ?? 5) &&
      value.recentRunsLimit !== 20
    ) {
      const loadMore = root.createElement("button");
      loadMore.type = "button";
      loadMore.className = "secondary-tool";
      loadMore.textContent = "Load more runs";
      loadMore.addEventListener("click", () =>
        onAction({ action: "show", taskId: task.id, runsLimit: 20 }),
      );
      card.append(loadMore);
    }
    container.append(card);
  }
  const form = root.createElement("form");
  form.className = "schedule-form";
  const heading = root.createElement("h3");
  heading.textContent = "Schedule work";
  form.append(heading);
  const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    label: string,
    element: T,
    id: string,
  ) => {
    const wrapper = root.createElement("label");
    const caption = root.createElement("span");
    caption.textContent = label;
    element.id = id;
    element.disabled = busy;
    wrapper.append(caption, element);
    form.append(wrapper);
    return [element, wrapper, caption] as const;
  };
  const [name] = field("Name", root.createElement("input"), "schedule-name");
  name.required = true;
  name.maxLength = 120;
  const [instruction] = field(
    "What should OpenMinion do?",
    root.createElement("textarea"),
    "schedule-instruction",
  );
  instruction.required = true;
  instruction.maxLength = 32_000;
  const [kind] = field("When", root.createElement("select"), "schedule-kind");
  for (const [value, label] of [
    ["at", "Once, at a date and time"],
    ["every", "Repeat on an interval"],
    ["cron", "Advanced: cron schedule"],
  ]) {
    const option = root.createElement("option");
    option.value = value!;
    option.textContent = label!;
    kind.append(option);
  }
  const [timing, , timingCaption] = field(
    "Date and time (your local timezone)",
    root.createElement("input"),
    "schedule-value",
  );
  timing.type = "datetime-local";
  timing.step = "0.001";
  timing.required = true;
  const [timezone, timezoneLabel] = field(
    "Timezone for cron",
    root.createElement("input"),
    "schedule-timezone",
  );
  timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  timezoneLabel.hidden = true;
  kind.addEventListener("change", () => {
    timing.type =
      kind.value === "at" ? "datetime-local" : kind.value === "every" ? "number" : "text";
    timing.step = kind.value === "at" ? "0.001" : kind.value === "every" ? "any" : "";
    timing.min = kind.value === "every" ? String(10 / 60) : "";
    timing.value = "";
    timing.placeholder = kind.value === "every" ? "Minutes between runs" : "e.g. 0 9 * * 1-5";
    timezoneLabel.hidden = kind.value !== "cron";
    timingCaption.textContent =
      kind.value === "at"
        ? "Date and time (your local timezone)"
        : kind.value === "every"
          ? "Interval in minutes (decimals allowed)"
          : "Cron expression";
  });
  const note = root.createElement("p");
  note.textContent =
    "OpenMinion must be running when work is due. Creating a schedule authorizes it to run at the chosen time.";
  const error = root.createElement("p");
  error.setAttribute("role", "alert");
  const create = root.createElement("button");
  create.type = "submit";
  create.className = "secondary-tool";
  create.textContent = "Create schedule";
  create.disabled = busy;
  form.append(note, error, create);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || create.disabled) return;
    let value = timing.value;
    if (kind.value === "at") {
      const instant = localDateTimeToIso(value);
      if (!instant) {
        error.textContent = "Choose a valid date and time.";
        return;
      }
      value = instant;
    }
    create.disabled = true;
    error.textContent = "Creating schedule…";
    const failure = await onSchedule({
      name: name.value,
      instruction: instruction.value,
      kind: kind.value as ScheduleInput["kind"],
      value,
      timezone: timezone.value,
    });
    create.disabled = false;
    error.textContent = failure ?? "";
  });
  container.append(form);
  const refresh = root.createElement("button");
  refresh.type = "button";
  refresh.className = "command-option";
  refresh.textContent = "Refresh work list";
  refresh.addEventListener("click", () => onAction({ action: "list" }));
  container.append(refresh);
}

function renderRun(
  root: Document,
  run: TaskRun,
  onOpenSession: (sessionId: string) => Promise<string | undefined>,
): HTMLElement {
  const container = root.createElement("section");
  container.className = "task-run";
  const details = root.createElement("p");
  details.textContent = [
    `Run: ${run.runId}`,
    `State: ${run.state ?? "Not reported"}`,
    run.summary && `Summary: ${run.summary}`,
    run.attempts !== null && `Attempts: ${run.attempts}`,
    run.dueAt && `Due: ${run.dueAt}`,
    run.availableAt && `Available: ${run.availableAt}`,
    run.startedAt && `Started: ${run.startedAt}`,
    run.finishedAt && `Finished: ${run.finishedAt}`,
    run.isolatedSessionId && `Result session: ${run.isolatedSessionId}`,
    run.error && `Execution error: ${errorText(run.error)}`,
    run.delivery && `Delivery: ${run.delivery.state ?? "Not reported"}`,
    run.delivery?.mode && `Delivery mode: ${run.delivery.mode}`,
    run.delivery?.targets.length && `Delivery targets: ${run.delivery.targets.join(", ")}`,
    run.delivery?.error && `Delivery error: ${errorText(run.delivery.error)}`,
    run.deliveryTargets.length && `Delivery attempt claims: ${run.deliveryTargets.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  container.append(details);
  if (run.isolatedSessionId) {
    const open = root.createElement("button");
    open.type = "button";
    open.className = "secondary-tool";
    open.textContent = "Open result conversation";
    open.setAttribute("aria-label", `Open result conversation for run ${run.runId}`);
    open.addEventListener("click", async () => {
      const error = await onOpenSession(run.isolatedSessionId!);
      if (error) details.textContent = `${details.textContent}\n${error}`;
    });
    container.append(open);
  }
  return container;
}

function taskUpdateForm(
  root: Document,
  task: TaskControlValue["tasks"][number],
  busy: boolean,
  onAction: (input: Omit<TaskControlInput, "sessionId">) => void,
): HTMLFormElement {
  const form = root.createElement("form");
  form.className = "schedule-form";
  const instruction = root.createElement("textarea");
  instruction.required = true;
  instruction.maxLength = 32_000;
  instruction.value = task.instruction ?? "";
  instruction.disabled = busy;
  const instructionLabel = root.createElement("label");
  instructionLabel.textContent = "Instruction";
  instructionLabel.append(instruction);
  const kind = root.createElement("select");
  for (const [value, label] of [
    ["at", "Once, at a date and time"],
    ["every", "Repeat on an interval"],
    ["cron", "Advanced: cron schedule"],
  ]) {
    const option = root.createElement("option");
    option.value = value!;
    option.textContent = label!;
    kind.append(option);
  }
  kind.value = task.scheduleInput?.kind ?? "every";
  kind.disabled = busy;
  const kindLabel = root.createElement("label");
  kindLabel.textContent = "When";
  kindLabel.append(kind);
  const timing = root.createElement("input");
  timing.required = true;
  timing.value = task.scheduleInput?.value ?? "";
  timing.disabled = busy;
  const timingLabel = root.createElement("label");
  const timingCaption = root.createElement("span");
  timingLabel.append(timingCaption, timing);
  const timezone = root.createElement("input");
  timezone.value = task.scheduleInput?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  timezone.disabled = busy;
  const timezoneLabel = root.createElement("label");
  timezoneLabel.textContent = "Timezone for cron";
  timezoneLabel.append(timezone);
  const syncTiming = () => {
    timing.type =
      kind.value === "at" ? "datetime-local" : kind.value === "every" ? "number" : "text";
    timing.step = kind.value === "at" ? "0.001" : kind.value === "every" ? "any" : "";
    timing.min = kind.value === "every" ? String(10 / 60) : "";
    timingCaption.textContent =
      kind.value === "at"
        ? "Date and time (your local timezone)"
        : kind.value === "every"
          ? "Interval in minutes (decimals allowed)"
          : "Cron expression";
    timezoneLabel.hidden = kind.value !== "cron";
  };
  kind.addEventListener("change", () => {
    timing.value = "";
    syncTiming();
  });
  syncTiming();
  const submit = root.createElement("button");
  submit.type = "submit";
  submit.className = "secondary-tool";
  submit.textContent = "Save update";
  submit.disabled = busy || !task.scheduleRevision;
  const error = root.createElement("p");
  error.setAttribute("role", "alert");
  if (!task.scheduleRevision) error.textContent = "Refresh task details before updating.";
  form.append(instructionLabel, kindLabel, timingLabel, timezoneLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!task.scheduleRevision) return;
    let value = timing.value;
    if (kind.value === "at") {
      const instant = localDateTimeToIso(value);
      if (!instant) {
        error.textContent = "Choose a valid date and time.";
        return;
      }
      value = instant;
    }
    const update: TaskUpdateInput = {
      instruction: instruction.value,
      kind: kind.value as TaskUpdateInput["kind"],
      value,
      timezone: timezone.value,
    };
    onAction({
      action: "update",
      taskId: task.id,
      update,
      expectedUpdatedAt: task.scheduleRevision,
    });
  });
  return form;
}

function errorText(error: { code: string | null; message: string | null }): string {
  return [error.code, error.message].filter(Boolean).join(": ") || "Not reported";
}
