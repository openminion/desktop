// Drive an unmodified packaged app against its real public runtime feed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const arguments_ = process.argv.slice(2);
const [executable, desktopVersion] = arguments_;
const qualificationIndex = arguments_.indexOf("--qualify-binary");
const qualification =
  qualificationIndex < 0
    ? null
    : {
        releaseTag: arguments_[qualificationIndex + 1],
        releaseId: arguments_[qualificationIndex + 2],
        packagePath: arguments_[qualificationIndex + 3],
        evidencePath: arguments_[qualificationIndex + 4],
        desktopCommit: arguments_[qualificationIndex + 5],
      };
const targetVersion = qualification ? undefined : arguments_[2];
assert.ok(executable && isAbsolute(executable), "Provide the absolute packaged executable path");
assert.match(desktopVersion ?? "", /^\d+\.\d+\.\d+$/);
if (targetVersion) assert.match(targetVersion, /^\d+\.\d+\.\d+$/);
if (qualification) {
  assert.notEqual(desktopVersion, "0.0.0", "Qualification requires a released Desktop version");
  assert.match(qualification.releaseTag ?? "", /^runtime-v\d+\.\d+\.\d+-[A-Za-z0-9._-]+$/);
  assert.match(qualification.releaseId ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.ok(
    qualification.packagePath && isAbsolute(qualification.packagePath),
    "Provide the absolute packaged Desktop artifact path",
  );
  assert.ok(
    qualification.evidencePath && isAbsolute(qualification.evidencePath),
    "Provide an absolute evidence output path",
  );
  assert.match(qualification.desktopCommit ?? "", /^[a-f0-9]{40}$/);
  await access(qualification.packagePath);
}
await access(executable);
const root = await mkdtemp(join(tmpdir(), "desktop-packaged-runtime-"));
const electronApi =
  "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
let connection;
let sessionId;
let passed = false;
try {
  connection = await launch();
  await connection.ready();
  const identity = await connection.main(
    `(() => { const {app} = ${electronApi}; return {version:app.getVersion(), path:app.getAppPath(), packaged:app.isPackaged}; })()`,
  );
  assert.equal(identity.packaged, true);
  assert.equal(identity.version, desktopVersion);
  assert.ok(identity.path.endsWith("app.asar"), "Acceptance requires the packaged archive");
  const digest = createHash("sha256")
    .update(await readFile(identity.path))
    .digest("hex");
  console.log(`Packaged Desktop ${desktopVersion}, app.asar SHA-256 ${digest}`);
  await dismissSetup();
  await send("runtime lifecycle check");
  const sessions = await connection.renderer("window.openminion.sessions.list({})");
  assert.equal(sessions.ok, true);
  assert.equal(sessions.value.sessions.length, 1);
  sessionId = sessions.value.sessions[0].sessionId;
  const before = await connection.renderer("window.openminion.runtime.status()");
  assert.equal(before.source, "pypi");
  if (qualification) {
    await qualifyBinaryRuntime(before, digest);
  } else {
    const discovered = await until(async () => {
      const status = await connection.renderer("window.openminion.runtime.status()");
      return ["available", "current", "check_failed"].includes(status.phase) ? status : null;
    });
    assert.notEqual(discovered.phase, "check_failed", "Public startup discovery must succeed");
    await connection.renderer(
      "document.querySelector('#show-settings').click(); document.querySelector('#settings-runtime-button').click()",
    );
    await connection.renderer("document.querySelector('#check-runtime-update').click()");
    await until(() =>
      connection.renderer("!document.querySelector('#check-runtime-update').disabled"),
    );
    const checked = await connection.renderer("window.openminion.runtime.status()");
    if (!targetVersion) {
      assert.equal(checked.phase, "current");
      assert.equal(checked.availableVersion, null);
      assert.equal(checked.installedVersion, before.installedVersion);
      await stop();
      await assertTranscript(["runtime lifecycle check"]);
      console.log(
        "PASS: packaged app startup/manual public checks offer no eligible update; chat works. Not upgrade certification.",
      );
    } else {
      assert.equal(discovered.availableVersion, targetVersion, "Startup must discover the target");
      assert.equal(checked.phase, "available", "A compatible public record is required");
      assert.equal(checked.availableVersion, targetVersion);
      await exerciseUpgrade(before.installedVersion, targetVersion);
      console.log(
        `PASS: packaged public ${before.installedVersion} → ${targetVersion} discovery/preparation/startup activation and same-chat replies.`,
      );
    }
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(identity.path))
      .digest("hex"),
    digest,
    "Packaged archive must not change during acceptance",
  );
  passed = true;
} catch (error) {
  console.error(error);
  console.error(`Isolated acceptance evidence retained at ${root}`);
  process.exitCode = 1;
} finally {
  await stop();
  if (passed) await rm(root, { recursive: true, force: true });
}

