import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export const OPENMINION_VERSION = "0.0.18";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type RunCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment?: Record<string, string>,
) => Promise<CommandResult>;

export type OpenMinionInstallationOptions = {
  runtimeRoot?: string;
  openminionExecutable?: string;
  pythonExecutable?: string;
  version?: string;
  runCommand?: RunCommand;
};

export type OpenMinionExecutable = {
  path: string;
  version: string;
};

export class OpenMinionInstallation {
  readonly #options: OpenMinionInstallationOptions;
  readonly #runCommand: RunCommand;

  constructor(options: OpenMinionInstallationOptions) {
    this.#options = options;
    this.#runCommand = options.runCommand ?? runCommand;
  }

  async ensure(): Promise<OpenMinionExecutable> {
    if (this.#options.openminionExecutable) {
      const version = await this.#readVersion(this.#options.openminionExecutable);
      if (!version) throw new Error("openminion_executable_unavailable");
      return { path: this.#options.openminionExecutable, version };
    }

    if (!this.#options.runtimeRoot) throw new Error("runtime_root_unavailable");
    const environmentRoot = join(this.#options.runtimeRoot, "python");
    const python = join(environmentRoot, "bin", "python");
    const executable = join(environmentRoot, "bin", "openminion");
    const requiredVersion = this.#options.version ?? OPENMINION_VERSION;

    if (!(await pathExists(python))) {
      const created = await this.#runCommand(
        this.#options.pythonExecutable ?? "python3.11",
        ["-m", "venv", environmentRoot],
        60_000,
      );
      if (created.exitCode !== 0) throw new Error("python_environment_failed");
    }

    const installedVersion = await this.#readVersion(executable);
    if (installedVersion === requiredVersion) {
      return { path: executable, version: installedVersion };
    }
    const install = await this.#runCommand(
      python,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--upgrade",
        `openminion==${requiredVersion}`,
      ],
      300_000,
    );
    if (install.exitCode !== 0) throw new Error("openminion_install_failed");

    const installed = await this.#readVersion(executable);
    if (installed !== requiredVersion) throw new Error("openminion_version_mismatch");
    return { path: executable, version: installed };
  }

  async #readVersion(executable: string): Promise<string | null> {
    if (!(await pathExists(executable))) return null;
    const result = await this.#runCommand(executable, ["--version"], 30_000);
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function runCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}
