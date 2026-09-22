import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiles } from "../../src/main/profiles.js";
import type { RunCommand } from "../../src/main/installation.js";
import type { ProfileSaveInput } from "../../src/shared/profiles.js";

const roots: string[] = [];
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
  it("offers setup for empty profiles and uses the CLI catalog and setup owner with private credentials", async () => {
    const { profiles, path, run, config } = await setup();
    await writeFile(path, JSON.stringify({ ...config, default_agent: "", agents: {} }));
    const initial = await profiles.read();
    expect(initial).toMatchObject({ setupRequired: true, agents: [] });
    run.mockImplementation(async (_exe, args, _timeout, environment) => {
      if (args.includes("--list-providers"))
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            "Supported setup providers:\n\nminimax: MiniMax\n  Credential: MINIMAX_API_KEY\n  Endpoint: https://api.minimax.io/v1\n  Recommended models: MiniMax-M2.7\n\n",
        };
      const candidate = args[args.indexOf("--config") + 1];
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (args.includes("setup")) {
        expect(args).toContain("--no-chat");
        expect(args).not.toContain("--check-provider");
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
    const saved = await profiles.setup(
      {
        revision: initial.revision,
        presetId: "minimax",
        model: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "new-secret",
      },
      "openminion",
    );
    expect(saved).toMatchObject({ setupRequired: false, agents: [{ keyConfigured: true }] });
    expect(JSON.stringify(saved)).not.toContain("new-secret");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.storage).toEqual(config.storage);
    expect(written.runtime.ipc_token).toBe(config.runtime.ipc_token);
    expect(written.runtime.env.MINIMAX_API_KEY).toBe("new-secret");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
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
            stdout:
              "minimax: MiniMax\n  Credential: MINIMAX_API_KEY\n  Endpoint: https://api.minimax.io/v1\n  Recommended models: MiniMax-M2.7\n",
          }
        : { exitCode: 2, stderr: "private-error", stdout: "" },
    );
    const input = {
      revision: (await profiles.read()).revision,
      presetId: "minimax",
      model: "m",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "new-secret",
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
