#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.OPENMINION_IDENTITY_FIXTURE_STATE;
if (!statePath) process.exit(2);

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.0.29\n");
  process.exit(0);
}
const identityIndex = args.indexOf("identity");
const command = identityIndex >= 0 ? args[identityIndex + 1] : "";
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const render = (profileVersion) => ({
  text: "Mission: Help the operator precisely.",
  purpose: "act",
  profile_version: profileVersion,
  render_version: "render-v1",
  budget: { max_tokens: 180, used_tokens: 42, max_chars: 720, used_chars: 168 },
  included_fields: ["role.mission"],
  omitted_fields: ["personality.formatting"],
  warnings: ["non-critical fields omitted to fit budget"],
});
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const profile = (state) => ({
  agent_id: "openminion",
  display_name: "OpenMinion",
  source: "yaml",
  source_path: "/redacted/by-desktop/profile.yaml",
  editable: true,
  read_only_reason: null,
  authored_yaml: state.yaml,
  effective_profile: { meta: { private_path: "/must/not/cross/ipc" } },
  profile_revision: 1,
  profile_version: state.profileVersion,
  source_sha256: state.sourceSha256,
  validation: { ok: true, errors: [], warnings: [] },
  verification: { ok: true, source_status: "clean", issues: [] },
  generated_sidecars: {
    status: "clean",
    files: ["AGENT.md", "SOUL.md", "README.md"],
  },
  render: render(state.profileVersion),
});

if (command === "inspect") {
  const state = readState();
  if (state.unsupported) {
    process.stderr.write("invalid choice: inspect");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ profiles: state.empty ? [] : [profile(state)] }));
  process.exit(0);
}

if (command === "validate") {
  const yaml = readFileSync(option("--file"), "utf8");
  process.stdout.write(
    JSON.stringify({
      ok: true,
      agent_id: "openminion",
      validation: { ok: true, errors: [], warnings: [] },
      render: { ...render(digest(yaml)), text: `Verified draft: ${yaml.trim()}` },
    }),
  );
  process.exit(0);
}

if (command === "apply") {
  const state = readState();
  if (
    option("--expected-profile-version") !== state.profileVersion ||
    option("--expected-source-sha256") !== state.sourceSha256
  ) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        code: "stale_profile_version",
        message: "Identity changed since these settings were loaded.",
        issues: [],
      }),
    );
    process.exit(1);
  }
  const yaml = readFileSync(option("--file"), "utf8");
  const next = {
    yaml,
    profileVersion: digest(`profile:${yaml}`),
    sourceSha256: digest(`source:${yaml}`),
  };
  writeFileSync(statePath, JSON.stringify(next));
  process.stdout.write(JSON.stringify(profile(next)));
  process.exit(0);
}

process.stderr.write("unsupported fixture command");
process.exit(2);
