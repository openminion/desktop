import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard } from "electron";

const temporaryRoot = mkdtempSync(join(tmpdir(), "openminion-electron-check-"));
app.setPath("userData", temporaryRoot);
process.env.OPENMINION_DESKTOP_HOME = temporaryRoot;
process.env.OPENMINION_EXECUTABLE = join(temporaryRoot, "missing-openminion");
const preloadErrors = [];
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.on("preload-error", (_event, _path, error) => {
      preloadErrors.push(error.message);
    });
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("Electron startup check timed out");
  app.exit(1);
}, 30000);

await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  let exitCode = 0;
  try {
    const window = await loaded;
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const settled = () =>
      evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    const waitFor = async (condition) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await evaluate(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.error(
        await evaluate(
          "JSON.stringify({active:document.activeElement?.id,display:document.querySelector('#chat-display')?.value,status:document.querySelector('#chat-display-status')?.textContent,dialog:document.querySelector('#profile-dialog')?.open})",
        ),
      );
      assert.fail(`Did not settle: ${condition}`);
    };
    const key = async (keyCode, modifiers = []) => {
      window.focus();
      window.webContents.focus();
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode,
        modifiers,
      });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await settled();
    };
    const click = async (id) => {
      const point = await evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        element.scrollIntoView({block:'nearest'});
        const bounds = element.getBoundingClientRect();
        return {x:Math.round(bounds.x + bounds.width / 2), y:Math.round(bounds.y + bounds.height / 2)};
      })()`);
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...point,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...point,
      });
      await settled();
    };
    assert.deepEqual(preloadErrors, []);
    assert.equal(await evaluate("typeof window.openminion?.daemon.status"), "function");
    assert.equal(await evaluate("typeof window.require"), "undefined");
    const preferences = window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate("!document.querySelector('#retry').hidden")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate("document.querySelector('#retry').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#composer').disabled"), false);
    assert.equal(
      await evaluate("document.querySelector('#include-screenshot-control').hidden"),
      true,
    );
    assert.equal(await evaluate("document.querySelector('#ask-guidance').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#watch-settings').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#new-session').disabled"), false);
    await evaluate("document.querySelector('#new-session').click()");
    assert.equal(await evaluate("document.activeElement.id"), "composer");
    await evaluate(`
    document.querySelector('#composer').value = 'A local draft while disconnected';
    document.querySelector('#composer').dispatchEvent(new Event('input'));
    document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', metaKey:true}));
  `);
    assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
    await evaluate("document.querySelector('#show-connection').click()");
    assert.equal(await evaluate("document.querySelector('#connection-details').open"), true);
    assert.equal(await evaluate("document.activeElement.id"), "retry");
    await evaluate("document.querySelector('#connection-details').open = false");
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "A local draft while disconnected",
    );
    for (const panel of ["context-panel", "screen-panel", "attachment-menu"]) {
      await evaluate(`document.querySelector('[popovertarget="${panel}"]').click()`);
      assert.equal(
        await evaluate(`document.querySelector('#${panel}').matches(':popover-open')`),
        true,
      );
      await evaluate(`document.querySelector('#${panel}').hidePopover()`);
    }
    const widths = [];
    await evaluate("document.querySelector('#show-commands').click()");
    assert.equal(await evaluate("document.querySelector('#command-menu').hidden"), false);
    await evaluate(
      "document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))",
    );
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "A local draft while disconnected",
    );
    await evaluate(`
      document.querySelector('#composer').value = '/help';
      document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}));
    `);
    assert.equal(await evaluate("!document.querySelector('#command-panel').hidden"), true);
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      "Focus commands — partial integration",
    );
    assert.equal(
      await evaluate("document.querySelector('#command-panel').hasAttribute('popover')"),
      false,
    );
    assert.equal((await evaluate("window.openminion.app.copyText({invalid:true})")).ok, false);
    await click("session-search");
    await window.webContents.insertText("no tasks");
    await settled();
    assert.equal(await evaluate("document.activeElement.id"), "session-search");
    assert.equal(
      await evaluate("document.querySelector('#session-search-count').textContent"),
      "0 of 0 conversations",
    );
    assert.equal(
      await evaluate("document.querySelector('#session-list').textContent.trim()"),
      "Your conversations will appear here.",
    );
    assert.equal(
      await evaluate("document.querySelector('#shell-version').previousElementSibling.textContent"),
      "Electron",
    );
    assert.equal(
      await evaluate("document.querySelector('#runtime-pin-version').placeholder"),
      "Enter a published version",
    );
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1600, 1000],
    ]) {
      window.setContentSize(width, height);
      await settled();
      const searchBounds = await evaluate(`(() => {
        const input = document.querySelector('#session-search');
        const clear = document.querySelector('#clear-session-search');
        const list = document.querySelector('#session-list');
        return { input:input.getBoundingClientRect().toJSON(), clear:clear.getBoundingClientRect().toJSON(), list:list.getBoundingClientRect().toJSON(), overflow:document.documentElement.scrollWidth > innerWidth };
      })()`);
      assert.equal(searchBounds.overflow, false);
      assert.ok(searchBounds.clear.right <= searchBounds.input.right);
      assert.ok(searchBounds.clear.bottom <= searchBounds.input.bottom);
      assert.ok(searchBounds.list.top >= searchBounds.input.bottom);
      assert.ok(searchBounds.list.height > 0);
    }
    await click("clear-session-search");
    assert.equal(await evaluate("document.activeElement.id"), "session-search");
    assert.equal(await evaluate("document.querySelector('#session-search').value"), "");
    await window.webContents.insertText("Again");
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('#session-search').value"), "");
    assert.equal(await evaluate("document.activeElement.id"), "session-search");
    console.log(
      "PASS: native task search typing, empty catalog, Clear/Escape focus and three window sizes.",
    );
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1800, 1000],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const bounds = await evaluate(`(() => {
      const composer = document.querySelector('#composer-form').getBoundingClientRect();
      const result = document.querySelector('#command-panel').getBoundingClientRect();
      const timeline = document.querySelector('#timeline').getBoundingClientRect();
      const conversation = document.querySelector('#conversation');
      const send = document.querySelector('#send').getBoundingClientRect();
      const commands = document.querySelector('#show-commands').getBoundingClientRect();
      const icon = document.querySelector('#show-commands svg').getBoundingClientRect();
      const attachment = document.querySelector('[popovertarget="attachment-menu"]').getBoundingClientRect();
      const screenshot = document.querySelector('.screen-context-button').getBoundingClientRect();
      return {result:result.toJSON(), timeline:timeline.toJSON(), conversationBottom:conversation.getBoundingClientRect().bottom, scrollbar:conversation.offsetWidth-conversation.clientWidth,
        insideConversation:conversation.contains(document.querySelector('#command-panel')),
        resultOverflow:getComputedStyle(document.querySelector('#command-result')).overflowY, composerTop:composer.top, width:composer.width, right:composer.right, bottom:composer.bottom, sendBottom:send.bottom,
        commands:commands.toJSON(), icon:icon.toJSON(), attachment:attachment.toJSON(), screenshot:screenshot.toJSON(),
        overflow:document.documentElement.scrollWidth > innerWidth, viewportWidth:innerWidth, viewportHeight:innerHeight};
    })()`);
      assert.equal(bounds.overflow, false);
      assert.ok(
        bounds.result.top >= bounds.timeline.bottom,
        `Results follow the conversation: ${JSON.stringify(bounds)}`,
      );
      assert.equal(bounds.insideConversation, true, "Results belong to the chat scroll area");
      assert.equal(bounds.resultOverflow, "visible", "Results have no separate scrollbar");
      assert.ok(bounds.conversationBottom <= bounds.composerTop, "Chat cannot cover the composer");
      assert.ok(
        Math.abs(bounds.result.width + bounds.scrollbar - bounds.width) < 1,
        "Results align with the composer, allowing for the chat scrollbar",
      );
      assert.ok(bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight);
      assert.ok(bounds.sendBottom <= bounds.viewportHeight);
      assert.ok(bounds.commands.width >= 30 && bounds.commands.height >= 30);
      assert.ok(
        Math.abs(
          bounds.icon.x + bounds.icon.width / 2 - bounds.commands.x - bounds.commands.width / 2,
        ) < 1,
      );
      assert.ok(
        Math.abs(
          bounds.icon.y + bounds.icon.height / 2 - bounds.commands.y - bounds.commands.height / 2,
        ) < 1,
      );
      assert.ok(bounds.commands.right <= bounds.attachment.left);
      assert.ok(bounds.attachment.right <= bounds.screenshot.left);
      assert.ok(bounds.screenshot.bottom <= bounds.viewportHeight);
      widths.push(bounds.width);
      const screenPanel = await evaluate(`(() => {
        document.querySelector('.screen-context-button').click();
        const panel = document.querySelector('#screen-panel');
        const bounds = panel.getBoundingClientRect();
        panel.hidePopover();
        return {left:bounds.left, right:bounds.right, top:bounds.top, bottom:bounds.bottom,
          width:innerWidth, height:innerHeight};
      })()`);
      assert.ok(
        screenPanel.left >= 0 &&
          screenPanel.right <= screenPanel.width &&
          screenPanel.top >= 0 &&
          screenPanel.bottom <= screenPanel.height,
        "Screen options must fit the resized window",
      );
      assert.equal(
        await evaluate("document.querySelector('#close-session').textContent.trim()"),
        "Close conversation",
      );
      assert.equal(
        await evaluate("document.querySelector('#close-command').textContent.trim()"),
        "Dismiss",
      );
      await evaluate(`
        document.querySelector('#composer').value = 'Keep this draft';
        document.querySelector('#show-commands').click();
      `);
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
      const suggestions = await evaluate(`(() => {
        const menu = document.querySelector('#command-menu');
        const menuBounds = menu.getBoundingClientRect();
        const composer = document.querySelector('#composer-form').getBoundingClientRect();
        const input = document.querySelector('#composer').getBoundingClientRect();
        const conversation = document.querySelector('#conversation').getBoundingClientRect();
        const header = document.querySelector('.chat-heading');
        const title = document.querySelector('#current-title').getBoundingClientRect();
        const actions = document.querySelector('.chat-heading-actions').getBoundingClientRect();
        return {hidden:menu.hidden, position:getComputedStyle(menu).position,
          menu:menuBounds.toJSON(), composer:composer.toJSON(), input:input.toJSON(),
          conversationBottom:conversation.bottom, viewport:innerHeight,
          headerFits:header.scrollWidth <= header.clientWidth && title.right <= actions.left};
      })()`);
      assert.equal(suggestions.hidden, false);
      assert.equal(suggestions.position, "static");
      assert.ok(suggestions.menu.height >= 40, "Suggestions remain readable at the minimum height");
      assert.ok(suggestions.menu.top >= suggestions.composer.top);
      assert.ok(
        suggestions.menu.bottom <= suggestions.input.top,
        "Suggestions cannot cover typing",
      );
      assert.ok(
        suggestions.conversationBottom <= suggestions.composer.top,
        "Suggestions cannot cover chat",
      );
      assert.ok(suggestions.composer.bottom <= suggestions.viewport);
      assert.equal(suggestions.headerFits, true, "Labeled task actions cannot overlap the title");
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        mkdirSync(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        writeFileSync(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `composer-commands-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      await key("Down");
      assert.equal(
        await evaluate("document.querySelector('#command-menu .active').id"),
        "command-option-1",
      );
      await evaluate(
        "document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))",
      );
      assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep this draft");
      assert.equal(await evaluate("document.querySelector('#command-menu').hidden"), true);
    }
    assert.ok(widths[2] > widths[1], "Composer must grow before reaching its reading width");
    assert.ok(widths[2] <= 1001, "Composer must stay readable in a wide window");
    const scrolling = await evaluate(`(() => {
      const conversation = document.querySelector('#conversation');
      const result = document.querySelector('#command-panel');
      const composer = document.querySelector('#composer-form');
      const before = composer.getBoundingClientRect().top;
      document.querySelector('#command-result p').textContent = Array(100).fill('Command detail').join('\\n');
      conversation.scrollTop = 0;
      const top = result.getBoundingClientRect().top;
      conversation.scrollTop = conversation.scrollHeight;
      return {delta:top-result.getBoundingClientRect().top, scroll:conversation.scrollTop,
        composerMoved:composer.getBoundingClientRect().top-before};
    })()`);
    assert.ok(scrolling.scroll > 100, "Long command output scrolls with the chat");
    assert.ok(Math.abs(scrolling.delta - scrolling.scroll) < 1, "Result moves with chat scrolling");
    assert.equal(scrolling.composerMoved, 0, "Long results leave the composer in place");
    await evaluate(`
      document.querySelector('#composer').value='/status';
      document.querySelector('#composer').dispatchEvent(new Event('input'));
      document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}));
    `);
    assert.equal(
      await evaluate("document.querySelector('#command-title').textContent"),
      "Conversation status",
    );
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    if (process.env.OPENMINION_E2E_ARTIFACTS) {
      mkdirSync(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
      writeFileSync(
        join(process.env.OPENMINION_E2E_ARTIFACTS, "command-in-conversation.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }

    await evaluate(
      "document.querySelector('#composer').value='Keep drafting'; document.querySelector('#composer').dispatchEvent(new Event('input'))",
    );
    assert.equal(await evaluate("document.querySelector('#command-panel').hidden"), false);
    await evaluate(
      "document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))",
    );
    assert.equal(await evaluate("document.querySelector('#command-panel').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep drafting");

    // Commands remain usable locally without turning help or completion into a chat send.
    await click("composer");
    await key("k", [process.platform === "darwin" ? "meta" : "control"]);
    assert.equal(await evaluate("document.querySelector('#composer').value"), "/");
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep drafting");
    await key("k", [process.platform === "darwin" ? "meta" : "control"]);
    await evaluate("document.querySelector('#composer').select()");
    await window.webContents.insertText("Replacement draft");
    await settled();
    assert.equal(await evaluate("document.querySelector('#command-menu').hidden"), true);
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Replacement draft");
    const timelineBeforeHelp = await evaluate("document.querySelector('#timeline').textContent");
    for (const [command, usage] of [
      ["/tasks --help", "/tasks [task-id]"],
      ["/skills ?", "/skills [skill-id]"],
      ["/task --help", "/tasks [task-id]"],
    ]) {
      await click("composer");
      await evaluate("document.querySelector('#composer').select()");
      await window.webContents.insertText(command);
      await settled();
      assert.equal(await evaluate("document.querySelector('#composer').value"), command);
      assert.equal(await evaluate("document.querySelector('#command-menu').hidden"), false);
      const hint = await evaluate(
        "document.querySelector('#command-menu .command-usage').textContent",
      );
      assert.ok(hint.includes(usage), `${command} exposes argument syntax: ${hint}`);
      await key("Return");
      await waitFor("document.querySelector('#command-title').textContent === 'Command help'");
      assert.ok(
        (await evaluate("document.querySelector('#command-result p').textContent")).includes(usage),
      );
      assert.equal(
        await evaluate("document.querySelector('#timeline').textContent"),
        timelineBeforeHelp,
      );
      assert.equal(await evaluate("document.querySelector('#profile-dialog').open"), false);
      await click("close-command");
      assert.equal(await evaluate("document.activeElement.id"), "composer");
    }
    await window.webContents.insertText("/tasks pause task-id");
    await settled();
    await key("Tab");
    assert.equal(
      await evaluate("document.querySelector('#composer').value"),
      "/tasks pause task-id",
      "Tab completion preserves arguments already entered",
    );
    assert.equal(await evaluate("document.querySelector('#command-panel').hidden"), true);
    await evaluate("document.querySelector('#composer').select()");
    await window.webContents.insertText("/cls");
    await settled();
    await key("Tab");
    assert.equal(await evaluate("document.querySelector('#composer').value"), "/clear ");
    await evaluate("document.querySelector('#composer').select()");
    await window.webContents.insertText("/status");
    await settled();
    await key("Return");
    await waitFor("document.querySelector('#command-title').textContent === 'Conversation status'");
    const commandReport = await evaluate("document.querySelector('#command-result p').textContent");
    const copyPoint = await evaluate(`(() => {
      const button = document.querySelector('[aria-label="Copy command result"]');
      button.scrollIntoView({block:'nearest'});
      const bounds = button.getBoundingClientRect();
      return {x:Math.round(bounds.x + bounds.width / 2), y:Math.round(bounds.y + bounds.height / 2)};
    })()`);
    for (const type of ["mouseDown", "mouseUp"])
      window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...copyPoint });
    await waitFor(
      "document.querySelector('[aria-label=\"Copy command result\"]').textContent === 'Copied'",
    );
    assert.equal(
      await clipboard.readText(),
      commandReport,
      "Copy includes the report, not its controls",
    );
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('#command-panel').hidden"), true);
    assert.equal(await evaluate("document.activeElement.id"), "composer");
    await window.webContents.insertText("Keep drafting");
    await settled();
    console.log(
      "PASS: native command shortcut/draft replacement, contextual help, alias and argument completion, report Copy and Dismiss focus without a runtime.",
    );

    // Real unavailable-runtime Settings must retain diagnostics and local preferences.
    await click("show-settings");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#close-settings').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#settings-profiles').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#profile-save').disabled"), true);
    assert.notEqual(await evaluate("document.querySelector('#profile-status').textContent"), "");
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep drafting");
    await key("k", [process.platform === "darwin" ? "meta" : "control"]);
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep drafting");
    await click("settings-chat-button");
    assert.equal(await evaluate("document.querySelector('#settings-chat').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#settings-profiles').hidden"), true);
    await evaluate(`
      { const display = document.querySelector('#chat-display');
      display.focus();
      display.value = 'quiet';
      display.dispatchEvent(new Event('change', {bubbles:true})); }
    `);
    await waitFor("document.querySelector('#chat-display-status').textContent.includes('Saved')");
    assert.equal(await evaluate("document.querySelector('#chat-display').value"), "quiet");
    assert.equal((await evaluate("window.openminion.presentation.load()")).value.quietTools, true);
    await click("settings-runtime-button");
    assert.equal(await evaluate("document.querySelector('#settings-runtime').hidden"), false);
    assert.equal(
      await evaluate(
        "document.querySelector('#settings-runtime-button').getAttribute('aria-pressed')",
      ),
      "true",
    );
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
      [1600, 1000],
    ]) {
      window.setContentSize(width, height);
      await evaluate("document.querySelector('.runtime-update-options').open = true");
      await settled();
      const layout = await evaluate(`(() => {
        const dialog = document.querySelector('#profile-dialog');
        const body = dialog.querySelector('.settings-body');
        body.scrollTop = body.scrollHeight;
        const bounds = dialog.getBoundingClientRect();
        const heading = dialog.querySelector('.settings-heading').getBoundingClientRect();
        const close = document.querySelector('#close-settings').getBoundingClientRect();
        const action = document.querySelector('#show-daemon-status').getBoundingClientRect();
        const icon = document.querySelector('#show-daemon-status svg').getBoundingClientRect();
        const last = document.querySelector('#pin-runtime-version');
        last.scrollIntoView({block:'nearest'});
        const pin = last.getBoundingClientRect();
        return {bounds:bounds.toJSON(), heading:heading.toJSON(), close:close.toJSON(), pin:pin.toJSON(),
          action:action.toJSON(), icon:icon.toJSON(),
          width:innerWidth, height:innerHeight, overflow:dialog.scrollWidth > dialog.clientWidth,
          bodyOverflow:getComputedStyle(body).overflowY, bodyBottom:body.getBoundingClientRect().bottom};
      })()`);
      assert.ok(layout.bounds.left >= 0 && layout.bounds.right <= layout.width);
      assert.ok(layout.bounds.top >= 0 && layout.bounds.bottom <= layout.height);
      assert.equal(layout.overflow, false, "Settings has no horizontal overflow");
      assert.equal(layout.bodyOverflow, "auto");
      assert.ok(layout.action.height <= 36, "Runtime action remains compact");
      assert.ok(
        Math.abs(
          layout.icon.y + layout.icon.height / 2 - layout.action.y - layout.action.height / 2,
        ) < 1,
        "Runtime action icon stays centered alongside its label",
      );
      assert.ok(
        layout.heading.top >= 0 && layout.close.bottom <= layout.height,
        "Header and Close remain reachable while scrolling",
      );
      assert.ok(
        layout.pin.bottom <= layout.bodyBottom + 1,
        "Last update action is reachable by scrolling",
      );
      for (let step = 0; step < 12; step += 1) {
        await key("Tab");
        assert.equal(
          await evaluate(
            "Boolean(document.activeElement.closest('#settings-profiles, #settings-chat'))",
          ),
          false,
          "Hidden Settings sections cannot receive keyboard focus",
        );
      }
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        mkdirSync(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        writeFileSync(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `settings-runtime-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    await click("show-daemon-status");
    await waitFor("document.querySelector('#diagnostics-dialog').open");
    await key(",", [process.platform === "darwin" ? "meta" : "control"]);
    assert.equal(await evaluate("document.querySelectorAll('dialog[open]').length"), 2);
    await key("Escape");
    await waitFor("!document.querySelector('#diagnostics-dialog').open");
    assert.equal(await evaluate("document.querySelector('#profile-dialog').open"), true);
    assert.equal(await evaluate("document.activeElement.id"), "show-daemon-status");
    await click("close-settings");
    await waitFor("!document.querySelector('#profile-dialog').open");
    assert.equal(await evaluate("document.activeElement.id"), "show-settings");

    await evaluate("document.querySelector('#connection-details').open = true");
    await click("show-runtime-settings");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#close-settings').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#settings-runtime').hidden"), false);
    await key("Escape");
    assert.equal(await evaluate("document.activeElement.id"), "show-runtime-settings");
    await evaluate("document.querySelector('#composer').focus()");
    await key(",", [process.platform === "darwin" ? "meta" : "control"]);
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#close-settings').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#settings-profiles').hidden"), false);
    await key("Escape");
    assert.equal(await evaluate("document.activeElement.id"), "composer");
    assert.equal(await evaluate("document.querySelector('#composer').value"), "Keep drafting");

    // A renderer reload reads the same real SQLite preference through main/preload.
    const reloaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    window.webContents.reload();
    await reloaded;
    await waitFor("!document.querySelector('#retry').hidden");
    await click("show-settings");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#close-settings').disabled",
    );
    await click("settings-chat-button");
    assert.equal(await evaluate("document.querySelector('#chat-display').value"), "quiet");
    await evaluate(`
      { const display = document.querySelector('#chat-display');
      display.focus();
      display.value = 'normal';
      display.dispatchEvent(new Event('change', {bubbles:true})); }
    `);
    await waitFor("document.querySelector('#chat-display-status').textContent.includes('Saved')");
    assert.equal((await evaluate("window.openminion.presentation.load()")).value.quietTools, false);
    await click("close-settings");
    await evaluate("document.querySelector('#rename-dialog').showModal()");
    await key(",", [process.platform === "darwin" ? "meta" : "control"]);
    assert.equal(
      await evaluate("document.querySelector('#profile-dialog').open"),
      false,
      "Settings shortcut does not compete with another dialog",
    );
    await key("Escape");
    // Real readable configuration with a missing CLI produces a distinct setup-catalog failure.
    writeFileSync(
      join(temporaryRoot, "agents.json"),
      JSON.stringify({
        agents: { openminion: { name: "openminion", provider: "echo" } },
      }),
      { mode: 0o600 },
    );
    const profile = await evaluate("window.openminion.profiles.read()");
    assert.equal(profile.ok, true);
    assert.equal(profile.value.setupRequired, true);
    const presets = await evaluate("window.openminion.profiles.presets()");
    assert.equal(presets.ok, false);
    assert.equal(presets.error.code, "setup_unavailable");
    await click("show-settings");
    await waitFor(
      "document.querySelector('#profile-dialog').open && !document.querySelector('#close-settings').disabled",
    );
    assert.equal(await evaluate("document.querySelector('#settings-profiles').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#setup-fields').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#profile-save').disabled"), true);
    assert.notEqual(await evaluate("document.querySelector('#profile-status').textContent"), "");
    await click("settings-runtime-button");
    assert.equal(await evaluate("document.querySelector('#settings-runtime').hidden"), false);
    await click("settings-chat-button");
    assert.equal(await evaluate("document.querySelector('#settings-chat').hidden"), false);
    await click("close-settings");
    await waitFor("!document.querySelector('#profile-dialog').open");
    console.log(
      "SET-01/03/04/05 passed: profile/setup failure navigation, DOM select change with real SQLite reload, native keyboard/focus and responsive layout.",
    );

    const worker = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: window.webContents.session,
        preload: fileURLToPath(new URL("../../dist/src/preload/capture.cjs", import.meta.url)),
      },
    });
    worker.webContents.on("preload-error", (_event, _path, error) =>
      preloadErrors.push(error.message),
    );
    await worker.loadURL("openminion://app/capture-worker.html");
    assert.equal(
      await worker.webContents.executeJavaScript(
        "typeof window.openminionCaptureBridge?.configure",
      ),
      "function",
    );
    assert.equal(
      await worker.webContents.executeJavaScript("typeof window.openminionCaptureWorker?.start"),
      "function",
    );
    assert.deepEqual(preloadErrors, []);
    worker.destroy();
    console.log(
      "Electron check passed: real app/preloads, isolated bridge, offline draft, slash commands, popovers, and fluid composer.",
    );
    clearTimeout(timeout);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    exitCode = 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
