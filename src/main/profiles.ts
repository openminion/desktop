// Reads and edits the existing OpenMinion config without exposing stored secrets.
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { RunCommand } from "./installation.js";
import { protocolError, requireArray, requireRecord, requireString } from "./openminion-client.js";
import {
  TOOL_CREDENTIALS,
  type ProfileSaveInput,
  type ProfileSettings,
  type ProfileSetupResult,
  type SetupPreset,
  type ProfileSetupInput,
} from "../shared/profiles.js";

type Config = Record<string, unknown>;
const credentialNames = new Set<string>(TOOL_CREDENTIALS.map(([name]) => name));
const importedRuntimeSettings = new Set([
  "OPENMINION_BRAIN_MAX_ELAPSED_MS",
  "OPENMINION_BRAIN_MAX_TICKS",
  "OPENMINION_BRAIN_MAX_TOTAL_LLM_TOKENS",
  "OPENMINION_BRAIN_MAX_TOOL_CALLS",
  "OPENMINION_WEB_SEARCH_PROVIDER",
]);
const SETUP_TIMEOUT_MS = 30_000;
const CHECKED_SETUP_TIMEOUT_MS = 600_000;

export class Profiles {
  constructor(
    readonly configPath: string,
    readonly homeRoot: string,
    readonly dataRoot: string,
    readonly run: RunCommand,
  ) {}

  async read(): Promise<ProfileSettings> {
    const text = await readFile(this.configPath, "utf8");
    return settings(requireRecord(JSON.parse(text)), revision(text));
  }

  async presets(executable: string): Promise<SetupPreset[]> {
    return (await this.#presets(executable)).map(({ credentialEnv: _, ...preset }) => preset);
  }

  async #presets(executable: string) {
    const result = await this.run(
      executable,
      ["setup", "--list-providers", "--json"],
      SETUP_TIMEOUT_MS,
    );
    if (result.exitCode !== 0)
      throw protocolError("setup_unavailable", "OpenMinion could not list setup providers.");
    let payload: Record<string, unknown>;
    try {
      payload = requireRecord(JSON.parse(result.stdout));
    } catch {
      throw protocolError("setup_unavailable", "OpenMinion returned an invalid setup catalog.");
    }
    if (!("providers" in payload))
      throw protocolError("setup_unavailable", "OpenMinion returned an invalid setup catalog.");
    const presets = requireArray(payload.providers).map((entry) => {
      const provider = requireRecord(entry);
      if (typeof provider.requires_credential !== "boolean")
        throw protocolError("setup_unavailable", "OpenMinion returned an invalid setup catalog.");
      const credentialEnv =
        provider.credential_env === null ? "" : requireString(provider.credential_env);
      if (provider.requires_credential !== Boolean(credentialEnv))
        throw protocolError(
          "setup_unavailable",
          "OpenMinion returned an invalid credential binding.",
        );
      const baseUrl = provider.base_url === null ? "" : requireString(provider.base_url);
      return {
        id: requireString(provider.id),
        label: requireString(provider.label),
        credentialEnv,
        requiresKey: provider.requires_credential,
        baseUrl,
        model: requireArray(provider.recommended_models).map(requireString)[0] ?? "",
      };
    });
    if (!presets.length)
      throw protocolError(
        "setup_unavailable",
        "This OpenMinion version does not provide setup choices.",
      );
    return presets;
  }