async function launch() {
  const environment = { ...process.env, OPENMINION_DESKTOP_HOME: root };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.OPENMINION_EXECUTABLE;
  delete environment.OPENMINION_PYPI_EXECUTABLE;
  const child = spawn(executable, ["--inspect=127.0.0.1:0"], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const debuggerUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Packaged app inspector unavailable; close the isolated app manually")),
      30_000,
    );
    let output = "";
    child.stderr.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
      const match = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Packaged app exited before inspector connection"));
    });
  });
  const socket = new WebSocket(debuggerUrl);
  await once(socket, "open");
  let nextId = 0;
  let bootstrapLoaded = false;
  const requests = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (
      message.method === "Debugger.scriptParsed" &&
      message.params.url.endsWith("/app.asar/dist/src/main/bootstrap.js")
    )
      bootstrapLoaded = true;
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result.exceptionDetails)
      request.reject(
        new Error(
          `${JSON.stringify(message.error ?? message.result.exceptionDetails)}; evaluation: ${request.expression}`,
        ),
      );
    else request.resolve(message.result.result.value);
  });
  socket.addEventListener("close", () => {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Inspector closed"));
    }
    requests.clear();
  });
  socket.send(JSON.stringify({ id: 0, method: "Debugger.enable" }));
  const main = (expression, awaitPromise = false) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("Packaged app evaluation timed out"));
      }, 30_000);
      requests.set(id, { resolve, reject, timer, expression });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: `globalThis.__packagedRuntimeEvaluation = (${expression})`,
            awaitPromise,
            returnByValue: true,
          },
        }),
      );
    });
  const renderer = (expression) =>
    main(
      `${electronApi}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)})`,
      true,
    );
  const quit = async () => {
    const exited = once(child, "exit");
    try {
      await until(() => bootstrapLoaded);
      await main(`void setImmediate(() => ${electronApi}.app.quit())`);
    } finally {
      socket.close();
    }
    await Promise.race([
      exited,
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error("Packaged app did not quit; close the isolated app manually");
      }),
    ]);
  };
  const ready = async () => {
    await until(() => bootstrapLoaded);
    await until(() => main(`${electronApi}.app.isReady()`));
    await until(() =>
      main(
        `(() => { const window = ${electronApi}.BrowserWindow.getAllWindows()[0]; return window && !window.webContents.isLoading(); })()`,
      ),
    );
    await until(
      () => renderer("document.querySelector('#connection-label')?.textContent === 'Connected'"),
      180_000,
    );
  };
  return { main, renderer, quit, ready };
}

