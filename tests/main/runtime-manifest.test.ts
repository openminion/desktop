import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkRuntimeManifest,
  parseRuntimeFeed,
  parseRuntimeRecord,
  type RuntimeRecord,
  runtimeFeedUrl,
  runtimeOfferDigest,
} from "../../src/main/runtime-manifest.js";

const commit = "a".repeat(40);
const manifestUrl = (version = "1.0.0", id = "source.1") =>
  `https://raw.githubusercontent.com/openminion/openminion/${commit}/releases/runtime/v1/pypi/releases/${version}/${id}.json`;
const record = (version = "1.0.0"): RuntimeRecord => ({
  schema_version: 1,
  product: "openminion",
  distribution: "pypi",
  channel: "stable",
  promotion_status: "promoted",
  runtime_version: version,
  release_id: "source.1",
  published_at: "2026-09-17T00:00:00Z",
  source_commit: commit,
  release_notes_url: `https://github.com/openminion/openminion/releases/tag/v${version}`,
  desktop_compatibility: { min_version: "0.0.0", max_version_exclusive: "2.0.0" },
  certification: {
    repository: "openminion/desktop",
    commit,
    path: `releases/runtime-certification/v1/qualification/${version}/desktop-test.json`,
    sha256: "d".repeat(64),
  },
  pypi: {
    package: "openminion",
    version,
    requires_python: ">=3.11",
    url: `https://files.pythonhosted.org/packages/openminion-${version}-py3-none-any.whl`,
    filename: `openminion-${version}-py3-none-any.whl`,
    sha256: "b".repeat(64),
    size_bytes: 123,
  },
});
const feed = (releases: unknown[] = []) => ({
  schema_version: 1,
  product: "openminion",
  distribution: "pypi",
  channel: "stable",
  published_at: "2026-09-17T00:00:00Z",
  releases,
});
const reference = (item: RuntimeRecord, id = item.release_id) => ({
  runtime_version: item.runtime_version,
  manifest_url: manifestUrl(item.runtime_version, id),
  manifest_sha256: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
});
const options = { source: "pypi" as const, desktopVersion: "0.0.0", installedVersion: "0.0.19" };

const binaryRecord = (artifact: Record<string, unknown>): RuntimeRecord => {
  const { pypi, certification, ...common } = record();
  expect(pypi).toBeDefined();
  expect(certification).toBeDefined();
  return {
    ...common,
    distribution: "binary",
    artifacts: [artifact],
  } as RuntimeRecord;
};

const binaryArtifact = (change: Record<string, unknown> = {}) => ({
  platform: "linux",
  arch: "x64",
  format: "executables",
  min_os_version: "6.8.0",
  verification_id: "native.1",
  libc_family: "glibc",
  min_libc_version: "2.35",
  cli: {
    filename: "openminion-linux-x86_64",
    size_bytes: 123,
    sha256: "a".repeat(64),
    url: "https://github.com/openminion/runtime/releases/download/runtime-v1.0.0-build.1/openminion-linux-x86_64",
  },
  daemon: {
    filename: "openminiond-linux-x86_64",
    size_bytes: 124,
    sha256: "b".repeat(64),
    url: "https://github.com/openminion/runtime/releases/download/runtime-v1.0.0-build.1/openminiond-linux-x86_64",
  },
  ...change,
});

afterEach(() => vi.unstubAllGlobals());

