import type { NativeApi, ToolProfileInput } from "../shared/contracts.js";

export function renderToolProfile(
  root: Document,
  container: HTMLElement,
  input: Pick<ToolProfileInput, "sessionId" | "action" | "profileId">,
  control: NativeApi["tools"]["control"],
): void {
  const form = root.createElement("form");
  form.className = "schedule-form tool-profile-form";
  let fields: HTMLElement = form;
  const field = (title: string, value = "", type = "text") => {
    const label = root.createElement("label");
    label.textContent = title;
    const entry = root.createElement("input");
    entry.type = type;
    entry.value = value;
    if (type === "checkbox") label.className = "tool-profile-approval";
    label.append(entry);
    fields.append(label);
    return entry;
  };
  const profile = field("Tool profile", input.profileId);
  profile.required = true;
  const options = root.createElement("details");
  const summary = root.createElement("summary");
  summary.textContent = "Scope and access options";
  options.append(summary);
  form.append(options);
  fields = options;
  const target = field("Target (optional)");
  const task = field("Task ID (optional)");
  const activating = input.action === "activate";
  const targetKind = activating ? field("Target kind (optional)") : null;
  const credentials = activating ? field("Credential scopes (comma separated names)") : null;
  const dependencies = activating ? field("Dependencies (comma separated names)") : null;
  const ttl = activating ? field("Expires after (seconds, optional)", "", "number") : null;
  if (ttl) {
    ttl.min = "0.001";
    ttl.step = "any";
  }
  const reason = activating ? field("Reason (optional)") : null;
  const approvedBy = activating ? field("Approved by (optional)") : null;
  const policySource = activating ? field("Policy source (optional)") : null;
  fields = form;
  const approved = activating
    ? field("I approve this profile for the selected conversation", "", "checkbox")
    : null;
  const submit = root.createElement("button");
  submit.type = "submit";
  submit.className = "secondary-tool";
  submit.textContent = activating ? "Activate profile" : "Deactivate profile";
  const status = root.createElement("p");
  status.setAttribute("role", "status");
  form.append(submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const names = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const request: ToolProfileInput = {
      ...input,
      profileId: profile.value.trim(),
      targetId: target.value,
      taskId: task.value,
      ...(activating
        ? {
            targetKind: targetKind!.value,
            credentialScopes: names(credentials!.value),
            dependencies: names(dependencies!.value),
            approved: approved!.checked,
            ...(ttl!.value ? { ttlSeconds: Number(ttl!.value) } : {}),
            reason: reason!.value,
            approvedBy: approvedBy!.value,
            policySource: policySource!.value,
          }
        : {}),
    };
    submit.disabled = true;
    status.textContent = "Applying tool access…";
    const result = await control(request);
    status.textContent = result.ok ? result.value.text : result.error.message;
    submit.disabled = false;
  });
  container.replaceChildren(form);
  container.scrollIntoView({ block: "nearest" });
  profile.focus({ preventScroll: true });
}
