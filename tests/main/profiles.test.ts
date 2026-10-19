import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiles } from "../../src/main/profiles.js";
import type { RunCommand } from "../../src/main/installation.js";
import type { ProfileSaveInput } from "../../src/shared/profiles.js";

const roots: string[] = [];
function providerCatalog(
  id: string,
  label: string,
  credentialEnv: string | null,
  baseUrl: string,
  model: string,
) {
  return JSON.stringify({
    providers: [
      {
        id,
        label,
        credential_env: credentialEnv,
        requires_credential: Boolean(credentialEnv),
        base_url: baseUrl,
        recommended_models: [model],
      },
    ],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "desktop-profiles-"));
  roots.push(root);
  const path = join(root, "agents.json");
  const config = {
    default_agent: "writer",
    agents: {
      writer: {
        name: "writer",
        provider: "openai",
        system_prompt: "Keep this prompt",
        provider_config_overrides: { temperature: 0.4 },
      },
      other: { provider: "openai" },
    },
    providers: {
      openai: {
        model: "test-model",
        base_url: "https://example.com/v1",
        api_key: "",
        api_key_env: "MODEL_API_KEY",
      },
    },
    runtime: {
      ipc_port: 9876,
      ipc_token: "private-daemon-token",
      env: { MODEL_API_KEY: "private-model-key", TAVILY_API_KEY: "private-tool-key" },
    },
    storage: { path: "preserved.db" },
    security: { mode: "keep" },
  };
  await writeFile(path, JSON.stringify(config));
  const run = vi.fn<RunCommand>(async (_executable, args) => ({
    exitCode: 0,
    stdout: await readFile(args[args.indexOf("--config") + 1], "utf8"),
    stderr: "",
  }));
  const profiles = new Profiles(path, root, join(root, "data"), run);
  const view = await profiles.read();
  const input: ProfileSaveInput = {
    revision: view.revision,
    agentId: "writer",
    model: "new-model",
    baseUrl: "https://example.com/v1",
    makeDefault: true,
    credentials: {},
  };
  return { root, path, config, run, profiles, input };
}

