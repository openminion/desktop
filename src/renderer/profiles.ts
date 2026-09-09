// Profile form and write-only credential entry for the local OpenMinion config.
import type { DaemonStatus, NativeApi } from "../shared/contracts.js";
import {
  TOOL_CREDENTIALS,
  type ProfileSaveInput,
  type ProfileSettings,
} from "../shared/profiles.js";

export function mountProfiles(
  api: NativeApi,
  root: Document,
  applied: (status: DaemonStatus) => void,
): void {
  const dialog = root.getElementById("profile-dialog") as HTMLDialogElement | null;
  if (!dialog || !api.profiles) return;
  const get = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const open = get<HTMLButtonElement>("show-settings");
  const close = get<HTMLButtonElement>("close-settings");
  const form = get<HTMLFormElement>("profile-form");
  const fields = get<HTMLFieldSetElement>("profile-fields");
  const select = get<HTMLSelectElement>("profile-agent");
  const model = get<HTMLInputElement>("profile-model");
  const endpoint = get<HTMLInputElement>("profile-endpoint");
  const key = get<HTMLInputElement>("profile-key");
  const removeKey = get<HTMLInputElement>("profile-key-remove");
  const makeDefault = get<HTMLInputElement>("profile-default");
  const status = get<HTMLElement>("profile-status");
  const save = get<HTMLButtonElement>("profile-save");
  const importButton = get<HTMLButtonElement>("profile-import");
  const tools = get<HTMLElement>("profile-tools");
  const credentials = TOOL_CREDENTIALS.map(([id, label]) => {
    const row = root.createElement("div");
    row.className = "credential-row";
    const title = root.createElement("label");
    title.htmlFor = `credential-${id}`;
    title.textContent = label;
    const input = root.createElement("input");
    input.id = title.htmlFor;
    input.type = "password";
    input.autocomplete = "new-password";
    input.spellcheck = false;
    input.maxLength = 16_384;
    const removeLabel = root.createElement("label");
    removeLabel.className = "settings-checkbox";
    const remove = root.createElement("input");
    remove.type = "checkbox";
    removeLabel.append(remove, root.createTextNode(`Remove saved ${label} key`));
    remove.addEventListener("change", () => {
      input.disabled = remove.checked;
      input.value = "";
    });
    row.append(title, input, removeLabel);
    tools.append(row);
    return { id, input, remove };
  });
  let settings: ProfileSettings | null = null;
  let pending = false;

  const populateAgent = () => {
    const agent = settings?.agents.find((item) => item.id === select.value);
    if (!agent || !settings) return;
    model.value = agent.model;
    endpoint.value = agent.baseUrl;
    key.value = "";
    key.placeholder = agent.keyConfigured ? "Set — leave blank to keep" : "Not set — enter API key";
    removeKey.checked = false;
    model.disabled =
      endpoint.disabled =
      key.disabled =
      removeKey.disabled =
        agent.provider === "echo";
    makeDefault.checked = settings.defaultAgent === agent.id;
    makeDefault.disabled = makeDefault.checked;
    get<HTMLElement>("profile-provider").textContent =
      agent.provider === "echo"
        ? "Echo demo. Import a model profile to use a real provider."
        : `Provider: ${agent.provider}`;
  };
  const populate = (value: ProfileSettings) => {
    const selected = select.value;
    settings = value;
    select.replaceChildren();
    for (const agent of value.agents) {
      const option = root.createElement("option");
      option.value = agent.id;
      option.textContent = `${agent.name} (${agent.id})${agent.id === value.defaultAgent ? " · default" : ""}`;
      select.append(option);
    }
    select.value = value.agents.some((agent) => agent.id === selected)
      ? selected
      : value.defaultAgent;
    populateAgent();
    for (const field of credentials) {
      field.input.value = "";
      field.input.disabled = false;
      field.remove.checked = false;
      field.input.placeholder = value.credentials.find((item) => item.name === field.id)?.configured
        ? "Set — leave blank to keep"
        : "Not set — enter API key";
    }
  };
  const setPending = (value: boolean) => {
    pending = value;
    fields.disabled = value || settings === null;
    save.disabled = value || settings === null;
    importButton.disabled = value || settings === null;
    close.disabled = value;
  };
  const finish = (value: { settings: ProfileSettings; daemon: DaemonStatus }) => {
    populate(value.settings);
    applied(value.daemon);
    status.textContent = value.daemon.reachable
      ? "Saved and applied. New tasks use the default agent; existing tasks keep their agent."
      : "Saved, but OpenMinion could not reconnect. Check the connection details.";
  };

  open.addEventListener("click", async () => {
    dialog.showModal();
    settings = null;
    setPending(true);
    status.textContent = "Loading profiles…";
    try {
      const result = await api.profiles.read();
      if (result.ok) {
        populate(result.value);
        status.textContent = "";
      } else status.textContent = result.error.message;
    } catch {
      status.textContent = "Could not load settings. Close and try again.";
    } finally {
      setPending(false);
    }
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    key.value = "";
    for (const field of credentials) field.input.value = "";
    open.focus();
  });
  select.addEventListener("change", populateAgent);
  removeKey.addEventListener("change", () => {
    key.disabled = removeKey.checked;
    key.value = "";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!settings || pending) return;
    const input: ProfileSaveInput = {
      revision: settings.revision,
      agentId: select.value,
      model: model.value.trim(),
      baseUrl: endpoint.value.trim(),
      makeDefault: makeDefault.checked,
      credentials: {},
    };
    if (removeKey.checked) input.apiKey = null;
    else if (key.value.trim()) input.apiKey = key.value.trim();
    for (const field of credentials) {
      if (field.remove.checked) input.credentials[field.id] = null;
      else if (field.input.value.trim()) input.credentials[field.id] = field.input.value.trim();
    }
    setPending(true);
    status.textContent = "Saving settings and restarting OpenMinion…";
    try {
      const result = await api.profiles.save(input);
      if (result.ok) finish(result.value);
      else status.textContent = result.error.message;
    } catch {
      status.textContent =
        "Could not apply settings. Close and reopen Settings to check what was saved.";
    } finally {
      setPending(false);
    }
  });
  importButton.addEventListener("click", async () => {
    if (!settings || pending) return;
    setPending(true);
    status.textContent = "Choose an OpenMinion profile JSON file…";
    try {
      const result = await api.profiles.import({ revision: settings.revision });
      if (!result.ok) status.textContent = result.error.message;
      else if (result.value) finish(result.value);
      else status.textContent = "Import cancelled. Settings are unchanged.";
    } catch {
      status.textContent = "Could not import profiles. Check the file and try again.";
    } finally {
      setPending(false);
    }
  });
}