describe("runtime manifest boundary", () => {
  it("uses only the agreed public feed path", () => {
    expect(runtimeFeedUrl("pypi")).toBe(
      "https://raw.githubusercontent.com/openminion/openminion/main/releases/runtime/v1/pypi/channels/stable.json",
    );
  });
  it("accepts uncertified source metadata without inventing bounds", () => {
    const item = { ...record(), desktop_compatibility: null, certification: undefined };
    expect(parseRuntimeRecord(item, "pypi").desktop_compatibility).toBeNull();
  });
  it.each([
    { schema_version: 2 },
    { product: "pyclaw" },
    { promotion_status: "candidate" },
    { source_commit: "main" },
    { runtime_version: "1.0.0rc1" },
    { desktop_compatibility: { min_version: "2.0.0", max_version_exclusive: "1.0.0" } },
    { artifacts: [] },
  ])("rejects invalid identity or compatibility %j", (change) => {
    expect(() => parseRuntimeRecord({ ...record(), ...change }, "pypi")).toThrow();
  });
  it.each([
    { sha256: "invalid" },
    { size_bytes: 0 },
    { size_bytes: true },
    { url: "https://evil.example/runtime.whl" },
    { version: "0.0.19" },
  ])("rejects wheel identity %j", (change) => {
    const item = record();
    expect(() =>
      parseRuntimeRecord({ ...item, pypi: { ...item.pypi, ...change } }, "pypi"),
    ).toThrow();
  });
  it("rejects mutable record URLs, duplicate references and oversized feeds", () => {
    const item = reference(record());
    expect(() =>
      parseRuntimeFeed(
        feed([{ ...item, manifest_url: item.manifest_url.replace(commit, "main") }]),
        "pypi",
      ),
    ).toThrow();
    expect(() => parseRuntimeFeed(feed([item, item]), "pypi")).toThrow();
    expect(() => parseRuntimeFeed(feed(Array(101).fill(item)), "pypi")).toThrow();
  });
  it.each(["1.0.0rc1", "1.0.0.dev1", "1.0.0+local", "01.0.0"])(
    "rejects non-production versions even with matching wheel identity (%s)",
    (version) => {
      expect(() => parseRuntimeRecord(record(version), "pypi")).toThrow("manifest_version_invalid");
    },
  );
  it("validates binary targets without certifying them as native releases", () => {
    const source = record();
    const { pypi, certification, ...common } = source;
    const artifact = {
      platform: "win32",
      arch: "x64",
      format: "executables",
      min_os_version: "10",
      verification_id: "native.1",
      cli: {
        filename: "openminion.exe",
        size_bytes: 123,
        sha256: "a".repeat(64),
        url: "https://github.com/openminion/runtime/releases/download/runtime-v1.0.0-build.1/openminion.exe",
      },
      daemon: {
        filename: "openminiond.exe",
        size_bytes: 124,
        sha256: "b".repeat(64),
        url: "https://github.com/openminion/runtime/releases/download/runtime-v1.0.0-build.1/openminiond.exe",
      },
    };
    const binary = { ...common, distribution: "binary", artifacts: [artifact] };
    const parsed = parseRuntimeRecord(binary, "binary");
    expect(parsed.artifacts).toHaveLength(1);
    const selected = parsed.artifacts![0];
    const firstIdentity = runtimeOfferDigest({
      record: parsed,
      reference: reference(source),
      artifact: selected,
    });
    expect(
      runtimeOfferDigest({
        record: parsed,
        reference: reference(source),
        artifact: { ...selected, daemon: { ...selected.daemon, sha256: "c".repeat(64) } },
      }),
    ).not.toBe(firstIdentity);
    expect(pypi).toBeDefined();
    expect(certification).toBeDefined();
    for (const change of [
      { artifacts: [artifact, artifact] },
      { artifacts: [{ ...artifact, arch: "arm64" }] },
      { artifacts: [{ ...artifact, min_os_version: "Windows 11" }] },
      { artifacts: [{ ...artifact, verification_id: undefined }] },
      { artifacts: [{ ...artifact, daemon: { ...artifact.daemon, sha256: "invalid" } }] },
      { desktop_compatibility: null },
      { promotion_status: "candidate" },
    ]) {
      expect(() => parseRuntimeRecord({ ...binary, ...change }, "binary")).toThrow();
    }
  });
});

