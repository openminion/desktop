export type TaskAction = "list" | "show" | "pause" | "resume" | "cancel";

export type TaskControlInput = {
  sessionId: string;
  action: TaskAction;
  taskId?: string;
};

export type RuntimeTask = {
  id: string;
  title: string | null;
  status: string | null;
  kind: string | null;
  schedule: string | null;
  dueAt: string | null;
  operatorState: string | null;
  resumeAction: string | null;
  validActions: Array<"pause" | "resume" | "cancel">;
};

export type TaskControlValue = {
  tasks: RuntimeTask[];
  pendingActions: number;
};
