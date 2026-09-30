import { createHash } from "node:crypto";
import { clean, compare, parse, satisfies, valid, validRange } from "@renovatebot/pep440";
import type { RuntimePin } from "../shared/contracts.js";

export type RuntimeSource = "pypi" | "binary";
export type RuntimeArtifact = {
  url: string;
  filename: string;
  sha256: string;
  size_bytes: number;
};
export type BinaryArtifact = {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  format: "executables";
  min_os_version: string;
  verification_id: string;
  cli: RuntimeArtifact;
  daemon: RuntimeArtifact;
  libc_family?: string;
  min_libc_version?: string;
};
export type RuntimeRecord = {
  schema_version: 1;
  product: "openminion";
  distribution: RuntimeSource;
  channel: "stable";
  promotion_status: "promoted";
  runtime_version: string;
  release_id: string;
  published_at: string;
  source_commit: string;
  release_notes_url: string;
  desktop_compatibility: { min_version: string; max_version_exclusive: string } | null;
  certification?: {
    repository: "openminion/desktop";
    commit: string;
    path: string;
    sha256: string;
  };
  pypi?: RuntimeArtifact & { package: "openminion"; version: string; requires_python: string };
  artifacts?: BinaryArtifact[];
};
export type RuntimeReference = {
  runtime_version: string;
  manifest_url: string;
  manifest_sha256: string;
};
export type RuntimeFeed = {
  schema_version: 1;
  product: "openminion";
  distribution: RuntimeSource;
  channel: "stable";
  published_at: string;
  releases: RuntimeReference[];
};
export type RuntimeOffer = {
  record: RuntimeRecord;
  reference: RuntimeReference;
  artifact: RuntimeArtifact | BinaryArtifact;
};

export function runtimeOfferDigest(offer: RuntimeOffer): string {
  if (offer.record.distribution !== "binary") return (offer.artifact as RuntimeArtifact).sha256;
  const artifact = offer.artifact as BinaryArtifact;
  return createHash("sha256")
    .update(`cli:${artifact.cli.sha256}\ndaemon:${artifact.daemon.sha256}\n`)
    .digest("hex");
}

const origin = "https://raw.githubusercontent.com/openminion/openminion";
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const jsonLimit = 1024 * 1024;

export function runtimeFeedUrl(source: RuntimeSource): string {
  return `${origin}/main/releases/runtime/v1/${source}/channels/stable.json`;
}

export function desktopCompatible(version: string, min: string, max: string): boolean {
  return compare(version, min) >= 0 && compare(version, max) < 0;
}

function numericVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  return value.split(".").map(Number);
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = numericVersion(current);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function systemVersion(): string {
  return process.getSystemVersion().match(/\d+(?:\.\d+)*/)?.[0] ?? "";
}

function glibcVersion(): string | undefined {
  const report = process.report?.getReport();
  return typeof report === "object" &&
    report !== null &&
    "header" in report &&
    typeof report.header === "object" &&
    report.header !== null &&
    "glibcVersionRuntime" in report.header &&
    typeof report.header.glibcVersionRuntime === "string"
    ? report.header.glibcVersionRuntime
    : undefined;
}

