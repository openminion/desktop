import type { RuntimeTask, TaskAction } from "../shared/tasks.js";

export function renderTasks(
  root: Document,
  container: HTMLElement,
  tasks: RuntimeTask[],
  busy: boolean,
  onAction: (action: TaskAction, taskId?: string) => void,
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
  const refresh = root.createElement("button");
  refresh.type = "button";
  refresh.className = "command-option";
  refresh.textContent = "Refresh work list";
  refresh.addEventListener("click", () => onAction("list"));
  container.append(refresh);
}
