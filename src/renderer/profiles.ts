// Profile form and write-only credential entry for the local OpenMinion config.
import type { DaemonStatus, NativeApi } from "../shared/contracts.js";
import type { IdentityProfileView, IdentitySettings } from "../shared/identity.js";
import {
  type ProfileSaveInput,
  type ProfileSettings,
  type ProviderCheckStatus,
  type SetupPreset,
  TOOL_CREDENTIALS,
} from "../shared/profiles.js";

export function setupResultMessage(providerCheck: ProviderCheckStatus, reachable: boolean): string {
  const confirmation =
    providerCheck === "verified" ? "Connection verified." : "Connection not tested.";
  return reachable
    ? `${confirmation} New conversations use the default agent; existing conversations keep their agent.`
    : `${confirmation} Settings were saved, but OpenMinion could not reconnect. Check the connection details.`;
}

export function mountProfiles(
  api: NativeApi,
  root: Document,
  applied: (status: DaemonStatus) => void,
): { checkSetup(): Promise<void> } | null {
  const dialog = root.getElementById("profile-dialog") as HTMLDialogElement | null;
  if (!dialog || !api.profiles) return null;
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
  const setupFields = get<HTMLFieldSetElement>("setup-fields");
  const setupProvider = get<HTMLSelectElement>("setup-provider");
  const setupModel = get<HTMLInputElement>("setup-model");
  const setupEndpoint = get<HTMLInputElement>("setup-endpoint");
  const setupKey = get<HTMLInputElement>("setup-key");
  const setupCheck = get<HTMLInputElement>("setup-check-provider");
  const demo = get<HTMLButtonElement>("setup-demo");
  const identityAgent = get<HTMLSelectElement>("identity-agent");
  const identityYaml = get<HTMLTextAreaElement>("identity-yaml");
  const identityMetadata = get<HTMLElement>("identity-metadata");
  const identityStatus = get<HTMLElement>("identity-status");
  const identityPreview = get<HTMLElement>("identity-preview");
  const identityReload = get<HTMLButtonElement>("identity-reload");
  const identityRuntime = get<HTMLButtonElement>("identity-runtime");
  const identityVerify = get<HTMLButtonElement>("identity-verify");
  const identitySave = get<HTMLButtonElement>("identity-save");
  let returnFocus: HTMLElement = open;
  const sections = ["profiles", "identity", "chat", "runtime"] as const;
  type Section = (typeof sections)[number];
  const selectSection = (selected: Section) => {
    for (const section of sections) {
      get<HTMLElement>(`settings-${section}`).hidden = section !== selected;
      get<HTMLButtonElement>(`settings-${section}-button`).setAttribute(
        "aria-pressed",
        String(section === selected),
      );
    }
    root.querySelector(".settings-body")!.scrollTop = 0;
  };
  for (const section of sections) {
    get<HTMLButtonElement>(`settings-${section}-button`).addEventListener("click", () => {
      selectSection(section);
      if (section === "identity") void loadIdentity();
    });
  }
  let presets: SetupPreset[] = [];
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
  let identitySettings: IdentitySettings | null = null;
  let identityPending = false;
  let displayedIdentityAgent = "";
  const identityDrafts = new Map<
    string,
    { yaml: string; profileVersion: string; sourceSha256: string | null }
  >();

  const setIdentityPending = (value: boolean) => {
    identityPending = value;
    const profile = selectedIdentity();
    identityAgent.disabled = value;
    identityYaml.disabled = value || !profile?.editable;
    identityReload.disabled = value;
    identityVerify.disabled = value || !identityYaml.value.trim();
    identitySave.disabled = value || !profile?.editable;
  };

  const selectedIdentity = (): IdentityProfileView | undefined =>
    identitySettings?.profiles.find((item) => item.agentId === identityAgent.value);
  const populateIdentity = () => {
    const profile = selectedIdentity();
    get<HTMLElement>("identity-editor").hidden = !profile;
    identityReload.textContent = profile ? "Reload from disk" : "Try again";
    if (profile) identityYaml.after(identityStatus);
    else get<HTMLElement>("identity-availability-actions").before(identityStatus);
    if (!profile) {
      identityYaml.value = "";
      identityYaml.disabled = true;
      identityVerify.disabled = true;
      identitySave.disabled = true;
      identityMetadata.textContent = "No identity profile is available.";
      identityPreview.textContent = "No identity loaded.";
      return;
    }
    displayedIdentityAgent = profile.agentId;
    const draft = identityDrafts.get(profile.agentId);
    const currentDraft =
      draft?.profileVersion === profile.profileVersion &&
      draft.sourceSha256 === profile.sourceSha256
        ? draft
        : undefined;
    if (draft && !currentDraft) {
      identityDrafts.delete(profile.agentId);
      identityStatus.textContent = "Identity changed on disk. The stale local draft was discarded.";
    }
    identityYaml.value = currentDraft?.yaml ?? profile.authoredYaml ?? "";
    identityYaml.disabled = !profile.editable || identityPending;
    identityVerify.disabled = !profile.authoredYaml || identityPending;
    identitySave.disabled = !profile.editable || identityPending;
    identityMetadata.textContent = [
      `Source: ${profile.source}`,
      `revision ${profile.profileRevision}`,
      `version ${profile.profileVersion.slice(0, 12)}`,
      `source ${profile.sourceStatus}`,
      `sidecars ${profile.generatedStatus}`,
      profile.generatedFiles.length
        ? `generated ${profile.generatedFiles.join(", ")}`
        : "no generated files",
      profile.readOnlyReason ?? "editable direct YAML",
      profile.verificationIssues.length
        ? `issues ${profile.verificationIssues.join("; ")}`
        : "verification clean",
    ].join(" · ");
    identityPreview.textContent = profile.render.text || "Rendered identity is empty.";
  };
  const loadIdentity = async (discardSelectedDraft = false) => {
    if (identityPending) return;
    if (discardSelectedDraft && identityAgent.value) identityDrafts.delete(identityAgent.value);
    setIdentityPending(true);
    identityRuntime.hidden = true;
    identityStatus.textContent = "Loading identity…";
    try {
      const result = await api.identity.read();
      if (!result.ok) {
        identitySettings = null;
        identityStatus.textContent = result.error.message;
        identityRuntime.hidden = result.error.code !== "runtime_upgrade_required";
        return;
      }
      const selected = identityAgent.value;
      identitySettings = result.value;
      identityAgent.replaceChildren(
        ...result.value.profiles.map((profile) => {
          const option = root.createElement("option");
          option.value = profile.agentId;
          option.textContent = `${profile.displayName} (${profile.agentId})`;
          return option;
        }),
      );
      if (result.value.profiles.some((profile) => profile.agentId === selected))
        identityAgent.value = selected;
      identityStatus.textContent = result.value.profiles.length
        ? ""
        : "No identity profiles were found for the configured agents.";
    } catch {
      identitySettings = null;
      identityStatus.textContent = "Could not load identity settings.";
    } finally {
      setIdentityPending(false);
      populateIdentity();
    }
  };

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
    setupFields.hidden = !value.setupRequired;
    get<HTMLElement>("settings-eyebrow").textContent = value.setupRequired ? "Setup" : "OpenMinion";
    get<HTMLElement>("profile-import-note").hidden = value.setupRequired;
    get<HTMLElement>("profile-intro").textContent = value.setupRequired
      ? "Connect your model to start chatting, or import an existing OpenMinion profile."
      : "Finish running chats before saving. Applying changes restarts OpenMinion.";
    fields.hidden = value.setupRequired;
    demo.hidden = !value.setupRequired || !value.agents.some((agent) => agent.provider === "echo");
    get<HTMLElement>("settings-title").textContent = value.setupRequired
      ? "Welcome to OpenMinion"
      : "Settings";
    save.textContent = value.setupRequired ? "Set up and start" : "Save and apply";
    setupKey.value = "";
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
    fields.disabled = value || settings === null || settings.setupRequired;
    setupFields.disabled = value || !settings?.setupRequired || !presets.length;
    save.disabled = value || settings === null || (settings.setupRequired && !presets.length);
    importButton.disabled = value || settings === null;
    close.disabled = value;
    demo.disabled = value;
  };
  const finish = (value: { settings: ProfileSettings; daemon: DaemonStatus }, message?: string) => {
    populate(value.settings);
    applied(value.daemon);
    status.textContent =
      message ??
      (value.daemon.reachable
        ? "Saved and applied. New conversations use the default agent; existing conversations keep their agent."
        : "Saved, but OpenMinion could not reconnect. Check the connection details.");
  };

  const populatePreset = () => {
    const preset = presets.find((item) => item.id === setupProvider.value);
    if (!preset) return;
    setupModel.value = preset.model;
    setupEndpoint.value = preset.baseUrl;
    setupKey.value = "";
    setupKey.disabled = !preset.requiresKey;
    setupKey.required = preset.requiresKey;
    setupKey.placeholder = preset.requiresKey ? "Enter API key" : "No API key required";
  };
  setupProvider.addEventListener("change", populatePreset);
  demo.addEventListener("click", () => dialog.close());
  const show = async (known?: ProfileSettings, section: Section = "profiles") => {
    returnFocus = root.activeElement as HTMLElement;
    selectSection(section);
    dialog.showModal();
    settings = null;
    setPending(true);
    status.textContent = "Loading profiles…";
    try {
      const result = known ? { ok: true as const, value: known } : await api.profiles.read();
      if (result.ok) {
        populate(result.value);
        status.textContent = "";
        if (result.value.setupRequired) {
          const listed = await api.profiles.presets();
          if (listed.ok) {
            presets = listed.value;
            setupProvider.replaceChildren(
              ...presets.map((preset) => {
                const option = root.createElement("option");
                option.value = preset.id;
                option.textContent = preset.label;
                return option;
              }),
            );
            populatePreset();
          } else status.textContent = listed.error.message;
        }
      } else status.textContent = result.error.message;
    } catch {
      status.textContent = "Could not load settings. Close and try again.";
    } finally {
      setPending(false);
    }
  };
  open.addEventListener("click", () => void show());
  get<HTMLButtonElement>("show-runtime-settings").addEventListener(
    "click",
    () => void show(undefined, "runtime"),
  );
  root.addEventListener("keydown", (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "," &&
      !root.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      void show();
    }
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    key.value = "";
    setupKey.value = "";
    for (const field of credentials) field.input.value = "";
    returnFocus.focus();
  });
  select.addEventListener("change", populateAgent);
  identityAgent.addEventListener("change", populateIdentity);
  identityYaml.addEventListener("input", () => {
    const profile = identitySettings?.profiles.find(
      (item) => item.agentId === displayedIdentityAgent,
    );
    if (profile) {
      identityDrafts.set(displayedIdentityAgent, {
        yaml: identityYaml.value,
        profileVersion: profile.profileVersion,
        sourceSha256: profile.sourceSha256,
      });
    }
    setIdentityPending(identityPending);
  });
  identityReload.addEventListener("click", () => void loadIdentity(true));
  identityRuntime.addEventListener("click", () => {
    selectSection("runtime");
    get<HTMLButtonElement>("settings-runtime-button").focus();
  });
  identityVerify.addEventListener("click", async () => {
    if (identityPending || !identityYaml.value.trim()) return;
    setIdentityPending(true);
    identityStatus.textContent = "Verifying draft…";
    try {
      const result = await api.identity.verify({ yaml: identityYaml.value });
      if (!result.ok) identityStatus.textContent = result.error.message;
      else {
        identityStatus.textContent = result.value.validationOk
          ? result.value.issues.length
            ? `Draft is valid with warnings: ${result.value.issues.join("; ")}`
            : "Draft is valid and renderable."
          : result.value.issues.join("; ");
        identityPreview.textContent = result.value.render?.text ?? "No rendered preview.";
      }
    } catch {
      identityStatus.textContent = "Could not verify the identity draft.";
    } finally {
      setIdentityPending(false);
    }
  });
  identitySave.addEventListener("click", async () => {
    const profile = selectedIdentity();
    if (!profile || identityPending || !profile.editable) return;
    setIdentityPending(true);
    identityStatus.textContent = "Saving identity…";
    try {
      const result = await api.identity.save({
        yaml: identityYaml.value,
        expectedProfileVersion: profile.profileVersion,
        expectedSourceSha256: profile.sourceSha256 ?? "missing",
      });
      if (!result.ok) identityStatus.textContent = result.error.message;
      else {
        identityDrafts.delete(result.value.agentId);
        identitySettings = {
          profiles: (identitySettings?.profiles ?? []).map((item) =>
            item.agentId === result.value.agentId ? result.value : item,
          ),
        };
        identityStatus.textContent =
          "Identity saved. Prompt changes apply on the next turn; /identity reload restarts OpenMinion to refresh cached policy and tool constraints.";
      }
    } catch {
      identityStatus.textContent = "Could not save identity. Reload Settings and try again.";
    } finally {
      setIdentityPending(false);
      if (identityStatus.textContent?.startsWith("Identity saved")) populateIdentity();
    }
  });
  removeKey.addEventListener("change", () => {
    key.disabled = removeKey.checked;
    key.value = "";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!settings || pending) return;
    if (settings.setupRequired) {
      setPending(true);
      const checkProvider = setupCheck.checked;
      status.textContent = checkProvider
        ? "Testing the connection with OpenMinion…"
        : "Setting up your agent with OpenMinion…";
      try {
        const result = await api.profiles.setup({
          revision: settings.revision,
          presetId: setupProvider.value,
          model: setupModel.value.trim(),
          baseUrl: setupEndpoint.value.trim(),
          apiKey: setupKey.value.trim(),
          checkProvider,
        });
        if (result.ok)
          finish(
            result.value,
            setupResultMessage(result.value.providerCheck, result.value.daemon.reachable),
          );
        else status.textContent = result.error.message;
      } catch {
        status.textContent = "Setup could not finish. Reopen Settings to check what was saved.";
      } finally {
        setPending(false);
      }
      return;
    }
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
  return {
    async checkSetup() {
      const result = await api.profiles.read();
      if (!result.ok || dialog.open) return;
      if (result.value.setupRequired) await show(result.value);
      else {
        const agent = result.value.agents.find((item) => item.id === result.value.defaultAgent);
        if (agent && !agent.keyConfigured) {
          const catalog = await api.profiles.presets();
          if (catalog.ok && catalog.value.find((item) => item.id === agent.provider)?.requiresKey) {
            await show(result.value);
            status.textContent = "Add the API key for your default agent before sending a message.";
          }
        }
      }
    },
  };
}