function hostCompatible(
  artifact: BinaryArtifact,
  options: { osVersion?: string; libcFamily?: string; libcVersion?: string },
): boolean {
  if (!versionAtLeast(options.osVersion ?? systemVersion(), artifact.min_os_version)) return false;
  if (artifact.platform !== "linux") return true;
  const detectedGlibc = glibcVersion();
  const family = options.libcFamily ?? (detectedGlibc ? "glibc" : undefined);
  const version = options.libcVersion ?? detectedGlibc;
  return (
    family === artifact.libc_family &&
    typeof version === "string" &&
    versionAtLeast(version, artifact.min_libc_version ?? "")
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("manifest_invalid");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("manifest_invalid");
  return value;
}

function identity(value: Record<string, unknown>, source: RuntimeSource): void {
  if (
    value.schema_version !== 1 ||
    value.product !== "openminion" ||
    value.distribution !== source ||
    value.channel !== "stable" ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(text(value.published_at)) ||
    !Number.isFinite(Date.parse(text(value.published_at)))
  )
    throw new Error("manifest_invalid");
}

function stableVersion(value: unknown): string {
  const version = text(value);
  const parsed = parse(version);
  if (
    !parsed ||
    !valid(version) ||
    clean(version) !== version ||
    parsed.pre != null ||
    parsed.dev != null ||
    parsed.local
  ) {
    throw new Error("manifest_version_invalid");
  }
  return version;
}

export function parseRuntimeFeed(value: unknown, source: RuntimeSource): RuntimeFeed {
  const feed = object(value);
  identity(feed, source);
  if (!Array.isArray(feed.releases) || feed.releases.length > 100)
    throw new Error("manifest_invalid");
  const seen = new Set<string>();
  for (const item of feed.releases) {
    const reference = object(item);
    stableVersion(reference.runtime_version);
    const url = text(reference.manifest_url);
    const parsed = new URL(url);
    const path = new RegExp(
      `^/openminion/openminion/[a-f0-9]{40}/releases/runtime/v1/${source}/releases/[^/]+/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json$`,
    );
    if (
      parsed.origin !== "https://raw.githubusercontent.com" ||
      !path.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      url !== parsed.href ||
      !digestPattern.test(text(reference.manifest_sha256)) ||
      seen.has(url)
    ) {
      throw new Error("manifest_reference_invalid");
    }
    seen.add(url);
  }
  return feed as unknown as RuntimeFeed;
}

function artifact(value: unknown, source: RuntimeSource): RuntimeArtifact {
  const item = object(value);
  const url = new URL(text(item.url));
  const filename = text(item.filename);
  if (
    !digestPattern.test(text(item.sha256)) ||
    !Number.isSafeInteger(item.size_bytes) ||
    (item.size_bytes as number) <= 0 ||
    (item.size_bytes as number) > 1024 ** 3 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) ||
    url.search ||
    url.hash ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    decodeURIComponent(url.pathname.split("/").pop() ?? "") !== filename ||
    (source === "pypi"
      ? url.host !== "files.pythonhosted.org"
      : url.host !== "github.com" ||
        !url.pathname.startsWith("/openminion/runtime/releases/download/runtime-v"))
  ) {
    throw new Error("manifest_artifact_invalid");
  }
  return item as unknown as RuntimeArtifact;
}

export function parseRuntimeRecord(value: unknown, source: RuntimeSource): RuntimeRecord {
  const record = object(value);
  identity(record, source);
  const version = stableVersion(record.runtime_version);
  if (
    record.promotion_status !== "promoted" ||
    !commitPattern.test(text(record.source_commit)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text(record.release_id))
  )
    throw new Error("manifest_invalid");
  const notes = new URL(text(record.release_notes_url));
  if (
    notes.origin !== "https://github.com" ||
    !notes.pathname.startsWith("/openminion/openminion/releases/") ||
    notes.search ||
    notes.hash
  )
    throw new Error("manifest_invalid");
  if (record.desktop_compatibility !== null) {
    const bounds = object(record.desktop_compatibility);
    for (const bound of [bounds.min_version, bounds.max_version_exclusive]) {
      if (!/^\d+\.\d+\.\d+$/.test(text(bound))) throw new Error("manifest_compatibility_invalid");
    }
    if (compare(text(bounds.min_version), text(bounds.max_version_exclusive)) >= 0)
      throw new Error("manifest_compatibility_invalid");
  }
  if (source === "pypi") {
    const wheel = object(record.pypi);
    artifact(wheel, source);
    if (
      record.artifacts !== undefined ||
      wheel.package !== "openminion" ||
      wheel.version !== version ||
      wheel.filename !== `openminion-${version}-py3-none-any.whl`
    )
      throw new Error("manifest_invalid");
    if (!validRange(text(wheel.requires_python))) throw new Error("manifest_python_invalid");
    if (record.desktop_compatibility === null) {
      if (record.certification !== undefined) throw new Error("manifest_certification_invalid");
    } else {
      const certification = object(record.certification);
      const path = text(certification.path);
      if (
        certification.repository !== "openminion/desktop" ||
        !commitPattern.test(text(certification.commit)) ||
        !digestPattern.test(text(certification.sha256)) ||
        !new RegExp(
          `^releases/runtime-certification/v1/qualification/${version}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.json$`,
        ).test(path)
      )
        throw new Error("manifest_certification_invalid");
    }
  } else {
    if (
      record.pypi !== undefined ||
      record.certification !== undefined ||
      record.desktop_compatibility === null ||
      !Array.isArray(record.artifacts) ||
      !record.artifacts.length ||
      record.artifacts.length > 3
    )
      throw new Error("manifest_invalid");
    const seen = new Set<string>();
    for (const value of record.artifacts) {
      const item = object(value);
      const target = `${text(item.platform)}-${text(item.arch)}`;
      if (
        !["darwin-arm64", "linux-x64", "win32-x64"].includes(target) ||
        seen.has(target) ||
        item.format !== "executables"
      )
        throw new Error("manifest_target_invalid");
      artifact(item.cli, source);
      artifact(item.daemon, source);
      if (!numericVersion(text(item.min_os_version))) throw new Error("manifest_target_invalid");
      text(item.verification_id);
      if (item.platform === "linux") {
        if (item.libc_family !== "glibc") throw new Error("manifest_target_invalid");
        if (!numericVersion(text(item.min_libc_version)))
          throw new Error("manifest_target_invalid");
      }
      seen.add(target);
    }
  }
  return record as unknown as RuntimeRecord;
}

