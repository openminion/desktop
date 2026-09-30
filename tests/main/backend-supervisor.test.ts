import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../../src/main/backend-supervisor.js";
import {
  OPENMINION_VERSION,
  type CommandResult,
  type RunCommand,
} from "../../src/main/installation.js";
import { DesktopStore } from "../../src/main/desktop-store.js";
import { OpenMinionInstallation } from "../../src/main/installation.js";
import * as manifests from "../../src/main/runtime-manifest.js";

const cleanup: Array<() => Promise<void>> = [];
const integrationExecutable = process.env.OPENMINION_EXECUTABLE;

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("DaemonSupervisor", () => {
  it("starts, checks, and stops the ordinary app-owned daemon", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    let reachable = false;
    const runCommand: RunCommand = vi.fn(async (command, args) => {
      calls.push({ executable: command, args });
      if (args.length === 1 && args[0] === "--version") return result(0, "0.0.19\n");
      if (args.includes("init")) {
        await writeFile(join(root, "agents.json"), '{"runtime":{}}\n', "utf-8");
        return result(0, "Initialized config\n");
      }
      if (args.at(-1) === "--json") {
        return result(reachable ? 0 : 1, JSON.stringify(daemonPayload(reachable, root)));
      }
      if (args.at(-1) === "start") {
        reachable = true;
        return result(0, "Started daemon\n");
      }
      if (args.at(-1) === "stop") {
        reachable = false;
        return result(0, "Stopped daemon\n");
      }
      return result(2, "", "unexpected command");
    });
    const supervisor = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: executable,
      homeRoot: join(root, "home"),
      dataRoot: join(root, "data"),
      configPath: join(root, "agents.json"),
      runCommand,
      spawnDaemon: vi.fn(() => {
        reachable = true;
        return fakeDaemon(() => {
          reachable = false;
        });
      }),
    });

    expect(await supervisor.start()).toMatchObject({
      state: "running",
      reachable: true,
      daemonVersion: null,
      protocol: null,
      capabilities: [],
    });
    expect(supervisor.startAttempts).toBe(1);
    expect(await supervisor.status()).toMatchObject({ state: "running", reachable: true });
    expect(supervisor.getCommandContext()).toEqual({
      executable,
      args: [
        "--home-root",
        join(root, "home"),
        "--data-root",
        join(root, "data"),
        "--config",
        join(root, "agents.json"),
      ],
    });
    expect(await supervisor.stop()).toEqual({ stopped: true });
    expect(supervisor.snapshot()).toMatchObject({ state: "stopped", reachable: false });

    const openMinionCalls = calls.filter((call) => call.args.length > 1);
    expect(openMinionCalls.map((call) => call.args.slice(-3))).toContainEqual([
      "daemon",
      "status",
      "--json",
    ]);
    expect(calls.some((call) => call.args.includes("init"))).toBe(true);
    const config = JSON.parse(await readFile(join(root, "agents.json"), "utf-8"));
    expect(config.runtime).toMatchObject({ ipc_host: "127.0.0.1" });
    expect(config.runtime.ipc_port).toBeGreaterThan(0);
    expect(config.runtime.ipc_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(supervisor.getCommandContext()).toBeNull();
    expect(calls.flatMap((call) => call.args)).not.toContain("desktop-bootstrap");
    expect(calls.flatMap((call) => call.args)).not.toContain("desktop-setup");
  });

  it("inspects the same daemon through fixed CLI commands, including after stopping", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    const configPath = join(root, "agents.json");
    await writeFile(configPath, '{"runtime":{}}');
    let reachable = true;
    let logResult = result(0, "<script>literal log text</script>\n");
    const runCommand = vi.fn<RunCommand>(async (_command, args) => {
      if (args.length === 1) return result(0, "0.0.19");
      if (args.at(-1) === "--json") return result(reachable ? 0 : 1, JSON.stringify({ reachable }));
      if (args.at(-1) === "stop") {
        reachable = false;
        return result(0);
      }
      if (args.at(-1) === "status")
        return result(reachable ? 0 : 1, `daemon status: ${reachable ? "running" : "stopped"}`);
      if (args.includes("logs")) return logResult;
      throw new Error("Unexpected command");
    });
    const supervisor = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: executable,
      homeRoot: join(root, "home"),
      dataRoot: join(root, "data"),
      configPath,
      runCommand,
    });
    expect(await supervisor.inspect("logs")).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
    await supervisor.start();
    const commandContext = supervisor.getCommandContext()!;
    expect(await supervisor.inspect("status")).toEqual({
      ok: true,
      value: { text: "daemon status: running" },
    });
    expect(await supervisor.inspect("logs")).toEqual({
      ok: true,
      value: { text: "<script>literal log text</script>" },
    });
    expect(runCommand).toHaveBeenLastCalledWith(
      executable,
      [...commandContext.args, "daemon", "logs", "--lines", "200"],
      30_000,
    );
    runCommand.mockClear();
    expect(await supervisor.inspect("restart")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(runCommand).not.toHaveBeenCalled();
    await supervisor.stop();
    runCommand.mockClear();
    expect(await supervisor.inspect("status")).toEqual({
      ok: true,
      value: { text: "daemon status: running" },
    });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(
      executable,
      [...commandContext.args, "daemon", "status"],
      30_000,
    );
    expect(supervisor.snapshot().state).toBe("stopped");
    logResult = result(1, "Log file does not exist", "private diagnostic");
    expect(await supervisor.inspect("logs")).toMatchObject({
      ok: false,
      error: { code: "diagnostics_unavailable" },
    });
    runCommand.mockRejectedValueOnce(new Error("private diagnostic"));
    expect(await supervisor.inspect("logs")).toMatchObject({
      ok: false,
      error: { code: "diagnostics_unavailable" },
    });
  });

  it("never starts or stops an external already-reachable daemon", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    const runCommand = vi.fn<RunCommand>(async (_command, args) => {
      if (args.length === 1) return result(0, "0.0.19\n");
      if (args.at(-1) === "--json") return result(0, JSON.stringify({ reachable: true }));
      if (args.at(-1) === "stop") return result(0, "Stopped daemon\n");
      return result(2);
    });
    const supervisor = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: executable,
      runCommand,
    });

    expect(await supervisor.start()).toMatchObject({ state: "running" });
    expect(runCommand.mock.calls.some(([, args]) => args.at(-1) === "start")).toBe(false);
    expect(await supervisor.stop()).toEqual({ stopped: false });
    expect(runCommand.mock.calls.some(([, args]) => args.at(-1) === "stop")).toBe(false);
  });

  it("does not create or stop a daemon when startup identity is unknown", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    const runCommand = vi.fn<RunCommand>(async (_command, args) => {
      if (args.length === 1) return result(0, "0.0.19");
      if (args.at(-1) === "--json") return result(1, JSON.stringify({ reachable: false }));
      return result(1);
    });
    const supervisor = new DaemonSupervisor({ openminionExecutable: executable, runCommand });
    expect(await supervisor.start()).toMatchObject({
      state: "degraded",
      errorCode: "daemon_ownership_unverified",
    });
    expect(await supervisor.stop()).toEqual({ stopped: false });
    expect(supervisor.snapshot()).toMatchObject({ state: "stopped" });
    expect(runCommand.mock.calls.some(([, args]) => args.at(-1) === "stop")).toBe(false);
  });

  it("reports bounded installation and daemon status failures", async () => {
    const root = await temporaryRoot();
    const missing = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: join(root, "missing"),
    });
    expect(await missing.start()).toMatchObject({
      state: "degraded",
      errorCode: "openminion_executable_unavailable",
    });
    await missing.stop();

    const executable = await fakeExecutable(root);
    const malformed = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: executable,
      runCommand: async (_command, args) =>
        args.length === 1 ? result(0, "0.0.19\n") : result(0, "not json\n"),
    });
    expect(await malformed.start()).toMatchObject({
      state: "degraded",
      errorCode: "invalid_daemon_status",
    });
    await malformed.stop();
  });

  it("never signals a replaced process or writes profiles after ownership is lost", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    await writeFile(join(root, "agents.json"), '{"runtime":{}}');
    let reachable = false;
    let pid = 1234;
    const daemon = fakeDaemon(() => {
      reachable = false;
    });
    const command = vi.fn<RunCommand>(async (_executable, args) =>
      args.length === 1
        ? result(0, "0.0.19")
        : result(reachable ? 0 : 1, JSON.stringify(daemonPayload(reachable, root, pid))),
    );
    const supervisor = new DaemonSupervisor({
      openminionExecutable: executable,
      homeRoot: root,
      dataRoot: join(root, "data"),
      configPath: join(root, "agents.json"),
      runCommand: command,
      spawnDaemon: () => {
        reachable = true;
        return daemon;
      },
    });
    await supervisor.start();
    pid = 5678;
    const save = vi.fn();
    expect(await supervisor.applyProfiles(save)).toMatchObject({
      ok: false,
      error: { code: "runtime_external" },
    });
    expect(save).not.toHaveBeenCalled();
    expect(await supervisor.stop()).toEqual({ stopped: false });
    expect(daemon.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "repairs profiles after its daemon exits only when no process remains (%s)",
    async (pidAlive) => {
      const root = await temporaryRoot();
      const executable = await fakeExecutable(root);
      await writeFile(join(root, "agents.json"), '{"runtime":{}}');
      let reachable = false;
      let exited = false;
      const daemon = fakeDaemon(() => {
        reachable = false;
      });
      const supervisor = new DaemonSupervisor({
        openminionExecutable: executable,
        homeRoot: root,
        dataRoot: join(root, "data"),
        configPath: join(root, "agents.json"),
        runCommand: async (_command, args) =>
          args.length === 1
            ? result(0, "0.0.19")
            : result(
                reachable ? 0 : 1,
                JSON.stringify({
                  ...daemonPayload(reachable, root),
                  pid_alive: exited ? pidAlive : reachable,
                }),
              ),
        spawnDaemon: () => {
          reachable = true;
          exited = false;
          return daemon.exitCode === null
            ? daemon
            : fakeDaemon(() => {
                reachable = false;
              });
        },
      });
      await supervisor.start();
      Object.assign(daemon, { exitCode: 1 });
      reachable = false;
      exited = true;
      const save = vi.fn().mockResolvedValue({});
      const applied = await supervisor.applyProfiles(save);
      if (pidAlive) {
        expect(applied).toMatchObject({ ok: false, error: { code: "runtime_external" } });
        expect(save).not.toHaveBeenCalled();
      } else {
        expect(applied).toMatchObject({ ok: true, value: { daemon: { reachable: true } } });
        expect(save).toHaveBeenCalledOnce();
      }
      expect(daemon.kill).not.toHaveBeenCalled();
      await supervisor.stop();
    },
  );

  it.each([
    [true, false, undefined],
    [false, false, undefined],
    [true, true, undefined],
    [true, false, "pause"],
    [true, false, "pin"],
  ])(
    "persists intent before candidate launch and accepts it only after health (%s)",
    async (healthy, incompatibleActive, hold) => {
      const root = await temporaryRoot();
      const store = new DesktopStore(root);
      cleanup.push(async () => store.close());
      const legacyRoot = join(root, "runtime/python/bin");
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(join(legacyRoot, "python"), "");
      await writeFile(join(legacyRoot, "openminion"), "");
      await writeFile(join(root, "agents.json"), '{"runtime":{}}');
      const candidate = {
        source: "pypi" as const,
        version: "1.0.0",
        executable: join(root, "candidate/openminion"),
        sha256: "a".repeat(64),
        manifestUrl: "immutable",
        desktopMinVersion: "0.0.0",
        desktopMaxVersionExclusive: "2.0.0",
      };
      if (incompatibleActive) {
        store.stageRuntime({
          ...candidate,
          version: OPENMINION_VERSION,
          executable: join(legacyRoot, "openminion"),
          desktopMinVersion: "1.0.0",
          desktopMaxVersionExclusive: "2.0.0",
        });
        store.beginRuntimeLaunch();
        store.completeRuntimeLaunch();
      }
      store.stageRuntime(candidate);
      if (hold === "pause") store.setRuntimePolicy(true, null);
      if (hold === "pin")
        store.setRuntimePolicy(false, {
          source: "pypi",
          version: OPENMINION_VERSION,
          manifestUrl: "legacy",
          sha256: "b".repeat(64),
        });
      let reachable = false;
      const command = vi.fn<RunCommand>(async (_executable, args) => {
        if (args.length === 1) return result(0, OPENMINION_VERSION);
        if (args.includes("sessions")) return healthy ? result(0, "[]") : result(1);
        return result(reachable ? 0 : 1, JSON.stringify(daemonPayload(reachable, root)));
      });
      const supervisor = new DaemonSupervisor({
        runtimeRoot: join(root, "runtime"),
        store,
        exclusiveRuntime: true,
        homeRoot: root,
        dataRoot: join(root, "data"),
        configPath: join(root, "agents.json"),
        runCommand: command,
        spawnDaemon: (executable) => {
          expect(executable).toBe(
            hold ? join(legacyRoot, "openminiond") : join(root, "candidate/openminiond"),
          );
          expect(store.runtimeState().launchIntent).toEqual(hold ? null : candidate);
          reachable = true;
          return fakeDaemon(() => {
            reachable = false;
          });
        },
      });
      const status = await supervisor.start();
      expect(status.state).toBe(healthy ? "ready" : "degraded");
      expect(store.runtimeState().active).toEqual(healthy && !hold ? candidate : null);
      expect(store.runtimeState().launchIntent).toEqual(healthy ? null : candidate);
      if (hold) expect(store.runtimeState().pending).toEqual(candidate);
      await supervisor.stop();
      if (!healthy) {
        expect(await supervisor.start()).toMatchObject({
          state: "degraded",
          errorCode: "runtime_recovery_required",
        });
      }
    },
  );

  it("validates private controls, persists exact pins, and refuses unavailable targets without fallback", async () => {
    const root = await temporaryRoot();
    const store = new DesktopStore(root);
    cleanup.push(async () => store.close());
    vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockResolvedValue({
      path: join(root, "openminion"),
      version: "0.0.19",
    });
    const check = vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue(null);
    const supervisor = new DaemonSupervisor({
      store,
      exclusiveRuntime: true,
      runtimeRoot: join(root, "runtime"),
      runCommand: async () => result(0, JSON.stringify({ reachable: true })),
    });
    await supervisor.start();
    for (const input of [
      null,
      [],
      { action: "force" },
      { action: "pause", url: "https://evil.example" },
      { action: "pin", version: "1.0.0rc1" },
      { action: "source", source: "archive" },
    ]) {
      expect(await supervisor.controlRuntime(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(await supervisor.controlRuntime({ action: "pin-installed" })).toMatchObject({
      ok: false,
      error: { code: "runtime_identity_unverified" },
    });
    expect(await supervisor.controlRuntime({ action: "pause" })).toMatchObject({
      ok: true,
      value: { paused: true },
    });
    expect(await supervisor.stageRuntime()).toMatchObject({
      ok: false,
      error: { code: "runtime_updates_paused" },
    });
    await supervisor.checkRuntime();
    expect(check).toHaveBeenCalled();
    expect(await supervisor.controlRuntime({ action: "pin", version: "1.0.0" })).toMatchObject({
      ok: false,
      error: { code: "runtime_pin_unavailable" },
    });
    check.mockResolvedValue({
      record: { distribution: "pypi", runtime_version: "1.0.0" },
      reference: { manifest_url: "immutable" },
      artifact: { sha256: "a".repeat(64) },
    } as manifests.RuntimeOffer);
    expect(await supervisor.controlRuntime({ action: "pin", version: "1.0.0" })).toMatchObject({
      ok: true,
      value: { paused: true, pinnedVersion: "1.0.0" },
    });
    expect(store.runtimeState().pin).toEqual({
      source: "pypi",
      version: "1.0.0",
      manifestUrl: "immutable",
      sha256: "a".repeat(64),
    });
    expect(await supervisor.controlRuntime({ action: "resume" })).toMatchObject({
      ok: true,
      value: { paused: false, pinnedVersion: "1.0.0" },
    });
    await supervisor.checkRuntime();
    expect(check).toHaveBeenLastCalledWith(
      expect.objectContaining({ pin: store.runtimeState().pin }),
    );
    expect(await supervisor.controlRuntime({ action: "unpin" })).toMatchObject({
      ok: true,
      value: { pinnedVersion: null },
    });
    expect(await supervisor.controlRuntime({ action: "source", source: "binary" })).toMatchObject({
      ok: true,
      value: { source: "binary", selectedSource: "binary" },
    });
    await supervisor.checkRuntime();
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ source: "binary" }));
    await supervisor.stop(true);
    const unmanaged = new DaemonSupervisor({
      store,
      openminionExecutable: "external",
      exclusiveRuntime: true,
    });
    expect(await unmanaged.controlRuntime({ action: "pause" })).toMatchObject({
      ok: false,
      error: { code: "runtime_unmanaged" },
    });
    await unmanaged.stop(true);
  });

  it("pauses or discards an in-flight preparation and fences its late store write", async () => {
    for (const action of ["pause", "discard"] as const) {
      const root = await temporaryRoot();
      const store = new DesktopStore(root);
      cleanup.push(async () => store.close());
      vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockResolvedValue({
        path: join(root, "openminion"),
        version: "0.0.19",
      });
      vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue({
        record: { runtime_version: "1.0.0" },
      } as manifests.RuntimeOffer);
      let signal!: AbortSignal;
      vi.spyOn(OpenMinionInstallation.prototype, "stage").mockImplementation(
        (_offer, controller) =>
          new Promise((_resolve, reject) => {
            signal = controller!;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const supervisor = new DaemonSupervisor({
        store,
        exclusiveRuntime: true,
        runtimeRoot: join(root, "runtime"),
        runCommand: async () => result(0, JSON.stringify({ reachable: true })),
      });
      await supervisor.start();
      await supervisor.checkRuntime();
      const preparation = supervisor.stageRuntime();
      expect((await supervisor.controlRuntime({ action })).ok).toBe(true);
      expect(signal.aborted).toBe(true);
      expect((await preparation).ok).toBe(false);
      expect(store.runtimeState()).toMatchObject({
        paused: action === "pause",
        pending: null,
        launchIntent: null,
        active: null,
      });
      await supervisor.stop(true);
      vi.restoreAllMocks();
    }
  });

  it("discovers replacements for an incompatible active runtime without starting it", async () => {
    const root = await temporaryRoot();
    const store = new DesktopStore(root);
    cleanup.push(async () => store.close());
    const executable = await fakeExecutable(root);
    store.stageRuntime({
      source: "pypi",
      version: "1.0.0",
      executable,
      sha256: "a".repeat(64),
      manifestUrl: "immutable",
      desktopMinVersion: "1.0.0",
      desktopMaxVersionExclusive: "2.0.0",
    });
    store.beginRuntimeLaunch();
    store.completeRuntimeLaunch();
    const command = vi.fn<RunCommand>(async () => result(0, "1.0.0"));
    const spawn = vi.fn();
    const check = vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue(null);
    const supervisor = new DaemonSupervisor({
      store,
      runtimeRoot: join(root, "runtime"),
      exclusiveRuntime: true,
      desktopVersion: "2.0.0",
      runCommand: command,
      spawnDaemon: spawn,
    });
    expect(await supervisor.start()).toMatchObject({
      state: "degraded",
      errorCode: "runtime_incompatible",
    });
    expect(command).toHaveBeenCalledExactlyOnceWith(executable, ["--version"], 30_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(await supervisor.checkRuntime()).toMatchObject({
      installedVersion: "1.0.0",
      phase: "incompatible",
    });
    expect(check).toHaveBeenCalledOnce();
    await supervisor.stop(true);
  });

  it("consumes a staged offer, rejects shared roots, and cancels staging on shutdown", async () => {
    const root = await temporaryRoot();
    const store = new DesktopStore(root);
    cleanup.push(async () => store.close());
    vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockResolvedValue({
      path: join(root, "openminion"),
      version: "0.0.19",
    });
    vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue({
      record: { runtime_version: "1.0.0" },
    } as manifests.RuntimeOffer);
    const options = {
      store,
      runtimeRoot: join(root, "runtime"),
      runCommand: async () => result(0, JSON.stringify({ reachable: true })),
    };
    const shared = new DaemonSupervisor(options);
    await shared.start();
    await shared.checkRuntime();
    expect(await shared.stageRuntime()).toMatchObject({
      ok: false,
      error: { code: "runtime_shared_roots" },
    });
    await shared.stop(true);
    const supervisor = new DaemonSupervisor({ ...options, exclusiveRuntime: true });
    await supervisor.start();
    await supervisor.checkRuntime();
    const candidate = {
      source: "pypi" as const,
      version: "1.0.0",
      executable: join(root, "candidate/openminion"),
      sha256: "a".repeat(64),
      manifestUrl: "immutable",
      desktopMinVersion: "0.0.0",
      desktopMaxVersionExclusive: "2.0.0",
    };
    const stage = vi
      .spyOn(OpenMinionInstallation.prototype, "stage")
      .mockImplementation(async () => {
        store.stageRuntime(candidate);
        return candidate;
      });
    expect((await supervisor.stageRuntime()).ok).toBe(true);
    expect((await supervisor.stageRuntime()).ok).toBe(false);
    expect(stage).toHaveBeenCalledOnce();
    expect(store.runtimeState().pending).toEqual(candidate);
    await supervisor.stop(true);
    const cancelRoot = await temporaryRoot();
    const cancelStore = new DesktopStore(cancelRoot);
    cleanup.push(async () => cancelStore.close());
    const cancelling = new DaemonSupervisor({
      ...options,
      store: cancelStore,
      exclusiveRuntime: true,
    });
    await cancelling.start();
    await cancelling.checkRuntime();
    stage.mockImplementation(
      (_offer, signal) =>
        new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        ),
    );
    const staging = cancelling.stageRuntime();
    await cancelling.stop(true);
    expect((await staging).ok).toBe(false);
    expect(cancelStore.runtimeState().pending).toBeNull();
  });

  it("checks automatically at startup and every 24 hours without installing or restarting", async () => {
    const root = await temporaryRoot();
    const store = new DesktopStore(root);
    cleanup.push(async () => store.close());
    const ensure = vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockResolvedValue({
      path: join(root, "openminion"),
      version: "0.0.19",
    });
    const stage = vi.spyOn(OpenMinionInstallation.prototype, "stage");
    const check = vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue(null);
    const supervisor = new DaemonSupervisor({
      store,
      runtimeRoot: join(root, "runtime"),
      runCommand: async () => result(0, JSON.stringify({ reachable: true })),
    });
    await supervisor.start();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      supervisor.startUpdateChecks();
      await supervisor.checkRuntime();
      expect(check).toHaveBeenCalledOnce();
      supervisor.startUpdateChecks();
      await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
      expect(check).toHaveBeenCalledOnce();
      check.mockResolvedValue({
        record: { runtime_version: "0.0.21" },
      } as manifests.RuntimeOffer);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(check).toHaveBeenCalledTimes(2);
      expect(supervisor.runtimeStatus()).toMatchObject({
        phase: "available",
        installedVersion: "0.0.19",
        availableVersion: "0.0.21",
      });
      expect(ensure).toHaveBeenCalledOnce();
      expect(stage).not.toHaveBeenCalled();
      expect(store.runtimeState().pending).toBeNull();
      await supervisor.stop(true);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await supervisor.stop(true);
    }
  });

  it("fences checks during startup shutdown and preserves checks on ordinary restarts", async () => {
    const root = await temporaryRoot();
    const store = new DesktopStore(root);
    cleanup.push(async () => store.close());
    let finish!: (value: { path: string; version: string }) => void;
    vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const check = vi.spyOn(manifests, "checkRuntimeManifest").mockResolvedValue(null);
    const supervisor = new DaemonSupervisor({
      store,
      runtimeRoot: join(root, "runtime"),
      runCommand: async () => result(0, JSON.stringify({ reachable: true })),
    });
    const startup = supervisor.start().then(() => supervisor.startUpdateChecks());
    const stopping = supervisor.stop(true);
    finish({ path: join(root, "openminion"), version: "0.0.19" });
    await startup;
    await stopping;
    supervisor.startUpdateChecks();
    await supervisor.checkRuntime();
    expect(check).not.toHaveBeenCalled();
    vi.spyOn(OpenMinionInstallation.prototype, "ensure").mockResolvedValue({
      path: join(root, "openminion"),
      version: "0.0.19",
    });
    const restarted = new DaemonSupervisor({
      store,
      runtimeRoot: join(root, "runtime"),
      runCommand: async () => result(0, JSON.stringify({ reachable: true })),
    });
    await restarted.start();
    restarted.startUpdateChecks();
    await restarted.checkRuntime();
    await restarted.stop();
    await restarted.start();
    await restarted.checkRuntime();
    expect(check).toHaveBeenCalledTimes(2);
    await restarted.stop(true);
  });
});

it.skipIf(!integrationExecutable)(
  "installs a first-run config and manages the ordinary OpenMinion daemon",
  async () => {
    const root = await temporaryRoot();
    const supervisor = new DaemonSupervisor({
      runtimeRoot: join(root, "runtime"),
      openminionExecutable: integrationExecutable,
      homeRoot: root,
      dataRoot: join(root, "data"),
      configPath: join(root, "agents.json"),
      commandTimeoutMs: 60_000,
    });
    cleanup.push(async () => {
      await supervisor.stop(true);
    });

    expect(await supervisor.start()).toMatchObject({
      state: "ready",
      reachable: true,
      daemonVersion: null,
    });
    expect(await supervisor.status()).toMatchObject({ state: "ready", reachable: true });
    expect(await supervisor.stop()).toEqual({ stopped: true });
  },
  120_000,
);

function result(exitCode: number | null, stdout = "", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function daemonPayload(reachable: boolean, root: string, pid = 1234) {
  return {
    reachable,
    pid: reachable ? pid : null,
    pid_alive: reachable,
    lifecycle: reachable ? "running" : "stopped",
    endpoint_status: reachable ? "ok" : "unreachable",
    remote_config_path: reachable ? join(realpathSync(root), "agents.json") : "",
    remote_data_root: reachable ? join(realpathSync(root), "data") : "",
  };
}

function fakeDaemon(onKill: () => void): ChildProcess {
  const daemon = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => {
      onKill();
      daemon.signalCode = "SIGTERM";
      daemon.emit("exit", null, "SIGTERM");
      return true;
    }),
  });
  return daemon as unknown as ChildProcess;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-desktop-lifecycle-"));
  await mkdir(join(root, "data"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeExecutable(root: string): Promise<string> {
  const path = join(root, "openminion");
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf-8");
  await chmod(path, 0o755);
  return path;
}
