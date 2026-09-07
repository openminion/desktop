import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { arch } from "node:process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const nativeEnabled = process.env.OPENMINION_ODC_NATIVE_CAPTURE === "1";

type NativeRecord = {
  schemaVersion: 1;
  runtime: string;
  packagedArtifact: string;
  electronVersion: string;
  permission: string;
  targetLabel: string;
  fullWindow: CaptureFacts;
  region: CaptureFacts;
  pause: { framesStable: boolean; retainedBytes: number };
  stop: { reason: string; retainedBytes: number };
  sourceClose: { reason: string; retainedBytes: number };
  lockBoundary: { kind: string; reason: string; retainedBytes: number };
  indicatorStates: string[];
  cleanup: { active: boolean; retainedBytes: number };
};

type CaptureFacts = {
  frames: number;
  dropped: number;
  retainedBytesPeak: number;
  width: number;
  height: number;
  cadenceMs: number;
  previewBytes: number;
};

describe("native capture", () => {
  it.skipIf(!nativeEnabled)(
    "captures only the dedicated synthetic window and region",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openminion-odc-native-"));
      let child: ChildProcess | null = null;
      try {
        const projectRoot = process.cwd();
        const appPath = join(projectRoot, "out", `OpenMinion-darwin-${arch}`, "OpenMinion.app");
        const packagedExecutable = join(appPath, "Contents", "MacOS", "OpenMinion");
        const packagedInfo = join(appPath, "Contents", "Info.plist");
        const electronExecutable = join(
          projectRoot,
          "node_modules",
          "electron",
          "dist",
          "Electron.app",
          "Contents",
          "MacOS",
          "Electron",
        );
        const fixture = join(projectRoot, "dist", "tests", "fixtures", "capture-native.js");
        await Promise.all([
          access(packagedExecutable),
          access(electronExecutable),
          access(fixture),
        ]);
        expect(await readFile(packagedInfo, "utf-8")).toContain("OpenMinion");

        child = spawn(electronExecutable, [fixture], {
          cwd: projectRoot,
          env: {
            ...process.env,
            ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
            OPENMINION_ODC_NATIVE_ROOT: root,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const { stdout, stderr, exitCode } = await collect(child, 45_000);
        expect(exitCode, stderr).toBe(0);
        const record = parseRecord(stdout);
        expect(record).toMatchObject({
          schemaVersion: 1,
          runtime: "electron-native-fixture",
          packagedArtifact: "verified_only",
          electronVersion: "43.1.1",
          permission: "granted",
          targetLabel: "OpenMinion Capture Fixture",
          pause: { framesStable: true, retainedBytes: 0 },
          stop: { reason: "user_stopped", retainedBytes: 0 },
          sourceClose: { reason: "source_ended", retainedBytes: 0 },
          lockBoundary: {
            kind: "service_stop_reason",
            reason: "screen_locked",
            retainedBytes: 0,
          },
          cleanup: { active: false, retainedBytes: 0 },
        });
        expect(record.fullWindow.frames).toBeGreaterThanOrEqual(2);
        expect(record.fullWindow.previewBytes).toBeGreaterThan(0);
        expect(record.fullWindow.cadenceMs).toBeGreaterThanOrEqual(1_800);
        expect(record.fullWindow.cadenceMs).toBeLessThanOrEqual(2_500);
        expect(record.region.frames).toBeGreaterThanOrEqual(2);
        expect(record.region.width).toBeLessThan(record.fullWindow.width);
        expect(record.region.height).toBeLessThan(record.fullWindow.height);
        expect(record.region.previewBytes).toBeGreaterThan(0);
        expect(record.indicatorStates).toEqual(
          expect.arrayContaining([
            "idle",
            "selecting",
            "starting",
            "observing",
            "paused",
            "stopping",
          ]),
        );

        const { stdout: macOS } = await execFileAsync("/usr/bin/sw_vers", ["-productVersion"]);
        process.stdout.write(
          `${JSON.stringify({
            appPath,
            macOS: macOS.trim(),
            runtime: record.runtime,
            packagedArtifact: record.packagedArtifact,
            electronVersion: record.electronVersion,
            permission: record.permission,
            targetLabel: record.targetLabel,
            fullWindow: record.fullWindow,
            region: record.region,
            pause: record.pause,
            stop: record.stop,
            sourceClose: record.sourceClose,
            lockBoundary: record.lockBoundary,
            cleanup: record.cleanup,
          })}\n`,
        );
      } finally {
        try {
          if (child) await terminateChild(child);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    60_000,
  );
});

function collect(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const append = (current: string, chunk: string) => {
      const next = current + chunk;
      if (next.length <= 64 * 1024) return next;
      child.kill("SIGTERM");
      fail(new Error("native capture output was too large"));
      return current;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("native capture process timed out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      fail(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 2_000))) {
    throw new Error("native capture process did not terminate");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("error", errored);
      resolve(value);
    };
    const exited = () => finish(true);
    const errored = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", exited);
    child.once("error", errored);
  });
}

function parseRecord(output: string): NativeRecord {
  const records = output
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"));
  if (records.length !== 1) throw new Error("native capture record was missing");
  return JSON.parse(records[0]!) as NativeRecord;
}