describe("runtime selection", () => {
  it("honors exact version, immutable record and artifact pins without falling back", async () => {
    const pinned = record("1.0.0");
    const newest = record("2.0.0");
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === runtimeFeedUrl("pypi") ? feed([reference(newest), reference(pinned)]) : pinned,
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const pin = {
      source: "pypi" as const,
      version: pinned.runtime_version,
      manifestUrl: manifestUrl(),
      sha256: pinned.pypi!.sha256,
    };
    expect((await checkRuntimeManifest({ ...options, pin }))?.record.runtime_version).toBe("1.0.0");
    expect(fetch).not.toHaveBeenCalledWith(manifestUrl("2.0.0"), expect.anything());
    expect(
      await checkRuntimeManifest({
        ...options,
        pin: { ...pin, manifestUrl: manifestUrl("1.0.0", "withdrawn") },
      }),
    ).toBeNull();
    expect(
      await checkRuntimeManifest({ ...options, pin: { ...pin, sha256: "c".repeat(64) } }),
    ).toBeNull();
    expect(
      await checkRuntimeManifest({ ...options, targetVersion: "3.0.0", includeInstalled: true }),
    ).toBeNull();
    expect(
      await checkRuntimeManifest({
        ...options,
        installedVersion: "2.0.0",
        targetVersion: "1.0.0",
        includeInstalled: true,
      }),
    ).toBeNull();
    expect(
      (
        await checkRuntimeManifest({
          ...options,
          installedVersion: "1.0.0",
          targetVersion: "1.0.0",
          includeInstalled: true,
        })
      )?.record.runtime_version,
    ).toBe("1.0.0");
  });

  it("never lets a pin certify an incompatible record", async () => {
    const item = { ...record(), desktop_compatibility: null, certification: undefined };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(url === runtimeFeedUrl("pypi") ? feed([reference(item)]) : item),
          ),
      ),
    );
    expect(
      await checkRuntimeManifest({ ...options, targetVersion: "1.0.0", includeInstalled: true }),
    ).toBeNull();
  });
  it("orders Python versions numerically, not lexically", async () => {
    const old = record("1.9.0");
    const latest = record("1.10.0");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url === runtimeFeedUrl("pypi") ? feed([reference(old), reference(latest)]) : latest,
            ),
          ),
      ),
    );
    expect((await checkRuntimeManifest(options))?.record.runtime_version).toBe("1.10.0");
  });
  it("skips uncertified records and selects the first eligible equal-version revision", async () => {
    const uncertified = {
      ...record(),
      desktop_compatibility: null,
      certification: undefined,
    };
    const certified = { ...record(), release_id: "source.2" };
    const second = { ...record(), release_id: "source.3" };
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === runtimeFeedUrl("pypi")
              ? feed([reference(uncertified), reference(certified), reference(second)])
              : url.endsWith("source.1.json")
                ? uncertified
                : certified,
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await checkRuntimeManifest(options))?.record.release_id).toBe("source.2");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not reinstall for metadata-only revisions or legacy unknown digests", async () => {
    const item = record("0.0.19");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(url === runtimeFeedUrl("pypi") ? feed([reference(item)]) : item),
          ),
      ),
    );
    expect(
      await checkRuntimeManifest({ ...options, installedDigest: item.pypi!.sha256 }),
    ).toBeNull();
    expect(await checkRuntimeManifest(options)).toBeNull();
  });
  it("does not downgrade or fall back to a different distribution", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(feed([reference(record("0.0.18"))]))),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await checkRuntimeManifest(options)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("selects binary artifacts only for a compatible OS and libc runtime", async () => {
    const item = binaryRecord(binaryArtifact());
    const binaryFeed = {
      ...feed([reference(item)]),
      distribution: "binary",
      releases: [
        {
          ...reference(item),
          manifest_url: manifestUrl().replace("/pypi/", "/binary/"),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.includes("channels") ? binaryFeed : item)),
      ),
    );
    const binaryOptions = {
      ...options,
      source: "binary" as const,
      platform: "linux" as const,
      arch: "x64",
      osVersion: "6.8.12",
      libcFamily: "glibc",
      libcVersion: "2.39",
    };
    expect((await checkRuntimeManifest(binaryOptions))?.artifact).toMatchObject({
      platform: "linux",
      arch: "x64",
    });
    for (const change of [
      { osVersion: "6.7.9" },
      { osVersion: "unknown" },
      { libcFamily: "musl" },
      { libcVersion: "2.34" },
      { libcVersion: "unknown" },
    ]) {
      expect(await checkRuntimeManifest({ ...binaryOptions, ...change })).toBeNull();
    }
  });
  it("rejects served bytes that differ from the declared record digest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url === runtimeFeedUrl("pypi")
                ? feed([reference(record())])
                : { ...record(), release_id: "tampered" },
            ),
          ),
      ),
    );
    await expect(checkRuntimeManifest(options)).rejects.toThrow("manifest_integrity_mismatch");
  });
  it("rejects feed/record version mismatch even when the digest matches", async () => {
    const item = record();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url === runtimeFeedUrl("pypi")
                ? feed([{ ...reference(item), runtime_version: "2.0.0" }])
                : item,
            ),
          ),
      ),
    );
    await expect(checkRuntimeManifest(options)).rejects.toThrow("manifest_version_mismatch");
  });
  it("leaves a failed network check as a check failure, never an install", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    await expect(checkRuntimeManifest(options)).rejects.toThrow("manifest_unavailable");
  });
  it("rejects unbounded JSON bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1))),
    );
    await expect(checkRuntimeManifest(options)).rejects.toThrow("manifest_too_large");
  });
});