async function qualifyBinaryRuntime(before, appAsarSha256) {
  const prepared = await binaryQualificationOffer(
    qualification.releaseTag,
    qualification.releaseId,
  );
  assert.notEqual(
    before.installedVersion,
    prepared.offer.record.runtime_version,
    "Qualification must exercise an upgrade",
  );
  const appPath = await connection.main(
    `(() => { const {app} = ${electronApi}; return app.getAppPath(); })()`,
  );
  const installationUrl = pathToFileURL(join(appPath, "dist/src/main/installation.js")).href;
  const storeUrl = pathToFileURL(join(appPath, "dist/src/main/desktop-store.js")).href;
  await connection.main(
    `(async () => {
      const [{ OpenMinionInstallation }, { DesktopStore }] = await Promise.all([
        import(${JSON.stringify(installationUrl)}),
        import(${JSON.stringify(storeUrl)})
      ]);
      const store = new DesktopStore(${JSON.stringify(root)});
      try {
        return await new OpenMinionInstallation({
          runtimeRoot: ${JSON.stringify(join(root, "runtime"))},
          store,
          desktopVersion: ${JSON.stringify(desktopVersion)}
        }).stage(${JSON.stringify(prepared.offer)});
      } finally {
        store.close();
      }
    })()`,
    true,
  );
  assert.equal((await connection.renderer("window.openminion.runtime.status()")).phase, "pending");
  await exerciseUpgrade(before.installedVersion, prepared.offer.record.runtime_version);
  const evidence = {
    schema_version: 1,
    kind: "openminion-binary-runtime-target-qualification",
    runtime: {
      version: prepared.offer.record.runtime_version,
      release_tag: qualification.releaseTag,
    },
    desktop: { version: desktopVersion, source_commit: qualification.desktopCommit },
    compatibility: prepared.offer.record.desktop_compatibility,
    target: {
      platform: prepared.artifact.platform,
      arch: prepared.artifact.arch,
      package_sha256: await sha256File(qualification.packagePath),
      app_asar_sha256: appAsarSha256,
      cli_sha256: prepared.artifact.cli.sha256,
      daemon_sha256: prepared.artifact.daemon.sha256,
      verification_id: prepared.artifact.verification_id,
      result: "passed",
      checks: [
        "native_trust",
        "old_runtime_reply",
        "owned_daemon_shutdown",
        "packaged_startup",
        "prepare_update",
        "runtime_integrity",
        "same_chat_reply",
        "startup_activation",
      ],
    },
    completed_at: new Date().toISOString(),
  };
  await writeFile(qualification.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    `PASS: packaged private binary qualification ${before.installedVersion} → ${prepared.offer.record.runtime_version}; evidence ${qualification.evidencePath}`,
  );
}

async function exerciseUpgrade(installedVersion, nextVersion) {
  assert.notEqual(installedVersion, nextVersion, "Acceptance must exercise an upgrade");
  assert.equal(
    (await connection.renderer("window.openminion.runtime.status()")).installedVersion,
    installedVersion,
  );
  await send("old runtime remains available during preparation");
  await stop();
  await assertTranscript([
    "runtime lifecycle check",
    "old runtime remains available during preparation",
  ]);
  connection = await launch();
  await connection.ready();
  await dismissSetup();
  assert.equal(
    (await connection.renderer("window.openminion.runtime.status()")).installedVersion,
    nextVersion,
  );
  const retained = await connection.renderer(
    `window.openminion.sessions.load({sessionId:${JSON.stringify(sessionId)}})`,
  );
  assert.equal(retained.ok, true);
  assert.ok(
    retained.value.messages.some(
      (message) => message.role === "assistant" && message.body.includes("runtime lifecycle check"),
    ),
  );
  await connection.renderer("document.querySelector('#session-list .session-item').click()");
  await until(() => connection.renderer("document.querySelector('.message.assistant') !== null"));
  await send("runtime lifecycle check after update");
  const after = await connection.renderer("window.openminion.sessions.list({})");
  assert.equal(after.ok, true);
  assert.deepEqual(
    after.value.sessions.map((session) => session.sessionId),
    [sessionId],
  );
  await stop();
  await assertTranscript([
    "runtime lifecycle check",
    "old runtime remains available during preparation",
    "runtime lifecycle check after update",
  ]);
}

