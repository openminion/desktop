export type TaskAction = "list" | "show" | "pause" | "resume" | "cancel" | "schedule";

export type TaskControlInput = {
  sessionId: string;
  action: TaskAction;
  taskId?: string;
  schedule?: ScheduleInput;
};

export type TaskError = {
  code: string | null;
  message: string | null;
};

export type TaskDelivery = {
  state: string | null;
  mode: string | null;
  targets: string[];
  error: TaskError | null;
};

export type TaskRun = {
  runId: string;
  state: string | null;
  summary: string | null;
  attempts: number | null;
  dueAt: string | null;
  availableAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  isolatedSessionId: string | null;
  error: TaskError | null;
  delivery: TaskDelivery | null;
  deliveryTargets: string[];
};

export type SchedulerReadiness = {
  state: string;
  hostedBy: string | null;
  reason: string | null;
  lastHeartbeatAt: string | null;
  checkCommand: string | null;
};

export type PendingTaskAction = {
  decisionId: string;
  taskId: string | null;
  reason: string | null;
  tool: string | null;
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
  sessionTarget: string | null;
  validActions: Array<"pause" | "resume" | "cancel">;
  recentRuns: TaskRun[];
};

export type TaskControlValue = {
  tasks: RuntimeTask[];
  pendingActions: PendingTaskAction[];
  scheduler: SchedulerReadiness | null;
};

export type ScheduleInput = {
  name: string;
  instruction: string;
  kind: "at" | "every" | "cron";
  value: string;
  timezone: string;
};

export type DelegationAction =
  | "sync"
  | "async"
  | "list"
  | "status"
  | "resume"
  | "result"
  | "inspect"
  | "cancel";

export type DelegationControlInput = {
  sessionId: string;
  action: DelegationAction;
  targetAgentId?: string;
  instruction?: string;
  taskId?: string;
  timeoutSeconds?: number;
  limit?: number;
};

export type DelegationTask = {
  taskId: string;
  a2aTraceId: string | null;
  agentId: string | null;
  method: string | null;
  state: string | null;
  currentStep: string | null;
  progress: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DelegationTimelineEntry = {
  timestamp: string | null;
  messageId: string | null;
  a2aTraceId: string | null;
  fromAgent: string | null;
  toAgent: string | null;
  type: string | null;
  method: string | null;
  status: string | null;
  taskId: string | null;
  errorCode: string | null;
};

export type DelegationInspection = {
  support: string;
  authority: string;
  task: DelegationTask;
  links: {
    invocationId: string | null;
    sourceExecutionId: string | null;
    handoffId: string | null;
  };
  timeline: DelegationTimelineEntry[];
  childSession: { status: string; sessionId: string | null };
  rawContentStatus: string;
};

export type DelegationControlValue = {
  action: DelegationAction;
  status: string;
  agentId: string | null;
  taskId: string | null;
  a2aTraceId: string | null;
  content: string | null;
  tasks: DelegationTask[];
  inspection: DelegationInspection | null;
};