  async setup(input: unknown, executable: string): Promise<ProfileSetupResult> {
    const value = requireRecord(input);
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "revision",
            "agentId",
            "presetId",
            "model",
            "baseUrl",
            "apiKey",
            "checkProvider",
          ].includes(key),
      )
    )
      throw protocolError("invalid_request", "Unknown setup field.");
    for (const name of ["revision", "presetId", "model", "baseUrl", "apiKey"])
      if (
        typeof value[name] !== "string" ||
        String(value[name]).length > (name === "apiKey" ? 16_384 : 2048)
      )
        throw protocolError("invalid_request", "Enter valid setup fields.");
    if (typeof value.checkProvider !== "boolean")
      throw protocolError("invalid_request", "Choose whether to test the provider connection.");
    const request = value as ProfileSetupInput;
    if (
      request.agentId !== undefined &&
      (typeof request.agentId !== "string" ||
        !request.agentId ||
        request.agentId.length > 512 ||
        /\s|\0/.test(request.agentId) ||
        request.agentId.startsWith("-"))
    )
      throw protocolError("invalid_request", "Enter an agent ID without spaces or a leading dash.");
    validateEndpoint(request.baseUrl);
    if (!request.model.trim() || request.model.startsWith("-"))
      throw protocolError("invalid_request", "Enter a model name.");
    const text = await readFile(this.configPath, "utf8");
    if (revision(text) !== request.revision)
      throw protocolError(
        "settings_changed",
        "Settings changed elsewhere. Reopen Settings before setup.",
      );
    const config = requireRecord(JSON.parse(text));
    const view = settings(config, revision(text));
    if (
      request.agentId !== undefined &&
      Object.hasOwn(requireRecord(config.agents), request.agentId)
    )
      throw protocolError("invalid_request", "That agent ID already exists. Choose a new ID.");
    if (!view.setupRequired && request.agentId === undefined)
      throw protocolError(
        "invalid_request",
        "An agent is already configured. Use its settings or import another profile.",
      );
    const preset = (await this.#presets(executable)).find((item) => item.id === request.presetId);
    if (!preset)
      throw protocolError("invalid_request", "Choose a provider from OpenMinion's setup list.");
    if (preset.requiresKey && !request.apiKey.trim())
      throw protocolError("invalid_request", "Enter the provider API key.");
    const candidate = `${this.configPath}.setup-${randomUUID()}.json`;
    try {
      await writeFile(candidate, text, { mode: 0o600, flag: "wx" });
      const environment = preset.credentialEnv
        ? { [preset.credentialEnv]: request.apiKey.trim() }
        : {};
      const setupArgs = [
        "--home-root",
        this.homeRoot,
        "--data-root",
        this.dataRoot,
        "--config",
        candidate,
        "setup",
        "--no-chat",
        "--provider",
        preset.id,
        "--agent",
        request.agentId ?? (view.defaultAgent || "openminion"),
        "--model",
        request.model.trim(),
        "--base-url",
        request.baseUrl,
      ];
      if (request.checkProvider) setupArgs.push("--check-provider");
      const result = await this.run(
        executable,
        setupArgs,
        request.checkProvider ? CHECKED_SETUP_TIMEOUT_MS : SETUP_TIMEOUT_MS,
        environment,
      );
      if (result.exitCode !== 0)
        throw protocolError(
          "setup_failed",
          "OpenMinion could not validate setup. Check the provider, model, URL, and key.",
        );
      const configured = requireRecord(JSON.parse(await readFile(candidate, "utf8")));
      if (request.agentId !== undefined && preset.requiresKey) {
        const agent = requireRecord(requireRecord(configured.agents)[request.agentId]);
        const connection = requireRecord(requireRecord(agent.model_connections)[preset.id]);
        const credential = { api_key: request.apiKey.trim(), api_key_env: "" };
        agent.provider_config_overrides = {
          ...record(agent.provider_config_overrides),
          ...credential,
        };
        connection.provider_config_overrides = {
          ...record(connection.provider_config_overrides),
          ...credential,
        };
        const adapter = requireString(agent.provider);
        const alreadyUsed = Object.values(record(config.agents)).some((value) => {
          const existing = requireRecord(value);
          return (
            existing.provider === adapter ||
            Object.values(record(existing.model_connections)).some(
              (value) => requireRecord(value).provider === adapter,
            )
          );
        });
        const providers = requireRecord(configured.providers);
        // Keep existing bindings intact; readiness also checks each new adapter's shared key.
        providers[adapter] = alreadyUsed
          ? providerConfig(config, { provider: adapter })
          : { ...requireRecord(providers[adapter]), ...credential };
        configured.system = { ...record(configured.system), providers };
      }
      this.#setRuntime(configured, {
        ...runtimeEnv(configured),
        ...(request.agentId === undefined ? environment : {}),
      });
      return {
        settings: await this.#write(configured, text, executable),
        providerCheck: request.checkProvider ? "verified" : "not_requested",
      };
    } finally {
      await rm(candidate, { force: true });
    }
  }

  async save(input: unknown, executable: string): Promise<ProfileSettings> {
    const value = validateSave(input);
    const text = await readFile(this.configPath, "utf8");
    if (revision(text) !== value.revision)
      throw protocolError(
        "settings_changed",
        "Settings changed elsewhere. Close and reopen Settings before saving.",
      );
    const config = requireRecord(JSON.parse(text));
    const agents = requireRecord(config.agents);
    if (!Object.hasOwn(agents, value.agentId))
      throw protocolError("invalid_request", "Choose an existing agent profile.");
    const agent = requireRecord(agents[value.agentId]);
    const overrides = {
      ...record(agent.provider_config_overrides),
      model: value.model,
      base_url: value.baseUrl,
    };
    if (value.apiKey !== undefined) {
      Object.assign(overrides, { api_key: value.apiKey ?? "" });
      // An explicit replacement/removal must not fall back to a shared provider key.
      Object.assign(overrides, { api_key_env: "" });
    }
    if (agent.provider === "echo") {
      if (value.model || value.baseUrl || value.apiKey !== undefined)
        throw protocolError("invalid_request", "Import a model profile to replace the echo demo.");
    } else {
      validateEndpoint(value.baseUrl);
      if (!value.model) throw protocolError("invalid_request", "Enter a model name.");
    }
    if (agent.provider !== "echo") agent.provider_config_overrides = overrides;
    if (value.makeDefault) config.default_agent = value.agentId;
    const env = { ...runtimeEnv(config) };
    for (const [name, secret] of Object.entries(value.credentials)) {
      env[name] = secret ?? "";
    }
    this.#setRuntime(config, env);
    return this.#write(config, text, executable);
  }

  async importFile(
    path: string,
    expectedRevision: string,
    executable: string,
  ): Promise<ProfileSettings> {
    const text = await readFile(this.configPath, "utf8");
    if (revision(text) !== expectedRevision)
      throw protocolError(
        "settings_changed",
        "Settings changed elsewhere. Close and reopen Settings before importing.",
      );
    const loaded = await this.run(
      executable,
      [
        "--home-root",
        this.homeRoot,
        "--data-root",
        this.dataRoot,
        "--config",
        path,
        "config",
        "show",
      ],
      30_000,
    );
    if (loaded.exitCode !== 0)
      throw protocolError("invalid_profile", "OpenMinion could not load that profile JSON file.");
    const incoming = requireRecord(JSON.parse(loaded.stdout));
    const incomingAgents = requireRecord(incoming.agents);
    if (Object.keys(incomingAgents).length === 0)
      throw protocolError("invalid_request", "The file has no agent profiles.");
    const config = requireRecord(JSON.parse(text));
    const current = await this.run(
      executable,
      [
        "--home-root",
        this.homeRoot,
        "--data-root",
        this.dataRoot,
        "--config",
        this.configPath,
        "config",
        "show",
      ],
      30_000,
    );
    if (current.exitCode !== 0)
      throw protocolError(
        "invalid_profile",
        "OpenMinion could not load the current configuration.",
      );
    const effective = requireRecord(JSON.parse(current.stdout));
    const agents = { ...record(config.agents) };
    const providers = { ...record(config.providers), ...record(record(config.system).providers) };
    const importedProviders = new Set(
      Object.values(incomingAgents).map((value) => requireString(requireRecord(value).provider)),
    );
    for (const [id, value] of Object.entries(agents)) {
      const agent = requireRecord(value);
      if (!Object.hasOwn(incomingAgents, id) && importedProviders.has(String(agent.provider)))
        agents[id] = {
          ...agent,
          provider_config_overrides: providerConfig(
            effective,
            requireRecord(record(effective.agents)[id]),
          ),
        };
    }
    for (const [id, value] of Object.entries(incomingAgents)) {
      const agent = requireRecord(value);
      if (agent.name !== id)
        throw protocolError(
          "invalid_profile",
          "The installed OpenMinion version requires each agent name to match its agent ID. Update the profile file before importing.",
        );
      agents[id] = { ...agent, provider_config_overrides: providerConfig(incoming, agent) };
      const provider = requireString(agent.provider);
      if (Object.hasOwn(record(incoming.providers), provider))
        providers[provider] = record(incoming.providers)[provider];
    }
    // PyPI readiness checks the shared binding even when an agent has overrides.
    config.providers = providers;
    config.system = { ...record(config.system), providers };
    config.agents = agents;
    config.default_agent = defaultAgent(incoming);
    const env = { ...runtimeEnv(config) };
    for (const [name, value] of Object.entries(runtimeEnv(incoming))) {
      if (name.endsWith("_API_KEY") || importedRuntimeSettings.has(name)) env[name] = value;
    }
    this.#setRuntime(config, env);
    return this.#write(config, text, executable);
  }

  #setRuntime(config: Config, env: Config) {
    env.OPENMINION_HOME = this.homeRoot;
    env.OPENMINION_DATA_ROOT = this.dataRoot;
    const selected = record(record(config.agents)[defaultAgent(config)]);
    const runtime = {
      ...record(config.runtime),
      ...record(record(config.system).runtime),
      env,
      demo_mode: selected.provider === "echo",
    };
    config.runtime = runtime;
    config.system = { ...record(config.system), runtime };
  }

  async #write(config: Config, original: string, executable: string): Promise<ProfileSettings> {
    const candidate = `${this.configPath}.${randomUUID()}.json`;
    const encoded = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await writeFile(candidate, encoded, { mode: 0o600, flag: "wx" });
      const checked = await this.run(
        executable,
        [
          "--home-root",
          this.homeRoot,
          "--data-root",
          this.dataRoot,
          "--config",
          candidate,
          "config",
          "show",
        ],
        30_000,
      );
      if (checked.exitCode !== 0)
        throw protocolError(
          "invalid_profile",
          "OpenMinion could not load these settings. Check the model profile and try again.",
        );
      if ((await readFile(this.configPath, "utf8")) !== original)
        throw protocolError(
          "settings_changed",
          "Settings changed elsewhere. Reopen Settings before saving.",
        );
      const view = settings(config, revision(encoded));
      const backup = `${this.configPath}.backup`;
      await writeFile(backup, original, { mode: 0o600 });
      await chmod(backup, 0o600);
      await rename(candidate, this.configPath);
      return view;
    } finally {
      await rm(candidate, { force: true });
    }
  }
}

