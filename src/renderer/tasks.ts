import type { RuntimeTask, ScheduleInput, TaskAction } from "../shared/tasks.js";

export function renderTasks(
  root: Document,
  container: HTMLElement,
  tasks: RuntimeTask[],
  busy: boolean,
  onAction: (action: TaskAction, taskId?: string) => void,
  onSchedule: (schedule: ScheduleInput) => Promise<string | undefined>,
): void {
  for (const task of tasks) {
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
    ]
      .filter(Boolean)
      .join("\n");
    card.append(title, details);
    for (const action of ["show", ...task.validActions] as const) {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "secondary-tool";
      button.textContent = { show: "Refresh", pause: "Pause", resume: "Resume", cancel: "Cancel" }[
        action
      ];
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