async function metadataBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok || !response.body) throw new Error("manifest_unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > jsonLimit) {
      throw new Error("manifest_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function checkRuntimeManifest(options: {
  source: RuntimeSource;
  desktopVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  osVersion?: string;
  libcFamily?: string;
  libcVersion?: string;
  installedVersion: string;
  installedDigest?: string;
  pin?: RuntimePin | null;
  targetVersion?: string;
  includeInstalled?: boolean;
  signal?: AbortSignal;
}): Promise<RuntimeOffer | null> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const feed = parseRuntimeFeed(
    JSON.parse(
      Buffer.from(await metadataBytes(runtimeFeedUrl(options.source), signal)).toString("utf8"),
    ),
    options.source,
  );
  const references = [...feed.releases].sort((left, right) =>
    compare(right.runtime_version, left.runtime_version),
  );
  for (const reference of references) {
    if (options.targetVersion && reference.runtime_version !== options.targetVersion) continue;
    if (
      options.pin &&
      (reference.runtime_version !== options.pin.version ||
        reference.manifest_url !== options.pin.manifestUrl ||
        options.source !== options.pin.source)
    )
      continue;
    if (compare(reference.runtime_version, options.installedVersion) < 0) continue;
    const bytes = await metadataBytes(reference.manifest_url, signal);
    if (createHash("sha256").update(bytes).digest("hex") !== reference.manifest_sha256)
      throw new Error("manifest_integrity_mismatch");
    const record = parseRuntimeRecord(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
      options.source,
    );
    if (record.runtime_version !== reference.runtime_version)
      throw new Error("manifest_version_mismatch");
    if (
      !reference.manifest_url.endsWith(
        `/releases/${record.runtime_version}/${record.release_id}.json`,
      )
    )
      throw new Error("manifest_reference_invalid");
    const bounds = record.desktop_compatibility;
    if (
      !bounds ||
      compare(options.desktopVersion, bounds.min_version) < 0 ||
      compare(options.desktopVersion, bounds.max_version_exclusive) >= 0
    )
      continue;
    if (record.pypi && !satisfies("3.11.0", record.pypi.requires_python)) continue;
    const selected =
      options.source === "pypi"
        ? record.pypi
        : record.artifacts?.find(
            (item) =>
              item.platform === (options.platform ?? process.platform) &&
              item.arch === (options.arch ?? process.arch) &&
              hostCompatible(item, options),
          );
    if (!selected) continue;
    const selectedDigest = runtimeOfferDigest({ record, reference, artifact: selected });
    if (options.pin && selectedDigest !== options.pin.sha256) continue;
    if (
      compare(record.runtime_version, options.installedVersion) === 0 &&
      !options.includeInstalled &&
      (!options.installedDigest || selectedDigest === options.installedDigest)
    )
      return null;
    return { record, reference, artifact: selected };
  }
  return null;
}
