import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const temporaryRoot = mkdtempSync(join(tmpdir(), "openminion-identity-electron-"));
const statePath = join(temporaryRoot, "identity-state.json");
const initialYaml = "agent_id: openminion\ndisplay_name: OpenMinion\nmission: Initial\n";
writeFileSync(
  statePath,
  JSON.stringify({
    unsupported: true,
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
    await waitFor("document.querySelector('#identity-status').textContent.includes('release')");
    assert.equal(await evaluate("document.querySelector('#identity-editor').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#identity-runtime').hidden"), false);
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      mkdirSync(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
      writeFileSync(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "identity-unavailable.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await click("identity-runtime");
    assert.equal(await evaluate("document.activeElement.id"), "settings-runtime-button");
    assert.equal(await evaluate("document.querySelector('#settings-runtime').hidden"), false);
    writeFileSync(
      statePath,
      JSON.stringify({
        yaml: initialYaml,
        profileVersion: "profile-v1",
        sourceSha256: "source-v1",
      }),
    );
    await click("settings-identity-button");
    await waitFor("document.querySelector('#identity-yaml').value.includes('mission: Initial')");
    assert.equal(await evaluate("document.querySelector('#identity-editor').hidden"), false);
    assert.equal(
      await evaluate("document.querySelector('#identity-yaml').nextElementSibling.id"),
      "identity-status",
      "Verification and save feedback stays directly below the editor",
    );
    assert.equal(await evaluate("document.querySelector('#identity-runtime').hidden"), true);
    assert.equal(
      await evaluate("document.querySelector('#identity-source').textContent"),
      "Direct YAML",
    );
    assert.equal(
      await evaluate("document.querySelector('#identity-source-status').textContent"),
      "In sync",
    );
    assert.equal(
      await evaluate("document.querySelector('#identity-sidecars').textContent"),
      "In sync",
    );
    assert.equal(
      await evaluate("document.querySelector('#identity-reload').textContent"),
      "Discard draft and refresh source",
    );
    assert.equal(
      await evaluate("document.querySelector('#identity-render-budget').textContent"),
      "42/180 tokens",
    );
    assert.equal(
      await evaluate("document.querySelector('#identity-render-omitted').textContent"),
      "personality.formatting",
    );
    assert.match(
      await evaluate("document.querySelector('#identity-render-warnings').textContent"),
      /non-critical fields omitted/,
    );

    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await click("settings-runtime-button");
      await evaluate(`(() => {
        document.querySelector('.runtime-update-options').open = true;
        const body = document.querySelector('.settings-body');
        body.scrollTop = body.scrollHeight;
      })()`);
      if (width === 760)
        assert.ok(await evaluate("document.querySelector('.settings-body').scrollTop > 0"));
      await click("settings-identity-button");
      await waitFor(
        "document.querySelector('#identity-status').textContent !== 'Loading identity…'",
      );
      assert.equal(
        await evaluate("document.querySelector('.settings-body').scrollTop"),
        0,
        "Each Settings section opens at its heading",
      );
      const editor = await evaluate(`(() => {
        const field = document.querySelector('#identity-yaml');
        const style = getComputedStyle(field);
        const select = getComputedStyle(document.querySelector('#identity-agent'));
        const dialog = document.querySelector('#profile-dialog');
        return {background:style.backgroundColor, fieldBackground:select.backgroundColor,
          padding:parseFloat(style.paddingLeft), overflow:dialog.scrollWidth > dialog.clientWidth};
      })()`);
      assert.equal(editor.background, editor.fieldBackground);
      assert.ok(
        editor.padding >= 8,
        "Identity text has the same readable inset as Settings fields",
      );
      assert.equal(editor.overflow, false);
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        mkdirSync(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        writeFileSync(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `identity-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }

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

    assert.equal(
      await evaluate(`(() => {
      document.querySelector('#identity-verify').click();
      return document.querySelector('#identity-agent').disabled;
    })()`),
      true,
      "The selected agent stays fixed while verification is pending",
    );
    await waitFor("document.querySelector('#identity-status').textContent.includes('valid')");
    assert.equal(await evaluate("document.querySelector('#identity-agent').disabled"), false);
    assert.match(
      await evaluate("document.querySelector('#identity-preview').value"),
      /Verified draft/,
    );
    const savedYaml = `${editedYaml}note: changed after verify\n`;
    await evaluate(`(() => {
    const editor = document.querySelector('#identity-yaml');
    editor.value = ${JSON.stringify(savedYaml)};
    editor.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
    assert.equal(
      await evaluate("document.querySelector('#identity-status').textContent"),
      "Unverified changes.",
    );
    assert.match(
      await evaluate("document.querySelector('#identity-preview').value"),
      /Preview is stale/,
    );
    assert.equal(await evaluate("document.querySelector('#identity-save').disabled"), false);
    assert.equal(
      await evaluate(`(() => {
      document.querySelector('#identity-save').click();
      return document.querySelector('#identity-agent').disabled;
    })()`),
      true,
      "The selected agent stays fixed while saving is pending",
    );
    await waitFor(
      "document.querySelector('#identity-status').textContent.startsWith('Identity saved')",
    );
    const readback = await evaluate("window.openminion.identity.read()");
    assert.equal(await evaluate("document.querySelector('#identity-agent').disabled"), false);
    assert.equal(readback.ok, true);
    assert.equal(readback.value.profiles[0].authoredYaml, savedYaml);

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
    assert.equal(await evaluate("document.querySelector('#identity-agent').disabled"), false);
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
    assert.equal(
      await evaluate(`(() => {
      document.querySelector('#identity-reload').click();
      return document.querySelector('#identity-agent').disabled;
    })()`),
      true,
      "The selected agent stays fixed while reloading",
    );
    await waitFor("document.querySelector('#identity-status').textContent !== 'Loading identity…'");
    assert.equal(await evaluate("document.querySelector('#identity-agent').disabled"), false);
    assert.doesNotMatch(
      await evaluate("document.querySelector('#identity-yaml').value"),
      /discard on explicit reload/,
    );
    writeFileSync(statePath, JSON.stringify({ empty: true }));
    await click("identity-reload");
    await waitFor(
      "document.querySelector('#identity-status').textContent.includes('No identity profiles')",
    );
    assert.equal(await evaluate("document.querySelector('#identity-editor').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#identity-runtime').hidden"), true);
    console.log(
      "Identity Electron check passed: unavailable/empty recovery, native view, draft, verify, save, stale conflict, and reload.",
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
