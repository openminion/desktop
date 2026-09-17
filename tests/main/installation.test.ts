import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENMINION_VERSION,
  OpenMinionInstallation,
  type CommandResult,
  type RunCommand,
} from "../../src/main/installation.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("OpenMinionInstallation", () => {
  it("uses the Windows 3.11 launcher and native Scripts executables", async () => {
    const root = await temporaryRoot();
    const environment = join(root, "python");
    const python = join(environment, "Scripts", "python.exe");
    const executable = join(environment, "Scripts", "openminion.exe");
    const runCommand = vi.fn<RunCommand>(async (command) => {
      if (command === "py") {
        await mkdir(join(environment, "Scripts"), { recursive: true });
        await writeFile(python, "");
      } else if (command === python) await writeFile(executable, "");
      return result(0, command === executable ? OPENMINION_VERSION : "");
    });
    const installation = new OpenMinionInstallation({
      runtimeRoot: root,
      platform: "win32",
      runCommand,
    });
    await expect(installation.ensure()).resolves.toEqual({
      path: executable,
      version: OPENMINION_VERSION,
    });
    expect(runCommand).toHaveBeenCalledWith("py", ["-3.11", "-m", "venv", environment], 60_000);
    expect(runCommand).toHaveBeenCalledWith(
      python,
      expect.arrayContaining([`openminion==${OPENMINION_VERSION}`]),
      300_000,
    );
    runCommand.mockClear();
    await installation.ensure();
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(executable, ["--version"], 30_000);
  });

  it.each([null, 1])(
    "fails clearly when Python cannot create the environment (%s)",
    async (exitCode) => {
      const root = await temporaryRoot();
      const runCommand = vi.fn<RunCommand>(async () => result(exitCode));
      await expect(
        new OpenMinionInstallation({ runtimeRoot: root, runCommand }).ensure(),
      ).rejects.toThrow("python_environment_failed");
      expect(runCommand).toHaveBeenCalledTimes(1);
    },
  );

  it("does not probe a runtime after pip fails", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "python", "bin"), { recursive: true });
    await writeFile(join(root, "python", "bin", "python"), "");
    const runCommand = vi.fn<RunCommand>(async () => result(1));
    await expect(
      new OpenMinionInstallation({ runtimeRoot: root, runCommand }).ensure(),
    ).rejects.toThrow("openminion_install_failed");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it("creates an isolated environment and installs the pinned PyPI package", async () => {
    const root = await temporaryRoot();
    const environmentRoot = join(root, "python");
    const python = join(environmentRoot, "bin", "python");
    const executable = join(environmentRoot, "bin", "openminion");
    let installed = false;
    const runCommand = vi.fn<RunCommand>(async (command, _args) => {
      if (command === "python3.11") {
        await mkdir(join(environmentRoot, "bin"), { recursive: true });
        await writeFile(python, "", "utf-8");
        return result(0);
      }
      if (command === python) {
        installed = true;
        await writeFile(executable, "", "utf-8");
        return result(0);
      }
      if (command === executable && installed) return result(0, `${OPENMINION_VERSION}\n`);
      return result(1);
    });

    const installation = new OpenMinionInstallation({ runtimeRoot: root, runCommand });
    await expect(installation.ensure()).resolves.toEqual({
      path: executable,
      version: OPENMINION_VERSION,
    });
    expect(runCommand).toHaveBeenCalledWith(
      python,
      expect.arrayContaining(["--upgrade", `openminion==${OPENMINION_VERSION}`]),
      300_000,
    );
  });

  it("reuses the managed executable when its pinned version is already installed", async () => {
    const root = await temporaryRoot();
    const environmentRoot = join(root, "python");
    const python = join(environmentRoot, "bin", "python");
    const executable = join(environmentRoot, "bin", "openminion");
    await mkdir(join(environmentRoot, "bin"), { recursive: true });
    await writeFile(python, "", "utf-8");
    await writeFile(executable, "", "utf-8");
    const runCommand = vi.fn<RunCommand>(async () => result(0, `${OPENMINION_VERSION}\n`));

    const installation = new OpenMinionInstallation({ runtimeRoot: root, runCommand });
    await expect(installation.ensure()).resolves.toEqual({
      path: executable,
      version: OPENMINION_VERSION,
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("replaces a managed executable whose version does not match the pin", async () => {
    const root = await temporaryRoot();
    const environmentRoot = join(root, "python");
    const python = join(environmentRoot, "bin", "python");
    const executable = join(environmentRoot, "bin", "openminion");
    await mkdir(join(environmentRoot, "bin"), { recursive: true });
    await writeFile(python, "", "utf-8");
    await writeFile(executable, "", "utf-8");
    let version = "0.0.18";
    const runCommand = vi.fn<RunCommand>(async (command) => {
      if (command === executable) return result(0, `${version}\n`);
      if (command === python) {
        version = OPENMINION_VERSION;
        return result(0);
      }
      return result(1);
    });

    const installation = new OpenMinionInstallation({ runtimeRoot: root, runCommand });
    await expect(installation.ensure()).resolves.toEqual({
      path: executable,
      version: OPENMINION_VERSION,
    });
    expect(runCommand).toHaveBeenCalledWith(
      python,
      expect.arrayContaining(["--upgrade", `openminion==${OPENMINION_VERSION}`]),
      300_000,
    );
  });
});

function result(exitCode: number | null, stdout = "", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-desktop-installation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
