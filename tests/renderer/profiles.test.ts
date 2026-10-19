import { describe, expect, it, vi } from "vitest";
import { identitySourceLabel, identityStatusLabel } from "../../src/renderer/identity.js";
import { mountProfiles } from "../../src/renderer/profiles.js";
import type { NativeApi } from "../../src/shared/contracts.js";
import type { IdentityProfileView } from "../../src/shared/identity.js";
import type { ProfileSettings } from "../../src/shared/profiles.js";

function profilePage(
  defaultAgent = "first",
  readProfiles?: (settings: ProfileSettings) => Promise<{ ok: true; value: ProfileSettings }>,
) {
  const nodes: Element[] = [];
  class Element {
    id = "";
    tagName = "DIV";
    value = "";
    checked = false;
    disabled = false;
    hidden = false;
    open = false;
    textContent = "";
    children: Element[] = [];
    attributes = new Map<string, string>();
    focus = vi.fn();
    listeners = new Map<string, (event: unknown) => unknown>();
    addEventListener(name: string, listener: (event: unknown) => unknown) {
      this.listeners.set(name, listener);
    }
    dispatch(name: string) {
      return this.listeners.get(name)?.({ preventDefault: vi.fn() });
    }
    append(...children: Element[]) {
      this.children.push(...children);
      if (this.tagName === "SELECT" && !this.value && children[0]) this.value = children[0].value;
    }
    replaceChildren(...children: Element[]) {
      this.children = children;
      this.textContent = children.map((child) => child.textContent).join(" ");
      if (this.tagName === "SELECT") this.value = children[0]?.value ?? "";
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    after() {}
    before() {}
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.dispatch("close");
    }
  }
  const create = (tagName = "div") => {
    const node = new Element();
    node.tagName = tagName.toUpperCase();
    nodes.push(node);
    return node;
  };
  const get = (id: string) => {
    const existing = nodes.find((node) => node.id === id);
    if (existing) return existing;
    const node = create();
    node.id = id;
    if (["profile-agent", "identity-agent", "setup-provider"].includes(id)) {
      node.tagName = "SELECT";
    }
    return node;
  };
  const confirm = vi.fn(() => false);
  const root = {
    getElementById: get,
    createElement: create,
    createTextNode: (value: string) => {
      const node = create();
      node.textContent = value;
      return node;
    },
    querySelector: () => get("settings-body"),
    addEventListener: vi.fn(),
    activeElement: get("show-settings"),
    defaultView: { confirm },
  } as unknown as Document;
  const settings: ProfileSettings = {
    setupRequired: false,
    revision: "revision",
    defaultAgent,
    agents: ["first", "second"].map((id) => ({
      id,
      name: id,
      provider: "openai",
      model: `${id}-model`,
      baseUrl: "https://example.com/v1",
      keyConfigured: true,
    })),
    credentials: [],
  };
  const save = vi.fn(async () => ({ ok: false, error: { message: "Save rejected" } }));
  const setup = vi.fn(async (_input: unknown) => ({
    ok: false,
    error: { message: "Agent ID already exists" },
  }));
  const presets = vi.fn(async () => ({
    ok: true,
    value: [
      {
        id: "openai",
        label: "OpenAI",
        model: "model",
        baseUrl: "https://example.com/v1",
        requiresKey: true,
      },
    ],
  }));
  const readProfileSettings = vi.fn(() =>
    readProfiles ? readProfiles(settings) : Promise.resolve({ ok: true as const, value: settings }),
  );
  const identityProfile: IdentityProfileView = {
    agentId: "first",
    displayName: "First",
    source: "yaml",
    editable: true,
    readOnlyReason: null,
    authoredYaml: "agent_id: first\nmission: Original\n",
    profileRevision: 2,
    profileVersion: "profile-v2",
    sourceSha256: "source-v2",
    validationOk: false,
    validationErrors: ["role.mission: Field required"],
    validationWarnings: ["responsibilities work best with three to seven entries"],
    verificationOk: false,
    sourceStatus: "drifted",
    verificationIssues: ["source YAML does not match the stored profile"],
    generatedStatus: "clean",
    generatedFiles: ["AGENT.md", "SOUL.md"],
    generatedDriftedFiles: ["AGENT.md"],
    render: {
      text: "Mission: Original",
      purpose: "act",
      profileVersion: "profile-v2",
      renderVersion: "render-v1",
      budget: { maxTokens: 180, usedTokens: 42, maxChars: 720, usedChars: 168 },
      includedFields: ["role.mission"],
      omittedFields: ["personality.formatting"],
      warnings: ["non-critical fields omitted to fit budget"],
    },
  };
  const readIdentity = vi.fn(async () => ({
    ok: true as const,
    value: {
      profiles: [
        identityProfile,
        {
          ...identityProfile,
          agentId: "second",
          displayName: "Second",
          source: "bundle",
          editable: false,
          readOnlyReason: "Bundle-managed identity is read-only.",
          authoredYaml: null,
          profileVersion: "profile-v3",
          sourceSha256: null,
          validationOk: true,
          validationErrors: [],
          validationWarnings: [],
          verificationOk: true,
          sourceStatus: "not_applicable",
          verificationIssues: [],
          generatedDriftedFiles: [],
        },
      ],
    },
  }));
  const verifyIdentity = vi.fn<NativeApi["identity"]["verify"]>(async () => ({
    ok: true as const,
    value: {
      agentId: "first",
      validationOk: true,
      issues: [],
      warnings: [],
      render: { ...identityProfile.render, text: "Mission: Verified draft" },
    },
  }));
  const saveIdentity = vi.fn<NativeApi["identity"]["save"]>(async () => ({
    ok: true as const,
    value: identityProfile,
  }));
  const api = {
    profiles: { read: readProfileSettings, save, setup, presets },
    identity: {
      read: readIdentity,
      verify: verifyIdentity,
      save: saveIdentity,
      reload: vi.fn(),
    },
  } as unknown as NativeApi;
  mountProfiles(api, root, vi.fn());
  return {
    get,
    confirm,
    save,
    setup,
    presets,
    readProfileSettings,
    readIdentity,
    verifyIdentity,
    saveIdentity,
  };
}