describe("profile settings", () => {
  it("rejects a provider catalog outside the JSON contract", async () => {
    const { profiles, run } = await setup();
    run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "minimax: MiniMax" });

    await expect(profiles.presets("openminion")).rejects.toThrow("setup_unavailable");
  });

  it("accepts a credential-free provider from the JSON catalog", async () => {
    const { profiles, run } = await setup();
    run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: providerCatalog("ollama", "Ollama", null, "http://127.0.0.1:11434", "llama3.1"),
    });

    await expect(profiles.presets("openminion")).resolves.toEqual([
      {
        id: "ollama",
        label: "Ollama",
        requiresKey: false,
        model: "llama3.1",
        baseUrl: "http://127.0.0.1:11434",
      },
    ]);
  });

  it("offers setup for empty profiles and uses the CLI catalog and setup owner with private credentials", async () => {
    const { profiles, path, run, config } = await setup();
    await writeFile(path, JSON.stringify({ ...config, default_agent: "", agents: {} }));
    const initial = await profiles.read();
    expect(initial).toMatchObject({ setupRequired: true, agents: [] });
    run.mockImplementation(async (_exe, args, timeout, environment) => {
      if (args.includes("--list-providers"))
        return {
          exitCode: 0,
          stderr: "",
          stdout: providerCatalog(
            "minimax",
            "MiniMax",
            "MINIMAX_API_KEY",
            "https://api.minimax.io/v1",
            "MiniMax-M2.7",
          ),
        };
      const candidate = args[args.indexOf("--config") + 1];
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (args.includes("setup")) {
        expect(args).toContain("--no-chat");
        expect(args).toContain("--check-provider");
        expect(timeout).toBe(600_000);
        expect(args.join(" ")).not.toContain("new-secret");
        expect(environment).toEqual({ MINIMAX_API_KEY: "new-secret" });
        value.default_agent = "openminion";
        value.agents = { openminion: { name: "openminion", provider: "openai" } };
        value.providers.openai.api_key_env = "MINIMAX_API_KEY";
        await writeFile(candidate, JSON.stringify(value));
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    });
    expect(await profiles.presets("openminion")).toEqual([
      {
        id: "minimax",
        label: "MiniMax",
        requiresKey: true,
        model: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/v1",
      },
    ]);
    expect(run.mock.calls[0]?.[1]).toEqual(["setup", "--list-providers", "--json"]);
    const saved = await profiles.setup(
      {
        revision: initial.revision,
        presetId: "minimax",
        model: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "new-secret",
        checkProvider: true,
      },
      "openminion",
    );
    expect(saved).toMatchObject({
      providerCheck: "verified",
      settings: { setupRequired: false, agents: [{ keyConfigured: true }] },
    });
    expect(JSON.stringify(saved)).not.toContain("new-secret");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.storage).toEqual(config.storage);
    expect(written.runtime.ipc_token).toBe(config.runtime.ipc_token);
    expect(written.runtime.env.MINIMAX_API_KEY).toBe("new-secret");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("creates a distinct profile without replacing shared keys or existing agents", async () => {
    const { profiles, path, run, config } = await setup();
    run.mockImplementation(async (_exe, args, _timeout, environment) => {
      if (args.includes("--list-providers"))
        return {
          exitCode: 0,
          stderr: "",
          stdout: providerCatalog(
            "openai",
            "OpenAI",
            "MODEL_API_KEY",
            "https://example.com/v1",
            "test-model",
          ),
        };
      const candidate = args[args.indexOf("--config") + 1];
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (args.includes("setup")) {
        expect(args[args.indexOf("--agent") + 1]).toBe("second");
        expect(environment).toEqual({ MODEL_API_KEY: "second-key" });
        value.default_agent = "second";
        value.agents.second = {
          name: "second",
          provider: "openai",
          provider_config_overrides: { model: "second-model", api_key_env: "MODEL_API_KEY" },
          model_connections: {
            openai: {
              provider: "openai",
              models: ["second-model"],
              provider_config_overrides: { api_key_env: "MODEL_API_KEY" },
            },
          },
        };
        await writeFile(candidate, JSON.stringify(value));
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    });
    const input = {
      revision: (await profiles.read()).revision,
      agentId: "second",
      presetId: "openai",
      model: "second-model",
      baseUrl: "https://example.com/v1",
      apiKey: "second-key",
      checkProvider: false,
    };
    const result = await profiles.setup(input, "openminion");
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.default_agent).toBe("second");
    expect(stored.agents.writer).toEqual(config.agents.writer);
    expect(stored.agents.other).toEqual(config.agents.other);
    expect(stored.providers).toEqual(config.providers);
    expect(stored.runtime.env).toMatchObject(config.runtime.env);
    expect(stored.agents.second.provider_config_overrides).toMatchObject({
      api_key: "second-key",
      api_key_env: "",
    });
    expect(stored.agents.second.model_connections.openai.provider_config_overrides).toMatchObject({
      api_key: "second-key",
      api_key_env: "",
    });
    expect(JSON.stringify(result)).not.toContain("second-key");
    const current = await profiles.read();
    const before = await readFile(path, "utf8");
    run.mockClear();
    await expect(
      profiles.setup({ ...input, revision: current.revision }, "openminion"),
    ).rejects.toThrow("invalid_request");
    for (const agentId of ["", "two words", "-option", "x".repeat(513)])
      await expect(
        profiles.setup({ ...input, revision: current.revision, agentId }, "openminion"),
      ).rejects.toThrow("invalid_request");
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it.each([false, true])(
    "seeds only an unused adapter binding (named connection present: %s)",
    async (used) => {
      const { profiles, path, run, config } = await setup();
      const originalBinding = {
        model: "prior-model",
        api_key_env: "EXTERNAL_API_KEY",
        api_key: "",
      };
      const original = {
        ...config,
        providers: { ...config.providers, anthropic: originalBinding },
        agents: {
          ...config.agents,
          writer: {
            ...config.agents.writer,
            ...(used ? { model_connections: { external: { provider: "anthropic" } } } : {}),
          },
        },
      };
      await writeFile(path, JSON.stringify(original));
      run.mockImplementation(async (_exe, args) => {
        if (args.includes("--list-providers"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: providerCatalog(
              "anthropic",
              "Anthropic",
              "ANTHROPIC_API_KEY",
              "https://example.com/v1",
              "test-model",
            ),
          };
        const candidate = args[args.indexOf("--config") + 1];
        const value = JSON.parse(await readFile(candidate, "utf8"));
        if (args.includes("setup")) {
          value.default_agent = "second";
          value.providers.anthropic = { model: "second-model", api_key_env: "ANTHROPIC_API_KEY" };
          value.agents.second = {
            name: "second",
            provider: "anthropic",
            model_connections: {
              anthropic: { provider: "anthropic", provider_config_overrides: {} },
            },
          };
          await writeFile(candidate, JSON.stringify(value));
        }
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
      });
      await profiles.setup(
        {
          revision: (await profiles.read()).revision,
          agentId: "second",
          presetId: "anthropic",
          model: "second-model",
          baseUrl: "https://example.com/v1",
          apiKey: "second-key",
          checkProvider: false,
        },
        "openminion",
      );
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect(stored.runtime.env).toMatchObject(config.runtime.env);
      expect(stored.providers.anthropic).toEqual(
        used ? originalBinding : { model: "second-model", api_key: "second-key", api_key_env: "" },
      );
      expect(stored.agents.writer).toEqual(original.agents.writer);
    },
  );

  it("can save setup without making the optional provider request", async () => {
    const { profiles, path, run, config } = await setup();
    await writeFile(path, JSON.stringify({ ...config, default_agent: "", agents: {} }));
    const initial = await profiles.read();
    run.mockImplementation(async (_exe, args, timeout) => {
      if (args.includes("--list-providers"))
        return {
          exitCode: 0,
          stderr: "",
          stdout: providerCatalog(
            "minimax",
            "MiniMax",
            "MINIMAX_API_KEY",
            "https://api.minimax.io/v1",
            "MiniMax-M2.7",
          ),
        };
      expect(args).not.toContain("--check-provider");
      expect(timeout).toBe(30_000);
      const candidate = args[args.indexOf("--config") + 1];
      const value = JSON.parse(await readFile(candidate, "utf8"));
      value.default_agent = "openminion";
      value.agents = { openminion: { name: "openminion", provider: "openai" } };
      await writeFile(candidate, JSON.stringify(value));
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    const saved = await profiles.setup(
      {
        revision: initial.revision,
        presetId: "minimax",
        model: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "new-secret",
        checkProvider: false,
      },
      "openminion",
    );

    expect(saved.providerCheck).toBe("not_requested");
    expect(saved.settings.setupRequired).toBe(false);
  });

  it("keeps the original config when CLI setup fails and removes its private candidate", async () => {
    const { profiles, path, run, root, config } = await setup();
    const original = JSON.stringify({
      ...config,
      default_agent: "openminion",
      agents: { openminion: { provider: "echo" } },
    });
    await writeFile(path, original);
    run.mockImplementation(async (_exe, args) =>
      args.includes("--list-providers")
        ? {
            exitCode: 0,
            stderr: "",
            stdout: providerCatalog(
              "minimax",
              "MiniMax",
              "MINIMAX_API_KEY",
              "https://api.minimax.io/v1",
              "MiniMax-M2.7",
            ),
          }
        : { exitCode: 2, stderr: "private-error", stdout: "" },
    );
    const input = {
      revision: (await profiles.read()).revision,
      presetId: "minimax",
      model: "m",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "new-secret",
      checkProvider: false,
    };
    await expect(profiles.setup(input, "openminion")).rejects.toThrow("setup_failed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.includes(".setup-"))).toEqual([]);
    await expect(profiles.setup({ ...input, apiKey: "" }, "openminion")).rejects.toThrow(
      "invalid_request",
    );
    await expect(profiles.setup({ ...input, presetId: "--help" }, "openminion")).rejects.toThrow(
      "invalid_request",
    );
    const { checkProvider: _, ...withoutCheck } = input;
    await expect(profiles.setup(withoutCheck, "openminion")).rejects.toThrow("invalid_request");
    await expect(profiles.setup({ ...input, checkProvider: "yes" }, "openminion")).rejects.toThrow(
      "invalid_request",
    );
  });

  it("loads and saves a first-run echo profile without an explicit default", async () => {
    const { profiles, path, input } = await setup();
    await writeFile(
      path,
      JSON.stringify({
        default_agent: "",
        agents: { openminion: { name: "OpenMinion", provider: "echo" } },
        runtime: { demo_mode: true },
      }),
    );
    const view = await profiles.read();
    expect(view.defaultAgent).toBe("openminion");
    await profiles.save(
      { ...input, revision: view.revision, agentId: "openminion", model: "", baseUrl: "" },
      "openminion",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.runtime.demo_mode).toBe(true);
    expect(saved.agents.openminion).not.toHaveProperty("provider_config_overrides");
  });

  it("returns only editable metadata and configured flags, preserving secrets on blank edits", async () => {
    const { profiles, input, config, path, run, root } = await setup();
    const initial = await profiles.read();
    expect(JSON.stringify(initial)).not.toMatch(/private-|MODEL_API_KEY|system_prompt|ipc_token/);
    expect(initial.agents[0].keyConfigured).toBe(true);
    const saved = await profiles.save(input, "openminion");
    expect(saved.agents[0].model).toBe("new-model");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.agents.writer.system_prompt).toBe(config.agents.writer.system_prompt);
    expect(written.agents.other).toEqual(config.agents.other);
    expect(written.providers).toEqual(config.providers);
    expect(written.runtime.env.MODEL_API_KEY).toBe("private-model-key");
    expect(written.runtime.env.OPENMINION_HOME).toBe(root);
    expect(written.system.runtime).toEqual(written.runtime);
    expect(written.storage).toEqual(config.storage);
    expect(written.runtime.ipc_token).toBe("private-daemon-token");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}.backup`)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(run.mock.calls)).not.toContain("private-");
    expect(JSON.parse(await readFile(`${path}.backup`, "utf8"))).toEqual(config);
  });

  it("replaces model and tool credentials without returning them, and removes saved values explicitly", async () => {
    const { profiles, input, path } = await setup();
    const saved = await profiles.save(
      {
        ...input,
        apiKey: "replacement-secret",
        credentials: { TAVILY_API_KEY: "replacement-tool" },
      },
      "openminion",
    );
    expect(JSON.stringify(saved)).not.toMatch(/replacement-|private-/);
    expect(
      JSON.parse(await readFile(path, "utf8")).agents.writer.provider_config_overrides,
    ).toMatchObject({ api_key: "replacement-secret", api_key_env: "" });
    const removed = await profiles.save(
      { ...input, revision: saved.revision, apiKey: null, credentials: { TAVILY_API_KEY: null } },
      "openminion",
    );
    expect(removed.agents[0].keyConfigured).toBe(false);
    expect(removed.agents[1].keyConfigured).toBe(true);
    expect(removed.credentials.find((item) => item.name === "TAVILY_API_KEY")?.configured).toBe(
      false,
    );
  });

  it("imports provider settings per agent and keys without replacing Desktop paths, policy, or other profiles", async () => {
    const { profiles, input, path, root, config } = await setup();
    const imported = join(root, "import.json");
    await writeFile(
      imported,
      JSON.stringify({
        agents: {
          minimax: { name: "minimax", provider: "openai", system_prompt: "Imported prompt" },
        },
        default_agent: "minimax",
        providers: {
          openai: {
            model: "MiniMax-M2.7",
            base_url: "https://api.minimax.io/v1",
            api_key_env: "MINIMAX_API_KEY",
          },
        },
        runtime: {
          ipc_port: 1111,
          env: {
            MINIMAX_API_KEY: "imported-secret",
            OPENMINION_HOME: "/wrong",
            OPENMINION_IPC_PORT: "1111",
            NODE_OPTIONS: "bad",
            OPENMINION_BRAIN_MAX_TICKS: "16",
          },
        },
        storage: { path: "/wrong.db" },
      }),
    );
    const saved = await profiles.importFile(imported, input.revision, "openminion");
    expect(saved.defaultAgent).toBe("minimax");
    expect(saved.agents.find((agent) => agent.id === "minimax")).toMatchObject({
      model: "MiniMax-M2.7",
      keyConfigured: true,
    });
    expect(JSON.stringify(saved)).not.toContain("imported-secret");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.providers.openai.model).toBe("MiniMax-M2.7");
    expect(written.agents.writer.system_prompt).toBe(config.agents.writer.system_prompt);
    expect(written.agents.writer.provider_config_overrides).toMatchObject({
      ...config.providers.openai,
      temperature: 0.4,
    });
    expect(written.storage).toEqual(config.storage);
    expect(written.security).toEqual(config.security);
    expect(written.runtime.ipc_port).toBe(9876);
    expect(written.runtime.env.OPENMINION_HOME).toBe(root);
    expect(written.runtime.demo_mode).toBe(false);
    expect(written.runtime.env.OPENMINION_BRAIN_MAX_TICKS).toBe("16");
    expect(written.runtime.env).not.toHaveProperty("OPENMINION_IPC_PORT");
    expect(written.runtime.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("rejects stale changes, invalid endpoints, unknown settings, and failed canonical validation without writing", async () => {
    const { profiles, input, path, config, run, root } = await setup();
    for (const patch of [
      { revision: "b".repeat(64) },
      { baseUrl: "https://user:secret@example.com" },
      { baseUrl: "file:///private/file" },
      { credentials: { NODE_OPTIONS: "bad" } },
      { ipcToken: "bad" },
      { name: "renamed" },
      { apiKey: "" },
    ]) {
      await expect(profiles.save({ ...input, ...patch }, "openminion")).rejects.toThrow();
    }
    run.mockResolvedValue({ exitCode: 1, stdout: "private-secret", stderr: "private-secret" });
    await expect(profiles.save(input, "openminion")).rejects.toThrow("invalid_profile");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
    expect(await readdir(root)).toEqual(["agents.json"]);
  });
});
