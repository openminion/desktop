import { describe, expect, it } from "vitest";
import { mergeQualification } from "../../scripts/runtime-qualification.mjs";

const identities = [
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["win32", "x64"],
];

function fragments() {
  return identities.map(([platform, arch], index) => ({
    schema_version: 1,
    kind: "openminion-binary-runtime-target-qualification",
    runtime: { version: "1.2.3", release_tag: "runtime-v1.2.3-build.1" },
    desktop: { version: "0.1.0", source_commit: "a".repeat(40) },
    compatibility: { min_version: "0.1.0", max_version_exclusive: "0.2.0" },
    target: {
      platform,
      arch,
      package_sha256: "a".repeat(64),
      app_asar_sha256: "b".repeat(64),
      cli_sha256: "c".repeat(64),
      daemon_sha256: "d".repeat(64),
      verification_id: `${platform}-${arch}-1`,
      result: "passed",
      checks: [
        "native_trust",
        "old_runtime_reply",
        "owned_daemon_shutdown",
        "packaged_startup",
        "prepare_update",
        "runtime_integrity",
        "same_chat_reply",
        "startup_activation",
      ],
    },
    completed_at: `2026-10-01T00:00:0${index}Z`,
  }));
}

describe("runtime qualification evidence", () => {
  it("merges every exact packaged target", () => {
    const result = mergeQualification(fragments());
    expect(result.kind).toBe("openminion-binary-runtime-qualification");
    expect(result.targets.map((target) => `${target.platform}-${target.arch}`)).toEqual([
      "darwin-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    expect(result.completed_at).toBe("2026-10-01T00:00:02Z");
  });

  it("rejects mixed release identities", () => {
    const input = fragments();
    input[1].runtime.version = "1.2.4";
    expect(() => mergeQualification(input)).toThrow("identities differ");
  });

  it("rejects missing or duplicate targets", () => {
    const input = fragments();
    input[2].target = { ...input[1].target };
    expect(() => mergeQualification(input)).toThrow("Duplicate qualification target");
  });
});
