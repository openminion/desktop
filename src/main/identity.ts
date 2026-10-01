import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IdentityProfileView,
  IdentitySaveInput,
  IdentitySettings,
  IdentityValidation,
} from "../shared/identity.js";
import type { CommandResult, RunCommand } from "./installation.js";
import { protocolError, requireRecord, requireString } from "./openminion-client.js";

const MAX_YAML_BYTES = 256 * 1024;

export class IdentitySettingsService {
  constructor(
    readonly configPath: string,
    readonly homeRoot: string,
    readonly dataRoot: string,
    readonly run: RunCommand,
  ) {}

  async read(executable: string): Promise<IdentitySettings> {
    const payload = await this.#command(executable, ["identity", "inspect", "--json"]);
    const profiles = requireRecord(payload).profiles;
    if (!Array.isArray(profiles)) throw this.#unsupported();
    return { profiles: profiles.map((item) => profileView(requireRecord(item))) };
  }

  async verify(input: unknown, executable: string): Promise<IdentityValidation> {
    const yaml = validateYamlInput(input, false).yaml;
    return this.#withCandidate(yaml, async (path) => {
      const result = await this.#run(executable, [
        "identity",
        "validate",
        "--file",
        path,
        "--json",
      ]);
      if (result.exitCode !== 0) {
        const error = parseCommandError(result.stderr);
        if (!error) throw this.#unsupported();
        return {
          agentId: "",
          validationOk: false,
          issues: error.issues.length > 0 ? error.issues : [error.message],
          render: null,
        };
      }
      return validationView(requireRecord(parseCommandOutput(result.stdout, this.#unsupported())));
    });
  }

  async save(input: unknown, executable: string): Promise<IdentityProfileView> {
    const value = validateYamlInput(input, true) as IdentitySaveInput;
    return this.#withCandidate(value.yaml, async (path) => {
      const payload = await this.#command(executable, [
        "identity",
        "apply",
        "--file",
        path,
        "--expected-profile-version",
        value.expectedProfileVersion,
        "--expected-source-sha256",
        value.expectedSourceSha256,
        "--json",
      ]);
      return profileView(requireRecord(payload));
    });
  }

  async #withCandidate<T>(yaml: string, action: (path: string) => Promise<T>): Promise<T> {
    const directory = join(this.dataRoot, "desktop-drafts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `identity-${randomUUID()}.yaml`);
    try {
      await writeFile(path, yaml, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return await action(path);
    } finally {
      await rm(path, { force: true });
    }
  }

  async #command(executable: string, command: string[]): Promise<unknown> {
    const result = await this.#run(executable, command);
    if (result.exitCode !== 0) {
      const error = parseCommandError(result.stderr);
      if (!error) throw this.#unsupported();
      throw protocolError(error.code, error.message);
    }
    return parseCommandOutput(result.stdout, this.#unsupported());
  }

  async #run(executable: string, command: string[]): Promise<CommandResult> {
    return this.run(
      executable,
      [
        "--home-root",
        this.homeRoot,
        "--data-root",
        this.dataRoot,
        "--config",
        this.configPath,
        ...command,
      ],
      30_000,
    );
  }

  #unsupported(): Error {
    return protocolError(
      "runtime_upgrade_required",
      "Identity settings are not available in this OpenMinion runtime. A runtime release with identity editing support is required.",
    );
  }
}

function validateYamlInput(input: unknown, saving: boolean): { yaml: string } | IdentitySaveInput {
  const value = requireRecord(input);
  const allowed = saving ? ["yaml", "expectedProfileVersion", "expectedSourceSha256"] : ["yaml"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw protocolError("invalid_request", "Unknown identity field.");
  const yaml = requireString(value.yaml);
  if (!yaml.trim() || Buffer.byteLength(yaml, "utf8") > MAX_YAML_BYTES)
    throw protocolError("invalid_request", "Enter an identity YAML file up to 256 KB.");
  if (!saving) return { yaml };
  const expectedProfileVersion = requireString(value.expectedProfileVersion);
  if (!expectedProfileVersion || expectedProfileVersion.length > 256)
    throw protocolError("invalid_request", "Reload identity settings before saving.");
  const expectedSourceSha256 = requireString(value.expectedSourceSha256);
  if (!expectedSourceSha256 || expectedSourceSha256.length > 256)
    throw protocolError("invalid_request", "Reload identity settings before saving.");
  return { yaml, expectedProfileVersion, expectedSourceSha256 };
}

function profileView(value: Record<string, unknown>): IdentityProfileView {
  const validation = record(value.validation);
  const verification = record(value.verification);
  const generated = record(value.generated_sidecars);
  return {
    agentId: requireString(value.agent_id),
    displayName: requireString(value.display_name),
    source: requireString(value.source),
    editable: value.editable === true,
    readOnlyReason: typeof value.read_only_reason === "string" ? value.read_only_reason : null,
    authoredYaml: typeof value.authored_yaml === "string" ? value.authored_yaml : null,
    profileRevision: Number(value.profile_revision) || 0,
    profileVersion: requireString(value.profile_version),
    sourceSha256: typeof value.source_sha256 === "string" ? value.source_sha256 : null,
    validationOk:
      Object.keys(verification).length > 0 ? verification.ok === true : validation.ok === true,
    sourceStatus: optionalString(verification.source_status) || "unknown",
    verificationIssues: Array.isArray(verification.issues)
      ? verification.issues.map(issueText)
      : [],
    generatedStatus: requireString(generated.status),
    generatedFiles: strings(generated.files),
    render: renderView(record(value.render)),
  };
}

function validationView(value: Record<string, unknown>): IdentityValidation {
  const validation = record(value.validation);
  return {
    agentId: requireString(value.agent_id),
    validationOk: validation.ok === true,
    issues: [...strings(validation.errors), ...strings(validation.warnings)],
    render: value.render ? renderView(record(value.render)) : null,
  };
}

function renderView(value: Record<string, unknown>) {
  return {
    text: requireString(value.text),
    purpose: requireString(value.purpose),
    profileVersion: requireString(value.profile_version),
    renderVersion: requireString(value.render_version),
    includedFields: strings(value.included_fields),
    omittedFields: strings(value.omitted_fields),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseCommandOutput(value: string, invalid: Error): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw invalid;
  }
}

function parseCommandError(
  value: string,
): { code: string; message: string; issues: string[] } | null {
  try {
    const error = requireRecord(JSON.parse(value));
    return {
      code: optionalString(error.code) || "identity_failed",
      message:
        optionalString(error.message) || "OpenMinion could not complete the identity operation.",
      issues: Array.isArray(error.issues) ? error.issues.map(issueText) : [],
    };
  } catch {
    return null;
  }
}

function issueText(value: unknown): string {
  const issue = record(value);
  const message = optionalString(issue.message) || optionalString(issue.msg) || "Invalid value";
  const location = Array.isArray(issue.loc) ? issue.loc.map(String).join(".") : "";
  return location ? `${location}: ${message}` : message;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