describe("identity settings", () => {
  it("humanizes known identity facts and preserves unknown future values", () => {
    expect(identitySourceLabel("yaml")).toBe("Direct YAML");
    expect(identityStatusLabel("not_applicable")).toBe("Not applicable");
    expect(identitySourceLabel("future_source")).toBe("Unknown");
    expect(identityStatusLabel("future_status")).toBe("Unknown");
  });

  it("shows health and render completeness without treating the preview as full YAML", async () => {
    const page = profilePage();
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));

    expect(page.get("identity-source").textContent).toBe("Direct YAML");
    expect(page.get("identity-source-status").textContent).toBe("Changed");
    expect(page.get("identity-sidecars").textContent).toBe("In sync");
    expect(page.get("identity-validation").textContent).toBe("Needs attention");
    expect(page.get("identity-verification").textContent).toBe("Needs attention");
    expect(page.get("identity-generated-drift").textContent).toBe("AGENT.md");
    expect(page.get("identity-issues").textContent).toContain("Validation: role.mission");
    expect(page.get("identity-issues").textContent).toContain("Verification: source YAML");
    expect(page.get("identity-generated-note").textContent).toContain("read-only view");
    expect(page.get("identity-warnings").textContent).toContain("three to seven entries");
    expect(page.get("identity-render-purpose").textContent).toBe("act");
    expect(page.get("identity-render-budget").textContent).toBe("42/180 tokens");
    expect(page.get("identity-render-omitted").textContent).toBe("personality.formatting");
    expect(page.get("identity-render-warnings").textContent).toContain("non-critical fields");
    expect(page.get("identity-reload").textContent).toBe("Discard draft and refresh source");
    expect(page.get("identity-save").disabled).toBe(true);
  });

  it("selects and labels the default agent without replacing an explicit selection", async () => {
    const page = profilePage("second");
    await page.get("show-settings").dispatch("click");
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("second"));
    expect(page.get("identity-agent").children[1]?.textContent).toContain("default");

    page.get("identity-agent").value = "first";
    page.get("identity-agent").dispatch("change");
    await page.get("settings-identity-button").dispatch("click");

    expect(page.get("identity-agent").value).toBe("first");
  });

  it("loads identity after profile settings resolve when Identity is selected early", async () => {
    let resolveProfiles!: (value: { ok: true; value: ProfileSettings }) => void;
    const page = profilePage(
      "second",
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve;
        }),
    );

    page.get("show-settings").dispatch("click");
    page.get("settings-identity-button").dispatch("click");
    expect(page.readIdentity).not.toHaveBeenCalled();

    resolveProfiles({
      ok: true,
      value: {
        setupRequired: false,
        revision: "revision",
        defaultAgent: "second",
        agents: ["first", "second"].map((id) => ({
          id,
          name: id,
          provider: "openai",
          model: `${id}-model`,
          baseUrl: "https://example.com/v1",
          keyConfigured: true,
        })),
        credentials: [],
      },
    });

    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("second"));
    expect(page.readIdentity).toHaveBeenCalledOnce();
  });

  it("loads identity after an initial profile settings failure settles", async () => {
    const page = profilePage("second", async () => {
      throw new Error("profiles unavailable");
    });

    page.get("show-settings").dispatch("click");
    page.get("settings-identity-button").dispatch("click");

    await vi.waitFor(() => expect(page.readIdentity).toHaveBeenCalledOnce());
    expect(page.get("identity-agent").value).toBe("first");
  });

  it("does not block identity loading on a later profile save", async () => {
    const page = profilePage();
    page.get("show-settings").dispatch("click");
    await vi.waitFor(() => expect(page.readProfileSettings).toHaveBeenCalledOnce());
    page.save.mockReturnValueOnce(new Promise(() => {}));
    page.get("profile-model").value = "changed-model";
    page.get("profile-form").dispatch("submit");

    page.get("settings-identity-button").dispatch("click");

    await vi.waitFor(() => expect(page.readIdentity).toHaveBeenCalledOnce());
  });

  it.each(["rejected", "unavailable"])(
    "preserves the draft and gives non-destructive guidance when save is %s",
    async (failure) => {
      const page = profilePage();
      page.get("settings-identity-button").dispatch("click");
      await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
      const yaml = page.get("identity-yaml");
      yaml.value += "tone: Precise\n";
      yaml.dispatch("input");
      const draft = yaml.value;
      if (failure === "rejected") {
        page.saveIdentity.mockResolvedValueOnce({
          ok: false,
          error: {
            code: "stale_identity",
            message: "Identity changed on disk.",
            retryable: false,
            retryAfterMs: null,
          },
        });
      } else {
        page.saveIdentity.mockRejectedValueOnce(new Error("offline"));
      }

      await page.get("identity-save").dispatch("click");

      expect(yaml.value).toBe(draft);
      expect(page.get("identity-status").textContent).toContain("Your draft is still here");
      if (failure === "rejected")
        expect(page.get("identity-status").textContent).not.toContain("Retry");
      else expect(page.get("identity-status").textContent).toContain("Retry");
      expect(page.get("identity-status").textContent).not.toContain("Reload Settings");
    },
  );

  it("invalidates verified output on edit and saves only changed non-blank YAML", async () => {
    const page = profilePage();
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    const yaml = page.get("identity-yaml");

    yaml.value = `${yaml.value}tone: Precise\n`;
    yaml.dispatch("input");
    expect(page.get("identity-status").textContent).toBe("Unverified changes.");
    expect(page.get("identity-preview").value).toContain("Preview is stale");
    expect(page.get("identity-save").disabled).toBe(false);

    await page.get("identity-verify").dispatch("click");
    expect(page.verifyIdentity).toHaveBeenCalledOnce();
    expect(page.get("identity-status").textContent).toBe("Draft is valid and renderable.");
    expect(page.get("identity-preview").value).toContain("Verified draft");

    yaml.value += "formatting: concise\n";
    yaml.dispatch("input");
    expect(page.get("identity-status").textContent).toBe("Unverified changes.");
    expect(page.get("identity-preview").value).toContain("Preview is stale");

    yaml.value = "   ";
    yaml.dispatch("input");
    expect(page.get("identity-save").disabled).toBe(true);
    yaml.value = "agent_id: first\nmission: Original\n";
    yaml.dispatch("input");
    expect(page.get("identity-save").disabled).toBe(true);
    expect(page.get("identity-preview").value).toBe("Mission: Original");
  });

  it("clears a prior successful preview when re-verification returns an error", async () => {
    const page = profilePage();
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    page.get("identity-yaml").value += "tone: Precise\n";
    page.get("identity-yaml").dispatch("input");
    await page.get("identity-verify").dispatch("click");
    expect(page.get("identity-preview").value).toContain("Verified draft");

    page.verifyIdentity.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "identity_failed",
        message: "Verification failed.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    await page.get("identity-verify").dispatch("click");

    expect(page.get("identity-validation").textContent).toBe("Draft could not be verified");
    expect(page.get("identity-issues").hidden).toBe(true);
    expect(page.get("identity-preview").value).toBe("Draft could not be verified.");
  });

  it("clears a prior successful preview when re-verification throws", async () => {
    const page = profilePage();
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    page.get("identity-yaml").value += "tone: Precise\n";
    page.get("identity-yaml").dispatch("input");
    await page.get("identity-verify").dispatch("click");
    expect(page.get("identity-preview").value).toContain("Verified draft");

    page.verifyIdentity.mockRejectedValueOnce(new Error("offline"));
    await page.get("identity-verify").dispatch("click");

    expect(page.get("identity-validation").textContent).toBe("Draft could not be verified");
    expect(page.get("identity-issues").hidden).toBe(true);
    expect(page.get("identity-preview").value).toBe("Draft could not be verified.");
  });

  it("shows every issue returned for a verified draft", async () => {
    const page = profilePage();
    page.verifyIdentity.mockResolvedValueOnce({
      ok: true,
      value: {
        agentId: "first",
        validationOk: false,
        issues: ["mission is required", "risk level is invalid"],
        warnings: [],
        render: null,
      },
    });
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    page.get("identity-yaml").value += "risk: invalid\n";
    page.get("identity-yaml").dispatch("input");

    await page.get("identity-verify").dispatch("click");

    expect(page.get("identity-issues").textContent).toContain("mission is required");
    expect(page.get("identity-issues").textContent).toContain("risk level is invalid");
  });

  it("keeps valid draft warnings separate from errors", async () => {
    const page = profilePage();
    page.verifyIdentity.mockResolvedValueOnce({
      ok: true,
      value: {
        agentId: "first",
        validationOk: true,
        issues: [],
        warnings: ["responsibilities work best with three to seven entries"],
        render: null,
      },
    });
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    page.get("identity-yaml").value += "tone: Precise\n";
    page.get("identity-yaml").dispatch("input");

    await page.get("identity-verify").dispatch("click");

    expect(page.get("identity-validation").textContent).toBe("Draft valid with warnings");
    expect(page.get("identity-issues").hidden).toBe(true);
    expect(page.get("identity-warnings").textContent).toContain("three to seven entries");
  });

  it("clears prior draft feedback when switching to a read-only profile", async () => {
    const page = profilePage();
    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));
    page.get("identity-yaml").value += "tone: Precise\n";
    page.get("identity-yaml").dispatch("input");

    page.get("identity-agent").value = "second";
    page.get("identity-agent").dispatch("change");

    expect(page.get("identity-status").textContent).toBe("");
    expect(page.get("identity-editability").textContent).toBe(
      "Bundle-managed identity is read-only.",
    );
    expect(page.get("identity-yaml").disabled).toBe(true);
    expect(page.get("identity-save").disabled).toBe(true);
    expect(page.get("identity-generated-note").textContent).toContain(
      "Bundle Markdown is authoritative",
    );

    page.get("identity-agent").value = "first";
    page.get("identity-agent").dispatch("change");
    expect(page.get("identity-validation").textContent).toBe("Unverified draft");
    expect(page.get("identity-warnings").hidden).toBe(true);
  });

  it.each([
    ["external", "not_applicable", "External YAML is authoritative"],
    ["inherited", "clean", "Inherited YAML is read-only"],
  ])("shows truthful %s YAML guidance", async (_kind, generatedStatus, expected) => {
    const page = profilePage();
    const initial = await page.readIdentity();
    if (!initial.ok) throw new Error("expected identity fixture");
    page.readIdentity.mockResolvedValueOnce({
      ok: true,
      value: {
        profiles: [
          {
            ...initial.value.profiles[0],
            editable: false,
            readOnlyReason: "YAML profile is read-only.",
            generatedStatus,
          },
        ],
      },
    });

    page.get("settings-identity-button").dispatch("click");
    await vi.waitFor(() => expect(page.get("identity-agent").value).toBe("first"));

    expect(page.get("identity-generated-note").textContent).toContain(expected);
  });
});

