export type TaskAction =
  | "list"
  | "show"
  | "pause"
  | "resume"
  | "cancel"
  | "schedule"
  | "run-now"
  | "update"
  | "delete-history"
  | "scheduler-status"
  | "scheduler-pause"
  | "scheduler-resume";

export type TaskControlInput = {
  sessionId: string;
  action: TaskAction;
  taskId?: string;
  schedule?: ScheduleInput;
  update?: TaskUpdateInput;
  reason?: string;
  expectedUpdatedAt?: string;
  runsLimit?: 20;
  confirm?: boolean;
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
  paused: boolean | null;
  updatedAt: string | null;
  updatedBy: string | null;
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
  instruction: string | null;
  scheduleRevision: string | null;
  scheduleInput: TaskScheduleInput | null;
  validActions: Array<"pause" | "resume" | "cancel" | "run-now" | "update" | "delete-history">;
  recentRuns: TaskRun[];
  supportsExpandedRuns?: boolean;
};

export type TaskControlValue = {
  tasks: RuntimeTask[];
  pendingActions: PendingTaskAction[];
  scheduler: SchedulerReadiness | null;
  recentRunsLimit?: 5 | 20;
  actionResult?:
    | {
        action: "run-now";
        taskId: string;
        runId: string;
        state: string | null;
      }
    | { action: "update"; taskId: string }
    | { action: "delete-history"; taskId: string; deletedCount: number }
    | {
        action: "scheduler-pause" | "scheduler-resume";
        paused: boolean;
        updatedAt: string;
        updatedBy: string | null;
        reason: string | null;
      }
    | null;
  refreshWarning?: string | null;
};

export type ScheduleInput = {
  name: string;
  instruction: string;
  kind: "at" | "every" | "cron";
  value: string;
  timezone: string;
};

export type TaskScheduleInput = Omit<ScheduleInput, "name" | "instruction">;

export type TaskUpdateInput = TaskScheduleInput & {
  instruction: string;
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
