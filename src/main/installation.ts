import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopStore, InstalledRuntime } from "./desktop-store.js";
import type { RuntimeOffer } from "./runtime-manifest.js";

export const OPENMINION_VERSION = "0.0.19";

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
  signal?: AbortSignal,
) => Promise<CommandResult>;

export type OpenMinionInstallationOptions = {
  runtimeRoot?: string;
  openminionExecutable?: string;
  pythonExecutable?: string;
  version?: string;
  runCommand?: RunCommand;
  platform?: NodeJS.Platform;
  store?: DesktopStore;
  desktopVersion?: string;
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
    const state = this.#options.store?.runtimeState();
    if (state?.launchIntent) throw new Error("runtime_recovery_required");
    if (state?.active) {
      const installed = await this.#readVersion(state.active.executable);
      if (installed !== state.active.version) throw new Error("openminion_version_mismatch");
      return { path: state.active.executable, version: installed };
    }
    const environmentRoot = join(this.#options.runtimeRoot, "python");
    const platform = this.#options.platform ?? process.platform;
    const { python, executable } = pythonEnvironment(environmentRoot, platform);
    const requiredVersion = this.#options.version ?? OPENMINION_VERSION;

    if (!(await pathExists(python))) {
      const created = await this.#runCommand(
        this.#options.pythonExecutable ?? (platform === "win32" ? "py" : "python3.11"),
        [
          ...(platform === "win32" && !this.#options.pythonExecutable ? ["-3.11"] : []),
          "-m",
          "venv",
          environmentRoot,
        ],
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

  async stage(offer: RuntimeOffer, signal?: AbortSignal): Promise<InstalledRuntime> {
    signal?.throwIfAborted();
    if (this.#options.openminionExecutable) throw new Error("runtime_unmanaged");
    if (!this.#options.runtimeRoot || !this.#options.store)
      throw new Error("runtime_root_unavailable");
    if (this.#options.store.runtimeState().launchIntent)
      throw new Error("runtime_recovery_required");
    // Standalone launchers remain prototype inputs until foreground/native qualification.
    if (offer.record.distribution !== "pypi" || !offer.record.pypi)
      throw new Error("binary_runtime_not_qualified");
    const stagingRoot = join(this.#options.runtimeRoot, "staged");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(stagingRoot, `${offer.record.runtime_version}-`));
    try {
      const wheel = join(root, offer.artifact.filename);
      const response = await fetch(offer.artifact.url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
          : AbortSignal.timeout(15 * 60_000),
        redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("runtime_download_failed");
      const digest = createHash("sha256");
      let size = 0;
      const file = await open(wheel, "wx", 0o600);
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > offer.artifact.size_bytes) throw new Error("runtime_integrity_mismatch");
          digest.update(chunk);
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if (size !== offer.artifact.size_bytes || digest.digest("hex") !== offer.artifact.sha256)
        throw new Error("runtime_integrity_mismatch");
      signal?.throwIfAborted();
      const platform = this.#options.platform ?? process.platform;
      const environmentRoot = join(root, "python");
      const { python, executable } = pythonEnvironment(environmentRoot, platform);
      const created = await this.#runCommand(
        this.#options.pythonExecutable ?? (platform === "win32" ? "py" : "python3.11"),
        [
          ...(platform === "win32" && !this.#options.pythonExecutable ? ["-3.11"] : []),
          "-m",
          "venv",
          environmentRoot,
        ],
        60_000,
        undefined,
        signal,
      );
      signal?.throwIfAborted();
      if (created.exitCode !== 0) throw new Error("python_environment_failed");
      const installed = await this.#runCommand(
        python,
        ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", wheel],
        300_000,
        undefined,
        signal,
      );
      signal?.throwIfAborted();
      if (installed.exitCode !== 0) throw new Error("openminion_install_failed");
      if (
        (await this.#readVersion(
          executable,
          {
            OPENMINION_HOME: root,
            OPENMINION_DATA_ROOT: join(root, "data"),
          },
          signal,
        )) !== offer.record.runtime_version
      )
        throw new Error("openminion_version_mismatch");
      const candidate: InstalledRuntime = {
        source: "pypi",
        version: offer.record.runtime_version,
        executable,
        sha256: offer.artifact.sha256,
        manifestUrl: offer.reference.manifest_url,
        desktopMinVersion: offer.record.desktop_compatibility!.min_version,
        desktopMaxVersionExclusive: offer.record.desktop_compatibility!.max_version_exclusive,
      };
      signal?.throwIfAborted();
      this.#options.store.stageRuntime(candidate);
      return candidate;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async #readVersion(
    executable: string,
    environment?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!(await pathExists(executable))) return null;
    const result = environment
      ? await this.#runCommand(executable, ["--version"], 30_000, environment, signal)
      : await this.#runCommand(executable, ["--version"], 30_000);
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }
}

export function pythonEnvironment(root: string, platform = process.platform) {
  const directory = join(root, platform === "win32" ? "Scripts" : "bin");
  return {
    python: join(directory, platform === "win32" ? "python.exe" : "python"),
    executable: join(directory, platform === "win32" ? "openminion.exe" : "openminion"),
    daemonExecutable: join(directory, platform === "win32" ? "openminiond.exe" : "openminiond"),
  };
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
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(signal ? { signal } : {}),
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
