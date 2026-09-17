import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopStore } from "../../src/main/desktop-store.js";
import {
  OpenMinionInstallation,
  runCommand,
  type RunCommand,
} from "../../src/main/installation.js";
import type { RuntimeOffer } from "../../src/main/runtime-manifest.js";

const roots: string[] = [];
const stores: DesktopStore[] = [];
const wheel = Buffer.from("verified wheel bytes");

it("blocks paused or wrong-identity candidates before downloading or invoking Python", async () => {
  const { root, store } = await fixture();
  const download = vi.fn();
  vi.stubGlobal("fetch", download);
  const command = vi.fn<RunCommand>();
  const installer = new OpenMinionInstallation({
    runtimeRoot: join(root, "runtime"),
    store,
    runCommand: command,
  });
  store.setRuntimePolicy(true, null);
  await expect(installer.stage(offer())).rejects.toThrow("runtime_updates_paused");
  store.setRuntimePolicy(false, {
    source: "pypi",
    version: "1.0.0",
    manifestUrl: "other-record",
    sha256: offer().artifact.sha256,
  });
  await expect(installer.stage(offer())).rejects.toThrow("runtime_pin_mismatch");
  expect(download).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

it("cancels a blocked download without invoking Python or writing pending state", async () => {
  const { root, store } = await fixture();
  const controller = new AbortController();
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const command = vi.fn<RunCommand>();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
          started();
        }),
    ),
  );
  const staging = new OpenMinionInstallation({
    runtimeRoot: join(root, "runtime"),
    store,
    runCommand: command,
  }).stage(offer(), controller.signal);
  const rejected = expect(staging).rejects.toThrow();
  await downloading;
  controller.abort();
  await rejected;
  expect(command).not.toHaveBeenCalled();
  expect(store.runtimeState().pending).toBeNull();
});

it("cancels installer subprocesses and fences a late version result from the store", async () => {
  const { root, store } = await fixture();
  const controller = new AbortController();
  let executable = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(wheel)),
  );
  const command = vi.fn<RunCommand>(async (_path, args, _timeout, _environment, signal) => {
    expect(signal).toBe(controller.signal);
    if (args.includes("venv")) {
      executable = join(args.at(-1)!, "bin/openminion");
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, "");
    }
    if (args[0] === "--version") controller.abort();
    return { exitCode: 0, stdout: "1.0.0", stderr: "" };
  });
  await expect(
    new OpenMinionInstallation({
      runtimeRoot: join(root, "runtime"),
      store,
      runCommand: command,
    }).stage(offer(), controller.signal),
  ).rejects.toThrow();
  expect(store.runtimeState().pending).toBeNull();
  const processController = new AbortController();
  const child = runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    30_000,
    undefined,
    processController.signal,
  );
  processController.abort();
  expect((await child).exitCode).not.toBe(0);
});
function offer(): RuntimeOffer {
  const artifact = {
    url: "https://files.pythonhosted.org/packages/openminion-1.0.0-py3-none-any.whl",
    filename: "openminion-1.0.0-py3-none-any.whl",
    size_bytes: wheel.length,
    sha256: createHash("sha256").update(wheel).digest("hex"),
  };
  return {
    artifact,
    reference: {
      runtime_version: "1.0.0",
      manifest_url: "immutable",
      manifest_sha256: "a".repeat(64),
    },
    record: {
      schema_version: 1,
      product: "openminion",
      distribution: "pypi",
      channel: "stable",
      promotion_status: "promoted",
      runtime_version: "1.0.0",
      release_id: "source.1",
      published_at: "2026-09-17T00:00:00Z",
      source_commit: "a".repeat(40),
      release_notes_url: "https://github.com/openminion/openminion/releases/tag/v1.0.0",
      desktop_compatibility: { min_version: "0.0.0", max_version_exclusive: "2.0.0" },
      pypi: { ...artifact, package: "openminion", version: "1.0.0", requires_python: ">=3.11" },
    },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-installation-"));
  roots.push(root);
  const store = new DesktopStore(root);
  stores.push(store);
  return { root, store };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("verifies the wheel before installing into a separate environment and leaves activation pending", async () => {
  const { root, store } = await fixture();
  let executable = "";
  const command = vi.fn<RunCommand>(async (path, args, _timeout, environment) => {
    if (path === "python3.11") {
      executable = join(args.at(-1)!, "bin/openminion");
      await mkdir(dirname(executable), { recursive: true });
    } else if (args.includes("pip")) {
      expect(args.at(-1)).toMatch(/openminion-1\.0\.0-py3-none-any\.whl$/);
      expect(await readFile(args.at(-1)!)).toEqual(wheel);
      await writeFile(executable, "");
    } else {
      expect(args).toEqual(["--version"]);
      expect(environment?.OPENMINION_HOME).not.toBe(root);
      return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(wheel)),
  );
  const candidate = await new OpenMinionInstallation({
    runtimeRoot: join(root, "runtime"),
    store,
    platform: "darwin",
    runCommand: command,
  }).stage(offer());
  expect(candidate.executable).toContain("/runtime/staged/");
  expect(store.runtimeState()).toMatchObject({
    active: null,
    pending: candidate,
    launchIntent: null,
  });
  expect(
    command.mock.calls.some(([, args]) => args.includes("daemon") || args.includes("config")),
  ).toBe(false);
});

it.each([Buffer.from("corrupted"), wheel.subarray(0, 5), Buffer.concat([wheel, wheel])])(
  "does not invoke Python or pip on integrity failure",
  async (bytes) => {
    const { root, store } = await fixture();
    const command = vi.fn<RunCommand>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    await expect(
      new OpenMinionInstallation({
        runtimeRoot: join(root, "runtime"),
        store,
        runCommand: command,
      }).stage(offer()),
    ).rejects.toThrow("runtime_integrity_mismatch");
    expect(command).not.toHaveBeenCalled();
    expect(store.runtimeState()).toMatchObject({ active: null, pending: null, launchIntent: null });
  },
);

it("preserves unmanaged installations without any download", async () => {
  const { root, store } = await fixture();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    new OpenMinionInstallation({ openminionExecutable: join(root, "developer"), store }).stage(
      offer(),
    ),
  ).rejects.toThrow("runtime_unmanaged");
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses binary prototypes instead of silently installing from PyPI", async () => {
  const { root, store } = await fixture();
  const item = offer();
  item.record.distribution = "binary";
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    new OpenMinionInstallation({ runtimeRoot: join(root, "runtime"), store }).stage(item),
  ).rejects.toThrow("binary_runtime_not_qualified");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps a successfully activated manifest installation instead of reinstalling the packaged pin", async () => {
  const { root, store } = await fixture();
  const executable = join(root, "staged-openminion");
  await writeFile(executable, "");
  store.stageRuntime({
    source: "pypi",
    version: "1.0.0",
    executable,
    sha256: "a".repeat(64),
    manifestUrl: "immutable",
    desktopMinVersion: "0.0.0",
    desktopMaxVersionExclusive: "2.0.0",
  });
  store.beginRuntimeLaunch();
  store.completeRuntimeLaunch();
  const command = vi.fn<RunCommand>(async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }));
  expect(
    await new OpenMinionInstallation({
      runtimeRoot: join(root, "runtime"),
      store,
      runCommand: command,
    }).ensure(),
  ).toEqual({ path: executable, version: "1.0.0" });
  expect(command).toHaveBeenCalledExactlyOnceWith(executable, ["--version"], 30_000);
});
