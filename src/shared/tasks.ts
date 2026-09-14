export type TaskAction = "list" | "show" | "pause" | "resume" | "cancel" | "schedule";

export type TaskControlInput = {
  sessionId: string;
  action: TaskAction;
  taskId?: string;
  schedule?: ScheduleInput;
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

export type ScheduleInput = {
  name: string;
  instruction: string;
  kind: "at" | "every" | "cron";
  value: string;
  timezone: string;
};
