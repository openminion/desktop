import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

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
}, 20000);

await import("../../dist/src/main/bootstrap.js");
void check();

async function check() {
  let exitCode = 0;
  try {
    const window = await loaded;
    const evaluate = (source) => window.webContents.executeJavaScript(source);
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
        "Close task",
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
      await evaluate(
        "document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown'}))",
      );
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
      "Task status",
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