function record(value: unknown): Config {
  return value === undefined ? {} : requireRecord(value);
}

function runtimeEnv(config: Config): Config {
  return {
    ...record(record(config.runtime).env),
    ...record(record(record(config.system).runtime).env),
  };
}

function providerConfig(config: Config, agent: Config): Config {
  const provider = String(agent.provider);
  return {
    ...record(record(config.providers)[provider]),
    ...record(record(record(config.system).providers)[provider]),
    ...record(agent.provider_config_overrides),
  };
}

function defaultAgent(config: Config): string {
  const ids = Object.keys(record(config.agents));
  if (!ids.length) return "";
  if (ids.length === 1) return ids[0];
  if (typeof config.default_agent !== "string" || !ids.includes(config.default_agent))
    throw protocolError(
      "invalid_profile",
      "Choose a default_agent in a file with multiple agent profiles.",
    );
  return config.default_agent;
}

function settings(config: Config, hash: string): ProfileSettings {
  const env = runtimeEnv(config);
  const selected = defaultAgent(config);
  return {
    setupRequired: !selected || record(record(config.agents)[selected]).provider === "echo",
    revision: hash,
    defaultAgent: defaultAgent(config),
    agents: Object.entries(record(config.agents)).map(([id, entry]) => {
      const agent = requireRecord(entry);
      const provider = providerConfig(config, agent);
      if (typeof provider.base_url === "string" && provider.base_url)
        validateEndpoint(provider.base_url);
      return {
        id,
        name: typeof agent.name === "string" ? agent.name : id,
        provider: requireString(agent.provider),
        model: typeof provider.model === "string" ? provider.model : "",
        baseUrl: typeof provider.base_url === "string" ? provider.base_url : "",
        keyConfigured: Boolean(
          provider.api_key ||
            env[String(provider.api_key_env)] ||
            process.env[String(provider.api_key_env)],
        ),
      };
    }),
    credentials: TOOL_CREDENTIALS.map(([name]) => ({
      name,
      configured: Boolean(env[name] || process.env[name]),
    })),
  };
}

