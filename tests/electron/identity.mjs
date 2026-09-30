import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

const temporaryRoot = mkdtempSync(join(tmpdir(), "openminion-identity-electron-"));
const statePath = join(temporaryRoot, "identity-state.json");
const initialYaml = "agent_id: openminion\ndisplay_name: OpenMinion\nmission: Initial\n";
writeFileSync(
  statePath,
  JSON.stringify({
    yaml: initialYaml,
    profileVersion: "profile-v1",
    sourceSha256: "source-v1",
  }),
);
app.setPath("userData", temporaryRoot);
process.env.OPENMINION_DESKTOP_HOME = temporaryRoot;
process.env.OPENMINION_IDENTITY_FIXTURE_STATE = statePath;
const runtimePath = join(temporaryRoot, "openminion-fixture");
process.env.OPENMINION_EXECUTABLE = runtimePath;

const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("Identity Electron check timed out before the window loaded.");
  app.exit(1);
}, 30_000);
await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  let exitCode = 0;
  try {
    const window = await loaded;
    copyFileSync(
      fileURLToPath(new URL("../fixtures/openminion-identity-runtime.mjs", import.meta.url)),
      runtimePath,
    );
    chmodSync(runtimePath, 0o700);
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (condition) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await evaluate(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.error(
        await evaluate(
          "JSON.stringify({status:document.querySelector('#identity-status')?.textContent,value:document.querySelector('#identity-yaml')?.value,metadata:document.querySelector('#identity-metadata')?.textContent})",
        ),
      );
      assert.fail(`Did not settle: ${condition}`);
    };
    const click = async (id) => {
      await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    await waitFor("!document.querySelector('#retry').hidden");
    await click("retry");
    await waitFor("!document.querySelector('#retry').disabled");
    await click("show-settings");
    await waitFor("document.querySelector('#profile-dialog').open");
    await click("settings-identity-button");
    await waitFor("document.querySelector('#identity-yaml').value.includes('mission: Initial')");
    assert.match(
      await evaluate("document.querySelector('#identity-metadata').textContent"),
      /source clean/,
    );

    const editedYaml = `${initialYaml}note: unsaved draft\n`;
    await evaluate(`(() => {
    const editor = document.querySelector('#identity-yaml');
    editor.value = ${JSON.stringify(editedYaml)};
    editor.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
    await click("settings-profiles-button");
    await click("settings-identity-button");
    await waitFor("document.querySelector('#identity-status').textContent !== 'Loading identity…'");
    assert.equal(await evaluate("document.querySelector('#identity-yaml').value"), editedYaml);

    await click("identity-verify");
    await waitFor("document.querySelector('#identity-status').textContent.includes('valid')");
    assert.match(
      await evaluate("document.querySelector('#identity-preview').textContent"),
      /Verified draft/,
    );
    await click("identity-save");
    await waitFor(
      "document.querySelector('#identity-status').textContent.startsWith('Identity saved')",
    );
    const readback = await evaluate("window.openminion.identity.read()");
    assert.equal(readback.ok, true);
    assert.equal(readback.value.profiles[0].authoredYaml, editedYaml);

    writeFileSync(
      statePath,
      JSON.stringify({
        yaml: `${initialYaml}note: external edit\n`,
        profileVersion: "profile-external",
        sourceSha256: "source-external",
      }),
    );
    await evaluate(`(() => {
    const editor = document.querySelector('#identity-yaml');
    editor.value += 'note: stale local edit\\n';
    editor.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
    await click("identity-save");
    await waitFor(
      "document.querySelector('#identity-status').textContent.includes('changed since')",
    );
    await click("settings-profiles-button");
    await click("settings-identity-button");
    await waitFor("document.querySelector('#identity-yaml').value.includes('external edit')");
    assert.doesNotMatch(
      await evaluate("document.querySelector('#identity-yaml').value"),
      /stale local edit/,
    );
    assert.match(
      await evaluate("document.querySelector('#identity-status').textContent"),
      /changed on disk/,
    );
    await evaluate(`(() => {
    const editor = document.querySelector('#identity-yaml');
    editor.value += 'note: discard on explicit reload\\n';
    editor.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
    await click("identity-reload");
    await waitFor("document.querySelector('#identity-status').textContent !== 'Loading identity…'");
    assert.doesNotMatch(
      await evaluate("document.querySelector('#identity-yaml').value"),
      /discard on explicit reload/,
    );
    console.log(
      "Identity Electron check passed: native view, draft, verify, save, stale conflict, and reload.",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(timeout);
    rmSync(temporaryRoot, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
