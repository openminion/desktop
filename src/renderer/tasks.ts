import type { ScheduleInput, TaskAction, TaskControlValue, TaskRun } from "../shared/tasks.js";

export function renderTasks(
  root: Document,
  container: HTMLElement,
  value: TaskControlValue,
  busy: boolean,
  onAction: (action: TaskAction, taskId?: string) => void,
  onSchedule: (schedule: ScheduleInput) => Promise<string | undefined>,
): void {
  if (value.scheduler) {
    const readiness = root.createElement("section");
    readiness.className = "task-readiness";
    readiness.textContent = [
      `Scheduler: ${value.scheduler.state}`,
      value.scheduler.state === "ready"
        ? "Scheduled work is ready to run."
        : "Saved schedules remain manageable, but execution readiness is degraded.",
      value.scheduler.reason && `Reason: ${value.scheduler.reason}`,
      value.scheduler.lastHeartbeatAt && `Last heartbeat: ${value.scheduler.lastHeartbeatAt}`,
      value.scheduler.checkCommand && `Check: ${value.scheduler.checkCommand}`,
    ]
      .filter(Boolean)
      .join("\n");
    container.append(readiness);
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
      guidance.textContent = "Resolve this approval in Focus.";
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
      for (const run of task.recentRuns) runs.append(renderRun(root, run));
      card.append(runs);
    }
    for (const action of ["show", ...task.validActions] as const) {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "secondary-tool";
      button.textContent = {
        show: "Details",
        pause: "Pause",
        resume: "Resume",
        cancel: "Cancel",
      }[action];
      button.disabled = busy && action !== "show";
      button.addEventListener("click", () => onAction(action, task.id));
      card.append(button);
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
    ["every", "Every few minutes"],
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
    timing.value = "";
    timing.placeholder = kind.value === "every" ? "Minutes between runs" : "e.g. 0 9 * * 1-5";
    timezoneLabel.hidden = kind.value !== "cron";
    timingCaption.textContent =
      kind.value === "at"
        ? "Date and time (your local timezone)"
        : kind.value === "every"
          ? "Interval in minutes"
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
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) {
        error.textContent = "Choose a valid date and time.";
        return;
      }
      value = date.toISOString();
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
  refresh.addEventListener("click", () => onAction("list"));
  container.append(refresh);
}

function renderRun(root: Document, run: TaskRun): HTMLElement {
  const details = root.createElement("p");
  details.className = "task-run";
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
    run.deliveryTargets.length && `Delivered markers: ${run.deliveryTargets.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return details;
}

function errorText(error: { code: string | null; message: string | null }): string {
  return [error.code, error.message].filter(Boolean).join(": ") || "Not reported";
}
