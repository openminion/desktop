import { describe, expect, it, vi } from "vitest";
import { mountProfiles } from "../../src/renderer/profiles.js";
import type { NativeApi } from "../../src/shared/contracts.js";
import type { ProfileSettings } from "../../src/shared/profiles.js";

function profilePage() {
  const nodes: Element[] = [];
  class Element {
    id = "";
    value = "";
    checked = false;
    disabled = false;
    hidden = false;
    open = false;
    textContent = "";
    focus = vi.fn();
    listeners = new Map<string, (event: unknown) => unknown>();
    addEventListener(name: string, listener: (event: unknown) => unknown) {
      this.listeners.set(name, listener);
    }
    dispatch(name: string) {
      return this.listeners.get(name)?.({ preventDefault: vi.fn() });
    }
    append() {}
    replaceChildren() {}
    setAttribute() {}
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.dispatch("close");
    }
  }
  const create = () => {
    const node = new Element();
    nodes.push(node);
    return node;
  };
  const get = (id: string) => {
    const existing = nodes.find((node) => node.id === id);
    if (existing) return existing;
    const node = create();
    node.id = id;
    return node;
  };
  const confirm = vi.fn(() => false);
  const root = {
    getElementById: get,
    createElement: create,
    createTextNode: create,
    querySelector: () => get("settings-body"),
    addEventListener: vi.fn(),
    activeElement: get("show-settings"),
    defaultView: { confirm },
  } as unknown as Document;
  const settings: ProfileSettings = {
    setupRequired: false,
    revision: "revision",
    defaultAgent: "first",
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
  const api = {
    profiles: { read: async () => ({ ok: true, value: settings }), save, setup, presets },
  } as unknown as NativeApi;
  mountProfiles(api, root, vi.fn());
  return { get, confirm, save, setup, presets };
}

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
