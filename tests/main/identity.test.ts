import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentitySettingsService } from "../../src/main/identity.js";
import type { RunCommand } from "../../src/main/installation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "desktop-identity-"));
  roots.push(root);
  const run = vi.fn<RunCommand>();
  const service = new IdentitySettingsService(
    join(root, "agents.json"),
    root,
    join(root, "data"),
    run,
  );
  return { root, run, service };
}

const profile = {
  agent_id: "ops",
  display_name: "Ops",
  source: "yaml",
  source_path: "/private/identity/ops/profile.yaml",
  editable: true,
  read_only_reason: null,
  authored_yaml: "agent_id: ops\n",
  effective_profile: { meta: { secret: "not-for-renderer" } },
  profile_revision: 2,
  profile_version: "profile-v2",
  source_sha256: "source-sha-v2",
  validation: { ok: true, errors: [], warnings: ["responsibilities are sparse"] },
  verification: { ok: false, source_status: "drifted", issues: [{ message: "source drift" }] },
  generated_sidecars: { status: "clean", files: ["AGENT.md"] },
  render: {
    text: "Operate safely.",
    purpose: "act",
    profile_version: "profile-v2",
    render_version: "render-v1",
    budget: {
      max_tokens: 180,
      used_tokens: 42,
      max_chars: 720,
      used_chars: 168,
    },
    included_fields: ["role.mission"],
    omitted_fields: ["personality.formatting"],
    warnings: ["non-critical fields omitted to fit budget"],
  },
};

describe("identity settings service", () => {
  it("reads allowlisted identity fields without native paths or arbitrary metadata", async () => {
    const { service, run } = await setup();
    run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ profiles: [profile] }),
      stderr: "",
    });

    const result = await service.read("openminion");

    expect(result.profiles[0]).toMatchObject({
      agentId: "ops",
      source: "yaml",
      profileVersion: "profile-v2",
      sourceSha256: "source-sha-v2",
      generatedStatus: "clean",
      generatedFiles: ["AGENT.md"],
      sourceStatus: "drifted",
      verificationIssues: ["source drift"],
      validationWarnings: ["responsibilities are sparse"],
      render: {
        purpose: "act",
        budget: { maxTokens: 180, usedTokens: 42, maxChars: 720, usedChars: 168 },
        omittedFields: ["personality.formatting"],
        warnings: ["non-critical fields omitted to fit budget"],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/source_path|\/private|secret/);
    expect(run.mock.calls[0][1]).toContain("inspect");
  });

  it.each([
    ["missing", undefined],
    ["string", "2"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
  ])("rejects a %s profile revision", async (_label, revision) => {
    const { service, run } = await setup();
    run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ profiles: [{ ...profile, profile_revision: revision }] }),
      stderr: "",
    });

    await expect(service.read("openminion")).rejects.toMatchObject({
      clientError: {
        code: "invalid_daemon_response",
        message: "Identity profile revision is invalid.",
      },
    });
  });

  it("verifies a private draft and removes it after the command", async () => {
    const { root, service, run } = await setup();
    run.mockImplementation(async (_executable, args) => {
      const path = args[args.indexOf("--file") + 1];
      expect(await readFile(path, "utf8")).toBe("agent_id: ops\n");
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          agent_id: "ops",
          validation: { ok: true, errors: [], warnings: ["responsibilities are sparse"] },
          render: profile.render,
        }),
      };
    });

    const result = await service.verify({ yaml: "agent_id: ops\n" }, "openminion");

    expect(result.validationOk).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual(["responsibilities are sparse"]);
    expect(result.render).toMatchObject({
      budget: { maxTokens: 180, usedTokens: 42, maxChars: 720, usedChars: 168 },
      warnings: ["non-critical fields omitted to fit budget"],
    });
    expect(await readdir(join(root, "data", "desktop-drafts"))).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["non-numeric", "180"],
    ["zero", 0],
  ])("rejects a %s required render budget", async (_label, maxTokens) => {
    const { service, run } = await setup();
    run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        profiles: [
          {
            ...profile,
            render: {
              ...profile.render,
              budget: { ...profile.render.budget, max_tokens: maxTokens },
            },
          },
        ],
      }),
      stderr: "",
    });

    await expect(service.read("openminion")).rejects.toMatchObject({
      clientError: {
        code: "invalid_daemon_response",
        message: "Identity render budget is invalid.",
      },
    });
  });

  it("returns field-level validation issues without treating them as a bridge failure", async () => {
    const { service, run } = await setup();
    run.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({
        ok: false,
        code: "invalid_candidate",
        message: "identity candidate is invalid",
        issues: [{ loc: ["role", "mission"], msg: "Field required" }],
      }),
    });

    const result = await service.verify({ yaml: "agent_id: ops\n" }, "openminion");

    expect(result).toMatchObject({
      validationOk: false,
      issues: ["role.mission: Field required"],
      render: null,
    });
  });

  it("saves through revision-guarded apply and returns refreshed state", async () => {
    const { service, run } = await setup();
    run.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(profile), stderr: "" });

    const result = await service.save(
      {
        yaml: "agent_id: ops\n",
        expectedProfileVersion: "profile-v2",
        expectedSourceSha256: "source-sha-v2",
      },
      "openminion",
    );

    expect(result.agentId).toBe("ops");
    const args = run.mock.calls[0][1];
    expect(args).toContain("apply");
    expect(args).toContain("profile-v2");
    expect(args).toContain("source-sha-v2");
  });

  it("maps an older runtime to an upgrade-required error", async () => {
    const { service, run } = await setup();
    run.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "unknown command: inspect" });

    await expect(service.read("openminion")).rejects.toThrow("runtime_upgrade_required");
  });
});
