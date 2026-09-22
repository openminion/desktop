import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopStore } from "../../dist/src/main/desktop-store.js";
import {
  OPENMINION_VERSION,
  OpenMinionInstallation,
  runCommand,
} from "../../dist/src/main/installation.js";

// Main-owned private acceptance fixture, NOT a published compatibility certificate.
const testpypiArgument = process.argv.indexOf("--testpypi-final");
const pypiArgument = process.argv.indexOf("--pypi-final");
assert.ok(testpypiArgument < 0 || pypiArgument < 0, "Choose one private test index");
const candidateFlag = testpypiArgument < 0 ? "--pypi-final" : "--testpypi-final";
const candidateArgument = process.argv.indexOf(candidateFlag);
const version = candidateArgument < 0 ? "0.0.20" : process.argv[candidateArgument + 1];
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
const metadataOrigin = testpypiArgument < 0 ? "https://pypi.org" : "https://test.pypi.org";
const candidateArguments = candidateArgument < 0 ? [] : [candidateFlag, version];
if (process.versions.electron) {
  void checkPhase();
} else {
  const root = await mkdtemp(join(tmpdir(), "desktop-runtime-update-"));
  try {
    const { default: electron } = await import("electron");
    for (const phase of ["stage", "hold", "activate", "reuse", "controls", "intent", "recovery"]) {
      const environment = { ...process.env, OPENMINION_UPDATE_TEST_ROOT: root };
      delete environment.ELECTRON_RUN_AS_NODE;
      delete environment.OPENMINION_EXECUTABLE;
      const result = await promisify(execFile)(
        electron,
        [fileURLToPath(import.meta.url), phase, ...candidateArguments],
        {
          env: environment,
          timeout: 600_000,
          maxBuffer: 1024 * 1024,
        },
      );
      process.stdout.write(result.stdout);
    }
    console.log(
      `PASS: native private ${metadataOrigin} ${OPENMINION_VERSION} → ${version} staging/pause/startup/reuse/pin/discard, retained echo conversation and interrupted-intent recovery. Not public-feed/packaged-app certification.`,
    );
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    console.error(error);
    console.error(`Failed isolated acceptance files retained at ${root}`);
    process.exitCode = 1;
  }
}