function revision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validateSave(input: unknown): ProfileSaveInput {
  const value = requireRecord(input);
  const allowed = [
    "revision",
    "agentId",
    "model",
    "baseUrl",
    "makeDefault",
    "apiKey",
    "credentials",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw protocolError("invalid_request", "Unknown profile setting.");
  for (const field of ["revision", "agentId", "model", "baseUrl"]) {
    if (typeof value[field] !== "string" || value[field].length > 2048)
      throw protocolError("invalid_request", "Enter valid profile fields.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.revision)) || typeof value.makeDefault !== "boolean")
    throw protocolError("invalid_request", "Select an agent profile.");
  const credentials = requireRecord(value.credentials);
  if (Object.keys(credentials).some((name) => !credentialNames.has(name)))
    throw protocolError("invalid_request", "Unknown tool credential.");
  for (const secret of [...Object.values(credentials), value.apiKey]) {
    if (
      secret !== undefined &&
      secret !== null &&
      (typeof secret !== "string" || !secret.trim() || secret.length > 16_384)
    )
      throw protocolError("invalid_request", "Enter a nonempty API key or use Remove.");
  }
  return value as ProfileSaveInput;
}

function validateEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError("invalid_request", "Enter a valid provider URL.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw protocolError(
      "invalid_request",
      "Use an HTTP or HTTPS provider URL without embedded credentials or query parameters.",
    );
}
