// Merge exact packaged-Desktop target results into one commit-ready qualification record.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const targets = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);
const checks = new Set([
  "native_trust",
  "old_runtime_reply",
  "owned_daemon_shutdown",
  "packaged_startup",
  "prepare_update",
  "runtime_integrity",
  "same_chat_reply",
  "startup_activation",
]);

export function mergeQualification(fragments) {
  assert.equal(fragments.length, targets.size, "Qualification requires every target");
  const first = fragments[0];
  assert.equal(first.schema_version, 1);
  assert.equal(first.kind, "openminion-binary-runtime-target-qualification");
  const common = JSON.stringify({
    runtime: first.runtime,
    desktop: first.desktop,
    compatibility: first.compatibility,
  });
  const merged = new Map();
  for (const fragment of fragments) {
    assert.equal(fragment.schema_version, 1);
    assert.equal(fragment.kind, "openminion-binary-runtime-target-qualification");
    assert.equal(
      JSON.stringify({
        runtime: fragment.runtime,
        desktop: fragment.desktop,
        compatibility: fragment.compatibility,
      }),
      common,
      "Target qualification identities differ",
    );
    const target = fragment.target;
    const identity = `${target?.platform}-${target?.arch}`;
    assert.ok(targets.has(identity), `Unsupported qualification target: ${identity}`);
    assert.equal(merged.has(identity), false, `Duplicate qualification target: ${identity}`);
    assert.equal(target.result, "passed");
    assert.deepEqual(new Set(target.checks), checks);
    for (const field of ["package_sha256", "app_asar_sha256", "cli_sha256", "daemon_sha256"]) {
      assert.match(target[field] ?? "", /^[a-f0-9]{64}$/, `Invalid ${identity} ${field}`);
    }
    assert.match(target.verification_id ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.doesNotThrow(() => new Date(fragment.completed_at).toISOString());
    merged.set(identity, target);
  }
  assert.deepEqual(new Set(merged.keys()), targets);
  return {
    schema_version: 1,
    kind: "openminion-binary-runtime-qualification",
    runtime: first.runtime,
    desktop: first.desktop,
    compatibility: first.compatibility,
    targets: [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, target]) => target),
    completed_at: fragments
      .map((item) => item.completed_at)
      .sort()
      .at(-1),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, ...inputs] = process.argv.slice(2);
  assert.ok(output && inputs.length > 0, "Usage: runtime-qualification.mjs OUTPUT FRAGMENT...");
  const fragments = await Promise.all(
    inputs.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(mergeQualification(fragments), null, 2)}\n`, {
    mode: 0o600,
  });
}