async function checkPhase() {
  const { app } = await import("electron");
  const { createDesktopSupervisor } = await import("../../dist/src/main/index.js");
  const root = process.env.OPENMINION_UPDATE_TEST_ROOT;
  assert.ok(root, "Run with Node.js to create isolated test roots");
  app.setPath("userData", root);
  assert.equal(app.requestSingleInstanceLock(), true);
  await app.whenReady();
  const store = new DesktopStore(root);
  const supervisor = createDesktopSupervisor(root, store);
  const phase = process.argv[2];
  try {
    if (phase === "intent") {
      assert.equal(store.runtimeState().active.version, version);
      store.stageRuntime(store.runtimeState().active);
      store.beginRuntimeLaunch();
    } else if (phase === "recovery") {
      assert.equal((await supervisor.start()).errorCode, "runtime_recovery_required");
      assert.equal(store.runtimeState().launchIntent.version, version);
    } else {
      assert.equal((await supervisor.start()).state, "ready");
      assert.equal(
        supervisor.runtimeStatus().installedVersion,
        phase === "stage" || phase === "hold" ? OPENMINION_VERSION : version,
      );
      if (phase === "stage") {
        const created = await supervisor.client.create({
          title: "Private runtime update acceptance",
        });
        assert.equal(created.ok, true);
        const sessionId = created.value.sessionId;
        await send(supervisor, sessionId, "runtime lifecycle check");
        await writeFile(join(root, "acceptance-session.txt"), sessionId);
        const metadata = await (
          await fetch(`${metadataOrigin}/pypi/openminion/${version}/json`)
        ).json();
        assert.equal(metadata.info.name, "openminion");
        assert.equal(metadata.info.version, version);
        const wheel = metadata.urls.find(
          (item) => item.filename === `openminion-${version}-py3-none-any.whl`,
        );
        assert.ok(wheel);
        assert.equal(
          new URL(wheel.url).hostname,
          testpypiArgument < 0 ? "files.pythonhosted.org" : "test-files.pythonhosted.org",
        );
        const artifact = {
          filename: wheel.filename,
          url: wheel.url,
          size_bytes: wheel.size,
          sha256: wheel.digests.sha256,
        };
        await new OpenMinionInstallation({ runtimeRoot: join(root, "runtime"), store }).stage({
          artifact,
          reference: {
            runtime_version: version,
            manifest_url: "private-main-owned-acceptance-fixture",
            manifest_sha256: "0".repeat(64),
          },
          record: {
            runtime_version: version,
            distribution: "pypi",
            desktop_compatibility: {
              min_version: app.getVersion(),
              max_version_exclusive: `${Number(app.getVersion().split(".")[0]) + 1}.0.0`,
            },
            pypi: {
              ...artifact,
              package: "openminion",
              version,
              requires_python: wheel.requires_python,
            },
          },
        });
        assert.equal(store.runtimeState().active, null);
        assert.equal(store.runtimeState().pending.version, version);
        assert.equal(supervisor.runtimeStatus().installedVersion, OPENMINION_VERSION);
        await send(supervisor, sessionId, "old runtime remains available during preparation");
        assert.equal((await supervisor.controlRuntime({ action: "pause" })).ok, true);
        assert.equal(store.runtimeState().paused, true);
      } else if (phase === "hold") {
        assert.equal(store.runtimeState().active, null);
        assert.equal(store.runtimeState().pending.version, version);
        assert.equal(store.runtimeState().launchIntent, null);
        assert.equal(supervisor.runtimeStatus().paused, true);
        const sessionId = await readFile(join(root, "acceptance-session.txt"), "utf8");
        await send(supervisor, sessionId, "paused upgrade keeps the old runtime and chat usable");
        assert.equal((await supervisor.controlRuntime({ action: "resume" })).ok, true);
      } else {
        assert.equal(store.runtimeState().active.version, version);
        assert.equal(store.runtimeState().launchIntent, null);
        const sessionId = await readFile(join(root, "acceptance-session.txt"), "utf8");
        const retained = await supervisor.client.load({ sessionId });
        assert.equal(retained.ok, true);
        assert.ok(
          retained.value.messages.some((item) => item.body.includes("runtime lifecycle check")),
        );
        await send(supervisor, sessionId, `runtime lifecycle check after ${phase}`);
        if (phase === "controls") {
          assert.equal((await supervisor.controlRuntime({ action: "pin-installed" })).ok, true);
          assert.equal(store.runtimeState().pin.version, version);
          assert.throws(
            () => store.stageRuntime({ ...store.runtimeState().active, sha256: "f".repeat(64) }),
            /runtime_pin_mismatch/,
          );
          store.stageRuntime(store.runtimeState().active);
          assert.equal((await supervisor.controlRuntime({ action: "pause" })).ok, true);
          assert.equal((await supervisor.controlRuntime({ action: "discard" })).ok, true);
          assert.equal(store.runtimeState().pending, null);
          assert.equal(store.runtimeState().active.version, version);
          assert.equal((await supervisor.controlRuntime({ action: "resume" })).ok, true);
          assert.equal(store.runtimeState().pin.version, version);
          await send(supervisor, sessionId, "pin and discard preserve the active runtime and chat");
        }
      }
    }
    const command = supervisor.getCommandContext();
    await supervisor.stop(true);
    if (command) {
      const result = await runCommand(
        command.executable,
        [...command.args, "daemon", "status", "--json"],
        30_000,
      );
      assert.equal(result.exitCode, 1);
      assert.equal(JSON.parse(result.stdout).pid_alive, false);
    }
    store.close();
    console.log(`PASS: native private runtime update ${phase}`);
    app.quit();
  } catch (error) {
    console.error(error);
    await supervisor.stop(true);
    store.close();
    app.exit(1);
  }
}

async function send(supervisor, sessionId, message) {
  const events = [];
  let completed;
  let timer;
  const terminal = new Promise((resolve, reject) => {
    completed = resolve;
    timer = setTimeout(() => reject(new Error("Echo turn did not complete")), 90_000);
  });
  try {
    const result = await supervisor.client.submit({ sessionId, message }, (event) => {
      events.push(event);
      if (event.kind === "done") completed();
    });
    assert.equal(result.ok, true);
    await terminal;
    assert.ok(
      events.some((event) => event.kind === "response" && event.finalText.includes(message)),
      JSON.stringify(events),
    );
    assert.ok(events.some((event) => event.kind === "done" && event.outcome === "complete"));
  } finally {
    clearTimeout(timer);
  }
}
