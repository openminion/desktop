// Public presentation wording from OpenMinion 0.0.19 CLI status/public_messages.py
// and status/tool_calls.py. Raw labels and detail_text belong to diagnostics.
const statusMessages = new Map(
  Object.entries({
    clarifying: "Making sure I understand...",
    analyzing: "Reviewing your request...",
    planning: "Planning the next steps...",
    awaiting_plan_review: "Ready for you to review the plan.",
    awaiting_confirmation: "Waiting for your approval...",
    executing: "Working on it...",
    replanning: "Adjusting the plan...",
    reviewing: "Reviewing the results...",
    verifying: "Checking the result...",
    evaluating_completion: "Checking whether everything is complete...",
    saving_context: "Saving your progress...",
    waiting_for_user: "Waiting for your reply...",
    completed: "Done.",
    stopped: "Stopped.",
    blocked: "Unable to continue yet.",
    error: "Something went wrong.",
    working: "Working on it...",
  }),
);

const detailMessages = new Map(
  Object.entries({
    preparing_turn: "Getting ready...",
    loading_memory_context: "Loading relevant context...",
    loading_session_history: "Reviewing this conversation...",
    thinking: "Thinking...",
    composing_answer: "Preparing the answer...",
    waiting_for_checks: "Waiting for checks...",
  }),
);

const toolMessages = new Map(
  Object.entries({
    "agent.get": "Get Agent in progress...",
    "agent.list": "List Agents in progress...",
    "blockchain.debug": "Debug Blockchain in progress...",
    "blockchain.inspect": "Inspect Blockchain in progress...",
    "blockchain.prepare_transaction": "Prepare Blockchain Transaction in progress...",
    "blockchain.send_transaction": "Send Blockchain Transaction in progress...",
    browser: "Browser in progress...",
    "cloud.ssm.command_status": "Inspect Cloud Command in progress...",
    "cloud.ssm.inventory": "Inspect Cloud Inventory in progress...",
    "code.grep": "Searching files...",
    "code.patch": "Editing a file...",
    "code.repo_index": "Index Repository in progress...",
    "code.repo_map": "Map Repository in progress...",
    "code.symbol_find": "Searching files...",
    "config.ansible.check": "Check Ansible Configuration in progress...",
    "config.ansible.facts": "Inspect Ansible Facts in progress...",
    "config.salt.job_status": "Inspect Salt Job in progress...",
    "config.salt.test": "Test Salt Configuration in progress...",
    "exec.clear": "Clear Command in progress...",
    "exec.kill": "Stop Command in progress...",
    "exec.list": "List Commands in progress...",
    "exec.paste": "Paste Into Command in progress...",
    "exec.poll": "Check Command in progress...",
    "exec.run": "Running a command...",
    "exec.send_keys": "Send Keys in progress...",
    "exec.submit": "Submit Command in progress...",
    "file.edit": "Editing a file...",
    "file.find": "Find File in progress...",
    "file.list_dir": "List Directory in progress...",
    "file.read": "Reading a file...",
    "file.read_range": "Reading a file...",
    "file.search": "Searching files...",
    "file.trash": "Trash File in progress...",
    "file.write": "Writing a file...",
    "git.add": "Git Add in progress...",
    "git.blame": "Git Blame in progress...",
    "git.branch": "Git Branch in progress...",
    "git.checkout": "Git Checkout in progress...",
    "git.commit": "Git Commit in progress...",
    "git.diff": "Git Diff in progress...",
    "git.fetch": "Git Fetch in progress...",
    "git.log": "Git Log in progress...",
    "git.push": "Git Push in progress...",
    "git.reflog": "Git Reflog in progress...",
    "git.reset": "Git Reset in progress...",
    "git.show": "Git Show in progress...",
    "git.stash": "Git Stash in progress...",
    "git.status": "Git Status in progress...",
    "git.tag": "Git Tag in progress...",
    "github.commit_files": "Commit GitHub Files in progress...",
    "github.create_release": "Create GitHub Release in progress...",
    "github.dispatch_workflow": "Dispatch GitHub Workflow in progress...",
    "github.fetch_checks": "Fetch GitHub Checks in progress...",
    "github.fetch_comments": "Fetch GitHub Comments in progress...",
    "github.fetch_diff": "Fetch GitHub Diff in progress...",
    "github.fetch_pr": "Fetch GitHub PR in progress...",
    "github.list_prs": "List GitHub PRs in progress...",
    "github.list_workflow_runs": "List GitHub Workflow Runs in progress...",
    "github.merge_pr": "Merge GitHub PR in progress...",
    "github.open_pr": "Open GitHub PR in progress...",
    "github.post_pr_comment": "Post GitHub PR Comment in progress...",
    "github.post_pr_review": "Post GitHub PR Review in progress...",
    "github.update_pr": "Update GitHub PR in progress...",
    "gitops.app.diff": "Diff GitOps Application in progress...",
    "gitops.app.status": "Inspect GitOps Application in progress...",
    "gitops.drift.inspect": "Inspect GitOps Drift in progress...",
    "gitops.source.revision": "Inspect GitOps Revision in progress...",
    "graph.neighborhood": "Inspect Graph Neighborhood in progress...",
    "graph.query": "Query Graph in progress...",
    "graph.refresh": "Refresh Graph in progress...",
    "gws.auth.export": "Google Workspace Export in progress...",
    "gws.auth.login": "Google Workspace Login in progress...",
    "gws.auth.setup": "Google Workspace Setup in progress...",
    "gws.call": "Google Workspace in progress...",
    "gws.schema": "Google Workspace Schema in progress...",
    "host.inventory_report": "Create Host Inventory in progress...",
    "host.metrics": "Host Metrics in progress...",
    "iac.plan.create": "Create Infrastructure Plan in progress...",
    "iac.plan.show": "Show Infrastructure Plan in progress...",
    "iac.provider.facts": "Inspect Infrastructure Provider in progress...",
    "iac.validate": "Validate Infrastructure in progress...",
    "ip.local": "Local IP in progress...",
    "ip.public": "Public IP in progress...",
    "k8s.events.list": "List Kubernetes Events in progress...",
    "k8s.logs.get": "Get Kubernetes Logs in progress...",
    "k8s.rollout.status": "Inspect Kubernetes Rollout in progress...",
    "k8s.workload.get": "Inspect Kubernetes Workload in progress...",
    "k8s.workload.list": "List Kubernetes Workloads in progress...",
    location: "Location in progress...",
    "memory.forget": "Forget Memory in progress...",
    "memory.search": "Searching memory...",
    "memory.write": "Write Memory in progress...",
    "observability.otel.trace": "Look Up Trace in progress...",
    "observability.prometheus.alerts": "List Prometheus Alerts in progress...",
    "observability.prometheus.query": "Query Prometheus in progress...",
    "observability.prometheus.rules": "List Prometheus Rules in progress...",
    "ops.command.observe": "Observe Command in progress...",
    "ops.command.plan": "Plan Operations Command in progress...",
    "ops.command.run": "Running a command...",
    "ops.file.read": "Reading a file...",
    "ops.host.snapshot": "Inspect Host in progress...",
    "ops.job.cancel": "Cancel Operations Job in progress...",
    "ops.job.inspect": "Inspect Operations Job in progress...",
    "ops.logs.query": "Query Logs in progress...",
    "ops.network.inspect": "Inspect Network in progress...",
    "ops.network.port_owner": "Inspect Port Owner in progress...",
    "ops.process.inspect": "Inspect Process in progress...",
    "ops.service.inspect": "Inspect Service in progress...",
    "ops.target.inspect": "Inspect Operations Target in progress...",
    "ops.target.list": "List Operations Targets in progress...",
    "plan.add": "Add Plan Step in progress...",
    "plan.clear": "Clear Plan in progress...",
    "plan.complete": "Complete Plan Step in progress...",
    "plan.list": "List Plan in progress...",
    "plan.set": "Set Plan in progress...",
    "plan.update": "Update Plan Step in progress...",
    "security.publish_report": "Publish Security Report in progress...",
    "security.scan_artifact": "Scan Infrastructure Artifact in progress...",
    "security.scan_code": "Scan Source Code in progress...",
    "security.scan_dependencies": "Scan Dependencies in progress...",
    "security.scan_secrets": "Scan For Secrets in progress...",
    "skill.get": "Get Skill in progress...",
    "skill.ingest": "Ingest Skill in progress...",
    "skill.ingest_url": "Ingest Skill From URL in progress...",
    "skill.inspect": "Inspect Skill in progress...",
    "skill.list": "List Skills in progress...",
    "skill.remove": "Remove Skill in progress...",
    "task.cancel": "Cancel Task in progress...",
    "task.consolidate_memory": "Consolidate Memory in progress...",
    "task.delegate": "Delegate Task in progress...",
    "task.list": "List Tasks in progress...",
    "task.pause": "Pause Task in progress...",
    "task.resume": "Resume Task in progress...",
    "task.schedule": "Schedule Task in progress...",
    "task.show": "Show Task in progress...",
    "task.watch": "Watch Task in progress...",
    time: "Time in progress...",
    "todo.write": "Write Todos in progress...",
    "tool.author": "Author Tool in progress...",
    "tool.get": "Get Tool in progress...",
    "tool.inspect": "Inspect Tool in progress...",
    "tool.list": "List Tools in progress...",
    "tool.register": "Register Tool in progress...",
    weather: "Weather in progress...",
    "web.fetch": "Reading a source...",
    "web.search": "Searching the web...",
  }),
);