describe("profile agent switching", () => {
  it.each([
    ["profile-model", "value", "unsaved-model"],
    ["profile-endpoint", "value", "https://replacement.example/v1"],
    ["profile-key", "value", "replacement-secret"],
    ["profile-key-remove", "checked", true],
    ["profile-default", "checked", true],
  ] as const)(
    "confirms discarding %s, with cancellation preserving its value",
    async (id, field, edit) => {
      const page = profilePage();
      await page.get("show-settings").dispatch("click");
      await vi.waitFor(() => expect(page.get("profile-agent").value).toBe("first"));
      const select = page.get("profile-agent");
      select.value = "second";
      select.dispatch("change");
      expect(page.confirm).not.toHaveBeenCalled();
      Object.assign(page.get(id), { [field]: edit });
      select.value = "first";
      select.dispatch("change");
      expect(page.confirm).toHaveBeenCalledOnce();
      expect(select.value).toBe("second");
      expect(page.get(id)[field]).toBe(edit);
      expect(page.save).not.toHaveBeenCalled();

      page.confirm.mockReturnValue(true);
      select.value = "first";
      select.dispatch("change");
      expect(select.value).toBe("first");
      expect(page.get("profile-model").value).toBe("first-model");
      expect(page.get("profile-endpoint").value).toBe("https://example.com/v1");
      expect(page.get("profile-key").value).toBe("");
      expect(page.get("profile-key-remove").checked).toBe(false);
      expect(page.get("profile-default").checked).toBe(true);
    },
  );

  it("keeps shared tool-key edits through switches and clears all keys on close", async () => {
    const page = profilePage();
    page.get("show-settings").dispatch("click");
    await vi.waitFor(() => expect(page.get("profile-agent").value).toBe("first"));
    page.get("credential-TAVILY_API_KEY").value = "shared-secret";
    page.get("profile-agent").value = "second";
    page.get("profile-agent").dispatch("change");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(page.get("credential-TAVILY_API_KEY").value).toBe("shared-secret");
    page.get("profile-key").value = "model-secret";
    page.get("close-settings").dispatch("click");
    expect(page.get("profile-key").value).toBe("");
    expect(page.get("credential-TAVILY_API_KEY").value).toBe("");
    expect(page.get("show-settings").focus).toHaveBeenCalled();
  });

  it("saves the original agent after cancelling a switch and preserves a rejected edit", async () => {
    const page = profilePage();
    page.get("show-settings").dispatch("click");
    await vi.waitFor(() => expect(page.get("profile-agent").value).toBe("first"));
    page.get("profile-model").value = "edited-model";
    page.get("profile-agent").value = "second";
    page.get("profile-agent").dispatch("change");
    await page.get("profile-form").dispatch("submit");
    expect(page.save).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "first",
        model: "edited-model",
      }),
    );
    expect(page.get("profile-status").textContent).toBe("Save rejected");
    expect(page.get("profile-model").value).toBe("edited-model");
    page.get("profile-agent").value = "second";
    page.get("profile-agent").dispatch("change");
    expect(page.confirm).toHaveBeenCalledTimes(2);
    expect(page.get("profile-agent").value).toBe("first");
  });
});

