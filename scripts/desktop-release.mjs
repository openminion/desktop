// Validate the public unsigned package record before publishing a Desktop source release.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseChecksums(content) {
  const checksums = new Map();
  for (const line of content.toString().trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    assert.ok(match, `Invalid checksum line: ${line}`);
    assert.equal(checksums.has(match[2]), false, `Duplicate checksum: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

export function validateDevelopmentRelease({
  manifest,
  packageMetadata,
  runtimeRelease,
  checksumsContent,
  manifestContent,
  sourceCommit,
  runtimeReleaseTag,
}) {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.product, "openminion-desktop");
  assert.equal(manifest.distribution, "binary");
  assert.equal(manifest.channel, "development");
  assert.match(manifest.version ?? "", versionPattern);
  assert.notEqual(manifest.version, "0.0.0");
  assert.equal(packageMetadata.private, true);
  assert.equal(packageMetadata.version, manifest.version);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(
    runtimeReleaseTag,
    new RegExp(`^desktop-dev-v${manifest.version.replaceAll(".", "\\.")}-build\\.\\d+$`),
  );
  assert.equal(manifest.release_id, runtimeReleaseTag);
  assert.equal(manifest.source_commit, sourceCommit);
  assert.match(
    manifest.build_run ?? "",
    /^https:\/\/github\.com\/openminion\/desktop\/actions\/runs\/\d+$/,
  );
  assert.equal(manifest.signed, false);
  assert.equal(manifest.notarized, false);
  assert.equal(manifest.clean_machine_certified, false);
  assert.equal(manifest.automatic_update_eligible, false);

  assert.equal(runtimeRelease.tagName, runtimeReleaseTag);
  assert.equal(runtimeRelease.isDraft, false);
  assert.equal(runtimeRelease.isPrerelease, true);
  assert.ok(runtimeRelease.url?.startsWith("https://github.com/openminion/runtime/releases/tag/"));
  assert.doesNotThrow(() => new Date(runtimeRelease.publishedAt).toISOString());

  const checksums = parseChecksums(checksumsContent);
  assert.equal(checksums.get("desktop-release.json"), sha256(manifestContent));

  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
  const releaseAssets = new Map(runtimeRelease.assets.map((asset) => [asset.name, asset]));
  const filenames = new Set();
  for (const artifact of manifest.artifacts) {
    assert.equal(
      filenames.has(artifact.filename),
      false,
      `Duplicate artifact: ${artifact.filename}`,
    );
    filenames.add(artifact.filename);
    assert.match(artifact.sha256 ?? "", sha256Pattern);
    assert.ok(Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 0);
    assert.equal(checksums.get(artifact.filename), artifact.sha256);
    const asset = releaseAssets.get(artifact.filename);
    assert.ok(asset, `Missing runtime asset: ${artifact.filename}`);
    assert.equal(asset.size, artifact.size_bytes);
    assert.equal(asset.digest, `sha256:${artifact.sha256}`);
  }

  for (const [filename, content] of [
    ["desktop-release.json", manifestContent],
    ["SHA256SUMS", checksumsContent],
  ]) {
    const asset = releaseAssets.get(filename);
    assert.ok(asset, `Missing runtime asset: ${filename}`);
    assert.equal(asset.digest, `sha256:${sha256(content)}`);
  }

  return {
    version: manifest.version,
    tag: `v${manifest.version}`,
    sourceCommit,
    runtimeReleaseTag,
    runtimeReleaseUrl: runtimeRelease.url,
    buildRun: manifest.build_run,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, packagePath, runtimeReleasePath, checksumsPath, sourceCommit, tag] =
    process.argv.slice(2);
  assert.ok(
    manifestPath && packagePath && runtimeReleasePath && checksumsPath && sourceCommit && tag,
    "Usage: desktop-release.mjs MANIFEST PACKAGE RELEASE CHECKSUMS SOURCE_COMMIT RUNTIME_TAG",
  );
  const [manifestContent, packageContent, releaseContent, checksumsContent] = await Promise.all(
    [manifestPath, packagePath, runtimeReleasePath, checksumsPath].map((path) => readFile(path)),
  );
  const result = validateDevelopmentRelease({
    manifest: JSON.parse(manifestContent),
    packageMetadata: JSON.parse(packageContent),
    runtimeRelease: JSON.parse(releaseContent),
    checksumsContent,
    manifestContent,
    sourceCommit,
    runtimeReleaseTag: tag,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