const primaryOnly = new Set([
  "awaiting_plan_review",
  "awaiting_confirmation",
  "waiting_for_user",
  "completed",
  "stopped",
  "blocked",
  "error",
]);

export function publicStatusText(status: Record<string, unknown>): string | null {
  if (
    ["hidden", "internal", "private"].includes(
      String(status.visibility ?? "")
        .trim()
        .toLowerCase(),
    )
  )
    return null;
  const key = String(status.status_key ?? "working");
  const primary = statusMessages.get(key) ?? "Working on it...";
  if (primaryOnly.has(key)) return primary;
  const index = status.step_index;
  const total = status.step_total;
  const validStep =
    typeof index === "number" && typeof total === "number" && index >= 1 && index <= total;
  if (status.detail_code === "plan_checkpoint" && validStep)
    return `Finished step ${index} of ${total}.`;
  const detail = detailMessages.get(String(status.detail_code ?? ""));
  if (detail) return detail;
  if (typeof status.tool_name === "string" && status.tool_name.trim()) {
    const name = status.tool_name.trim().toLowerCase();
    const tool = toolMessages.has(name)
      ? name
      : name.replace(/^(?:tools?|functions?)\./, "").trim();
    return toolMessages.get(tool) ?? "Using a tool...";
  }
  if (key === "executing" && validStep) return `Working on step ${index} of ${total}...`;
  return primary;
}
