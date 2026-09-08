import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../../src/main/backend-supervisor.js";
import type { CommandResult, RunCommand } from "../../src/main/installation.js";

const cleanup: Array<() => Promise<void>> = [];
const integrationExecutable = process.env.OPENMINION_EXECUTABLE;

afterEach(async () => {
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
      if (args.length === 1 && args[0] === "--version") return result(0, "0.0.18\n");
      if (args.includes("init")) {
        await writeFile(join(root, "agents.json"), '{"runtime":{}}\n', "utf-8");
        return result(0, "Initialized config\n");
      }
      if (args.at(-1) === "--json") {
        return result(reachable ? 0 : 1, JSON.stringify({ reachable }));
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
    });

    expect(await supervisor.start()).toMatchObject({
      state: "running",
      reachable: true,
      daemonVersion: "0.0.18",
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

  it("does not start a second daemon when the app-owned daemon is already reachable", async () => {
    const root = await temporaryRoot();
    const executable = await fakeExecutable(root);
    const runCommand = vi.fn<RunCommand>(async (_command, args) => {
      if (args.length === 1) return result(0, "0.0.18\n");
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
    await supervisor.stop();
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
        args.length === 1 ? result(0, "0.0.18\n") : result(0, "not json\n"),
    });
    expect(await malformed.start()).toMatchObject({
      state: "degraded",
      errorCode: "invalid_daemon_status",
    });
    await malformed.stop();
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

    expect(await supervisor.start()).toMatchObject({
      state: "running",
      reachable: true,
      daemonVersion: "0.0.18",
    });
    expect(await supervisor.status()).toMatchObject({ state: "running", reachable: true });
    expect(await supervisor.stop()).toEqual({ stopped: true });
  },
  120_000,
);

function result(exitCode: number | null, stdout = "", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-desktop-lifecycle-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeExecutable(root: string): Promise<string> {
  const path = join(root, "openminion");
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf-8");
  await chmod(path, 0o755);
  return path;
}
