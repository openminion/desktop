import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

// Real renderer and pointer/focus behavior; explicit sample data, no provider calls.
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
const timeout = setTimeout(() => {
  console.error("Message action UI test timed out");
  app.exit(1);
}, 30000);
await import("../../scripts/preview.mjs");
void check();
async function check() {
  try {
    const window = await loaded;
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.insertCSS(".message-actions { transition: none !important; }");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await evaluate("!!document.querySelector('.message-actions .message-copy')")) break;
      await settle();
    }
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      app.focus({ steal: true });
      window.focus();
      window.webContents.focus();
      window.setContentSize(width, height);
      await settle();
      await evaluate("document.activeElement.blur()");
      window.webContents.sendInputEvent({ type: "mouseLeave", x: 2, y: 2 });
      await settle();
      const before = await evaluate(`(() => {
      const row = document.querySelector('.message-actions');
      const message = row.closest('.message');
      const time = row.querySelector('time');
      return {opacity:getComputedStyle(row).opacity, height:message.getBoundingClientRect().height,
        message:message.getBoundingClientRect().toJSON(), datetime:time.dateTime, time:time.textContent,
        overflow:document.documentElement.scrollWidth > innerWidth, hover:message.matches(':hover'), focus:message.matches(':focus-within'), hoverNone:matchMedia('(hover: none)').matches};
    })()`);
      assert.equal(before.opacity, "0", JSON.stringify(before));
      assert.equal(before.overflow, false);
      assert.ok(before.time.length > 0);
      assert.ok(Number.isFinite(Date.parse(before.datetime)));
      const hover = {
        type: "mouseMove",
        x: Math.round(before.message.x + 12),
        y: Math.round(before.message.y + 12),
      };
      window.webContents.sendInputEvent({ ...hover, type: "mouseEnter" });
      window.webContents.sendInputEvent(hover);
      await settle();
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.message-actions')).opacity"),
        "1",
      );
      assert.equal(
        await evaluate("document.querySelector('.message').getBoundingClientRect().height"),
        before.height,
      );
      const button = await evaluate(`(() => {
      const button = document.querySelector('.message-actions .message-copy');
      const bounds = button.getBoundingClientRect();
      const icon = getComputedStyle(button, '::before');
      return {width:bounds.width, height:bounds.height, border:getComputedStyle(button).borderWidth,
        icon:icon.borderStyle, iconWidth:icon.width, iconHeight:icon.height,
        label:button.getAttribute('aria-label')};
    })()`);
      assert.equal(button.width, 28);
      assert.equal(button.height, 28);
      assert.equal(button.border, "0px");
      assert.equal(button.iconWidth, "10px");
      assert.equal(button.iconHeight, "12px");
      assert.equal(button.icon, "solid");
      assert.equal(button.label, "Copy message");
      window.webContents.sendInputEvent({ type: "mouseLeave", x: 2, y: 2 });
      await settle();
      assert.equal(
        await evaluate(`(() => {
          const button = document.querySelector('.message-actions .message-copy');
          button.focus();
          return document.activeElement === button;
        })()`),
        true,
      );
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.message-actions')).opacity"),
        "1",
      );
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await mkdir(process.env.OPENMINION_E2E_ARTIFACTS, { recursive: true });
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `message-actions-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    await evaluate("document.querySelector('.message-actions .message-copy').click()");
    await settle();
    assert.equal(
      await evaluate(
        "document.activeElement === document.querySelector('.message-actions .message-copy')",
      ),
      true,
      "Copy feedback keeps keyboard focus on the message action",
    );
    assert.equal(
      await evaluate("getComputedStyle(document.querySelector('.message-actions')).opacity"),
      "1",
      "Copy feedback remains visible without pointer hover",
    );
    assert.equal(
      await evaluate("document.querySelector('.message-actions .message-copy').dataset.copyState"),
      "error",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.message-actions .message-copy').getAttribute('aria-label')",
      ),
      "Copy failed",
    );
    for (const [width, height] of [
      [760, 560],
      [1180, 800],
    ]) {
      window.setContentSize(width, height);
      await evaluate(`(() => {
        const block = document.querySelector('.code-block');
        block.scrollIntoView({block: 'center'});
        block.querySelector('pre').focus();
      })()`);
      await settle();
      const code = await evaluate(`(() => {
        const block = document.querySelector('.code-block');
        const pre = block.querySelector('pre');
        const copy = block.querySelector('button');
        return {
          focused: document.activeElement === pre,
          whitespace: getComputedStyle(pre).whiteSpace,
          language: block.querySelector('.code-header span').textContent,
          label: copy.getAttribute('aria-label'),
          width: copy.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      })()`);
      assert.equal(code.focused, true);
      assert.equal(code.whitespace, "pre");
      assert.equal(code.language, "python");
      assert.equal(code.label, "Copy code");
      assert.equal(code.width, 28);
      assert.equal(code.overflow, false);
      if (width === 760) {
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
        await settle();
        assert.ok(await evaluate("document.querySelector('.code-block pre').scrollLeft > 0"));
      }
      if (process.env.OPENMINION_E2E_ARTIFACTS) {
        await writeFile(
          join(process.env.OPENMINION_E2E_ARTIFACTS, `code-block-${width}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    await evaluate("document.querySelector('.code-header button').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await settle();
    assert.equal(
      await evaluate("document.querySelector('.code-header button').getAttribute('aria-label')"),
      "Copy failed",
    );
    assert.equal(
      await evaluate("document.activeElement === document.querySelector('.code-header button')"),
      true,
      "Copy code retains keyboard focus after clipboard failure",
    );
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(
      await evaluate("document.activeElement === document.querySelector('.code-header button')"),
      true,
      "Restoring the Copy action does not move keyboard focus",
    );
    assert.equal(
      await evaluate("document.querySelector('.code-header button').getAttribute('aria-disabled')"),
      "false",
    );
    console.log(
      "PASS: code headers, keyboard access, compact Copy and responsive layout; preview clipboard denial is visible.",
    );
    console.log(
      "PASS: copy icon and local message time appear on hover and keyboard focus; no layout shift or overflow at two sizes; clipboard error feedback works (preview intentionally disables clipboard).",
    );
    clearTimeout(timeout);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}
