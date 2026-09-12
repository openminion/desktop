import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OPENMINION_VERSION, runCommand } from "../../dist/src/main/installation.js";

if (process.versions.electron) {
  void runDesktop();
} else {
  await verifyManagedLifecycle();
}

async function verifyManagedLifecycle() {
  const root = await mkdtemp(join(tmpdir(), "openminion-managed-install-"));
  const executable = join(root, "runtime", "python", "bin", "openminion");
  const args = commandRoots(root);
  try {
    await launchDesktop(root);
    await assertStopped(executable, args);
    const firstMtime = (await stat(executable)).mtimeMs;

    await launchDesktop(root);
    await assertStopped(executable, args);
    assert.equal((await stat(executable)).mtimeMs, firstMtime);

    const version = await runCommand(executable, ["--version"], 30_000);
    assert.equal(version.exitCode, 0);
    assert.equal(version.stdout.trim(), OPENMINION_VERSION);
    const config = JSON.parse(await readFile(join(root, "agents.json"), "utf8"));
    assert.equal(config.runtime.ipc_host, "127.0.0.1");
    assert.match(config.runtime.ipc_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(join(root, "agents.json"))).mode & 0o777, 0o600);
    console.log(
      `PASS: Desktop installed OpenMinion ${OPENMINION_VERSION}, reused it, and stopped each app-owned daemon on quit.`,
    );
  } catch (error) {
    console.error(error);
    await runCommand(executable, [...args, "daemon", "stop"], 30_000);
    process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function launchDesktop(root) {
  const { default: electron } = await import("electron");
  const environment = { ...process.env, OPENMINION_DESKTOP_HOME: root };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.OPENMINION_EXECUTABLE;
  delete environment.OPENMINION_PYPI_EXECUTABLE;
  const result = await promisify(execFile)(electron, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: environment,
    timeout: 420_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout);
}

async function assertStopped(executable, args) {
  const status = await runCommand(executable, [...args, "daemon", "status", "--json"], 30_000);
  assert.equal(status.exitCode, 1);
  assert.equal(JSON.parse(status.stdout).reachable, false);
}

async function runDesktop() {
  const { app } = await import("electron");
  const root = process.env.OPENMINION_DESKTOP_HOME;
  assert.ok(root);
  app.setPath("userData", root);
  delete process.env.OPENMINION_EXECUTABLE;
  delete process.env.OPENMINION_PYPI_EXECUTABLE;

  const loaded = new Promise((resolve) => {
    app.once("browser-window-created", (_event, window) => {
      window.webContents.once("did-finish-load", () => resolve(window));
    });
  });
  const timeout = setTimeout(() => {
    console.error("Managed install app timed out");
    void failDesktop(app, root);
  }, 420_000);

  await import("../../dist/src/main/bootstrap.js");
  try {
    const window = await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    for (let attempt = 0; attempt < 1_800; attempt += 1) {
      if (await evaluate("document.querySelector('#connection-label').textContent === 'Connected'"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      await evaluate("document.querySelector('#connection-label').textContent"),
      "Connected",
    );
    clearTimeout(timeout);
    app.quit();
  } catch (error) {
    clearTimeout(timeout);
    console.error(error);
    await failDesktop(app, root);
  }
}

async function failDesktop(app, root) {
  const executable = join(root, "runtime", "python", "bin", "openminion");
  await runCommand(executable, [...commandRoots(root), "daemon", "stop"], 30_000);
  app.exit(1);
}

function commandRoots(root) {
  return [
    "--home-root",
    root,
    "--data-root",
    join(root, "data"),
    "--config",
    join(root, "agents.json"),
  ];
}
