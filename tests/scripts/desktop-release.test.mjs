import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateDevelopmentRelease } from "../../scripts/desktop-release.mjs";

const sourceCommit = "a".repeat(40);
const artifactSha = "b".repeat(64);
const manifest = {
  schema_version: 1,
  product: "openminion-desktop",
  distribution: "binary",
  channel: "development",
  version: "0.0.2",
  release_id: "desktop-dev-v0.0.2-build.1",
  source_commit: sourceCommit,
  build_run: "https://github.com/openminion/desktop/actions/runs/1",
  signed: false,
  notarized: false,
  clean_machine_certified: false,
  automatic_update_eligible: false,
  artifacts: [{ filename: "OpenMinion.zip", sha256: artifactSha, size_bytes: 12 }],
};
const manifestContent = Buffer.from(`${JSON.stringify(manifest)}\n`);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function input() {
  const checksumsContent = Buffer.from(
    `${artifactSha}  OpenMinion.zip\n${sha256(manifestContent)}  desktop-release.json\n`,
  );
  return {
    manifest: structuredClone(manifest),
    packageMetadata: { private: true, version: "0.0.2" },
    runtimeRelease: {
      tagName: "desktop-dev-v0.0.2-build.1",
      isDraft: false,
      isPrerelease: true,
      publishedAt: "2026-10-26T00:00:00Z",
      url: "https://github.com/openminion/runtime/releases/tag/desktop-dev-v0.0.2-build.1",
      assets: [
        { name: "OpenMinion.zip", size: 12, digest: `sha256:${artifactSha}` },
        { name: "desktop-release.json", digest: `sha256:${sha256(manifestContent)}` },
        { name: "SHA256SUMS", digest: `sha256:${sha256(checksumsContent)}` },
      ],
    },
    checksumsContent,
    manifestContent,
    sourceCommit,
    runtimeReleaseTag: "desktop-dev-v0.0.2-build.1",
  };
}

describe("Desktop development release", () => {
  it("accepts matching source and public package identities", () => {
    expect(validateDevelopmentRelease(input())).toMatchObject({
      version: "0.0.2",
      tag: "v0.0.2",
      sourceCommit,
    });
  });

  it("rejects a package built from another Desktop commit", () => {
    const release = input();
    release.manifest.source_commit = "d".repeat(40);
    expect(() => validateDevelopmentRelease(release)).toThrow();
  });

  it("rejects a runtime asset whose digest differs", () => {
    const release = input();
    release.runtimeRelease.assets[0].digest = `sha256:${"e".repeat(64)}`;
    expect(() => validateDevelopmentRelease(release)).toThrow();
  });
});