describe("additional profile creation", () => {
  it("preserves existing edits on cancellation and keeps failed creation editable", async () => {
    const page = profilePage();
    await page.get("show-settings").dispatch("click");
    await vi.waitFor(() => expect(page.get("profile-agent").value).toBe("first"));
    page.get("profile-model").value = "unsaved-model";
    page.get("credential-TAVILY_API_KEY").value = "shared-edit";
    await page.get("profile-add").dispatch("click");
    expect(page.get("setup-fields").hidden).toBe(false);
    expect(page.get("profile-fields").hidden).toBe(true);
    expect(page.get("setup-agent").disabled).toBe(false);
    page.get("setup-key").value = "new-secret";
    page.get("profile-add-cancel").dispatch("click");
    expect(page.get("setup-key").value).toBe("");
    expect(page.get("profile-model").value).toBe("unsaved-model");
    expect(page.get("credential-TAVILY_API_KEY").value).toBe("shared-edit");
    expect(page.get("setup-agent").disabled).toBe(true);
    expect(page.get("profile-save").textContent).toBe("Save and apply");
    await page.get("profile-add").dispatch("click");
    page.get("setup-agent").value = "second";
    page.get("setup-provider").value = "openai";
    page.get("setup-model").value = "new-model";
    page.get("setup-endpoint").value = "https://example.com/v1";
    page.get("setup-key").value = "new-secret";
    page.get("setup-check-provider").checked = false;
    await page.get("profile-form").dispatch("submit");
    expect(page.setup).not.toHaveBeenCalled();
    expect(page.get("profile-model").value).toBe("unsaved-model");
    page.confirm.mockReturnValue(true);
    await page.get("profile-form").dispatch("submit");
    expect(page.setup).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "second", apiKey: "new-secret", checkProvider: false }),
    );
    expect(page.get("profile-status").textContent).toBe("Agent ID already exists");
    expect(page.get("profile-save").disabled).toBe(false);
    expect(page.get("setup-agent").value).toBe("second");
    page.get("close-settings").dispatch("click");
    expect(page.get("setup-key").value).toBe("");
    expect(page.get("credential-TAVILY_API_KEY").value).toBe("");
  });
});