async function binaryQualificationOffer(releaseTag, releaseId) {
  const response = await fetch(
    `https://api.github.com/repos/openminion/runtime/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  assert.equal(response.ok, true, `Runtime Release lookup failed: ${response.status}`);
  const release = await response.json();
  assert.equal(release.tag_name, releaseTag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal(release.immutable, true);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const candidate = await releaseJson(assets.get("candidate.json"));
  const verification = await releaseJson(assets.get("verification.json"));
  const version = candidate.runtime_version;
  assert.equal(releaseTag, `runtime-v${version}-${releaseId}`);
  assert.equal(candidate.schema_version, 1);
  assert.equal(candidate.product, "openminion");
  assert.equal(candidate.distribution, "binary");
  assert.equal(candidate.channel, "stable");
  assert.equal(candidate.promotion_status, "candidate");
  const compatibility = candidate.desktop_compatibility;
  assert.ok(compatibility);
  assert.equal(versionInRange(desktopVersion, compatibility), true);
  const artifact = candidate.artifacts.find(
    (item) => item.platform === process.platform && item.arch === process.arch,
  );
  assert.ok(artifact, `No candidate for ${process.platform}-${process.arch}`);
  const identity = `${artifact.platform}-${artifact.arch}`;
  assert.equal(verification.schema_version, 1);
  const native = verification.targets[identity];
  assert.equal(native.result, "passed");
  assert.match(native.verification_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const promoted = { ...artifact, verification_id: native.verification_id };
  for (const role of ["cli", "daemon"]) {
    const expected = artifact[role];
    const asset = assets.get(expected.filename);
    assert.ok(asset, `Runtime Release lacks ${expected.filename}`);
    assert.equal(asset.size, expected.size_bytes);
    assert.equal(asset.digest, `sha256:${expected.sha256}`);
    promoted[role] = { ...expected, url: asset.browser_download_url };
  }
  const record = {
    schema_version: 1,
    product: "openminion",
    distribution: "binary",
    channel: "stable",
    promotion_status: "promoted",
    runtime_version: version,
    release_id: releaseId,
    published_at: release.published_at,
    source_commit: candidate.source_commit,
    release_notes_url: candidate.release_notes_url,
    desktop_compatibility: compatibility,
    artifacts: [promoted],
  };
  return {
    artifact: promoted,
    offer: {
      record,
      reference: {
        runtime_version: version,
        manifest_url: `https://github.com/openminion/runtime/releases/tag/${releaseTag}`,
        manifest_sha256: "0".repeat(64),
      },
      artifact: promoted,
    },
  };
}

async function releaseJson(asset) {
  assert.ok(asset?.browser_download_url, "Runtime Release lacks publication evidence");
  const response = await fetch(asset.browser_download_url);
  assert.equal(response.ok, true, `Runtime evidence download failed: ${response.status}`);
  return response.json();
}

function versionInRange(version, bounds) {
  const parts = (value) => value.split(".").map(Number);
  const compare = (left, right) => {
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };
  return (
    compare(version, bounds.min_version) >= 0 && compare(version, bounds.max_version_exclusive) < 0
  );
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function until(condition, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(200);
  }
  throw new Error("Packaged runtime acceptance condition timed out");
}

async function dismissSetup() {
  await until(() =>
    connection.renderer(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#setup-demo').disabled",
    ),
  );
  await connection.renderer("document.querySelector('#setup-demo').click()");
  await until(() => connection.renderer("!document.querySelector('#profile-dialog').open"));
}

async function send(message) {
  await connection.renderer(
    `document.querySelector('#composer').value=${JSON.stringify(message)}; document.querySelector('#composer').dispatchEvent(new Event('input')); document.querySelector('#send').click()`,
  );
  await until(() =>
    connection.renderer(
      `[...document.querySelectorAll('.message.assistant .message-body')].some(node => node.textContent.includes(${JSON.stringify(message)})) && document.querySelector('#cancel').hidden`,
    ),
  );
}

async function stop() {
  const running = connection;
  connection = null;
  if (running) await running.quit();
}

async function assertTranscript(messages) {
  const database = new DatabaseSync(join(root, "desktop.sqlite"), { readOnly: true });
  const state = JSON.parse(
    database.prepare("SELECT runtime_state FROM installation WHERE id = 1").get().runtime_state,
  );
  database.close();
  assert.equal(state.launchIntent, null);
  const cli =
    state.active?.executable ??
    join(
      root,
      "runtime",
      "python",
      process.platform === "win32" ? "Scripts/openminion.exe" : "bin/openminion",
    );
  const args = [
    "--home-root",
    root,
    "--data-root",
    join(root, "data"),
    "--config",
    join(root, "agents.json"),
  ];
  const status = await promisify(execFile)(cli, [...args, "daemon", "status", "--json"], {
    timeout: 30_000,
  }).catch((error) => {
    assert.equal(error.code, 1);
    return error;
  });
  assert.equal(
    JSON.parse(status.stdout).pid_alive,
    false,
    "Normal packaged quit must stop its owned daemon",
  );
  const transcript = await promisify(execFile)(
    cli,
    [...args, "export", "transcript", "--session-id", sessionId, "--format", "jsonl"],
    { timeout: 30_000 },
  );
  const replies = transcript.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === "message" && ["outbound", "assistant"].includes(row.role));
  assert.equal(replies.length, messages.length, "Canonical transcript must have no replayed reply");
  for (const [index, message] of messages.entries())
    assert.ok(replies[index].body.includes(message));
}
