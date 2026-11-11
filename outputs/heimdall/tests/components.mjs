// Shared-library controls as Heimdall uses them on real screens: Select keyboard use, a radio
// group that skips disabled options, dialog focus trap and focus return, the ⌘K jump palette,
// and overflow + axe on control-heavy pages at three widths.
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "heimdall-components-"));
const source = await fixture();
// Steward modes: "Recommend" is current (so unavailable) between two available options.
source.steward = {
  running: true,
  types: [{ type: "spec.answer", mode: "recommend", autoAllowed: true, stats: {} }],
  decisions: [],
  notes: [],
};
const app = await startHeimdall({ env: {
  HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: "test-components",
  MIMIR_URL: source.url, MIMIR_TOKEN: "fixture-token",
  SINDRI_URL: source.url, SINDRI_TOKEN: "fixture-token",
}, operatorCode: "test-operator" });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.setDefaultTimeout(10000);
const h1 = name => page.getByRole("heading", { level: 1, name, exact: true });
const inDialog = name => page.getByRole("dialog", { name }).evaluate(el => el.contains(document.activeElement));
try {
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-components");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await h1("Overview").waitFor();

  console.log("Select: keyboard");
  await page.goto(app.url + "/activity");
  await h1("Activity").waitFor();
  const eventSource = page.getByRole("combobox", { name: "Event source" });
  await eventSource.focus();
  await page.keyboard.press("Enter");
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  await expect(page.getByRole("option", { name: "All sources" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Mimir" })).toBeFocused();
  await page.keyboard.press("Enter");
  await listbox.waitFor({ state: "hidden" });
  assert.match(await eventSource.innerText(), /Mimir/);
  await expect(eventSource).toBeFocused();
  // Escape closes without changing the value.
  await page.keyboard.press("Space");
  await listbox.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await listbox.waitFor({ state: "hidden" });
  assert.match(await eventSource.innerText(), /Mimir/);
  await expect(eventSource).toBeFocused();

  console.log("Radio group: disabled options");
  await page.goto(app.url + "/connections/access");
  await page.getByLabel("Heimdall operator code", { exact: true }).fill("test-operator");
  await page.getByRole("button", { name: "Unlock controls" }).click();
  await page.getByRole("button", { name: "Session: Operator unlocked" }).waitFor();
  await page.getByLabel("Sindri pairing code", { exact: true }).fill("sindri-code");
  await page.getByRole("button", { name: "Pair approval session" }).click();
  await page.getByRole("main").getByRole("img", { name: "Status: Paired" }).waitFor();
  await page.goto(app.url + "/autonomy/all");
  const modes = page.getByRole("radiogroup", { name: "Mode for Answer specification questions" });
  const radio = name => modes.getByRole("radio", { name, exact: true });
  await radio("Off").waitFor();
  assert.equal(await radio("Recommend").isChecked(), true);
  assert.equal(await radio("Recommend").isDisabled(), true, "the current mode is not offered again");
  assert.equal(await radio("Automatic").isDisabled(), false);
  // Arrow keys skip the disabled option; choosing a mode asks for confirmation first.
  await radio("Off").focus();
  // Radix moves focus a tick after keydown and checks the radio only while the key is down, as it
  // is when a person presses it; Playwright's press() releases at once, so hold it.
  await page.keyboard.down("ArrowRight");
  const command = page.getByRole("dialog", { name: "Change steward mode" });
  await command.waitFor();
  await page.keyboard.up("ArrowRight");
  await command.getByText("Command payload").click();
  assert.match(await command.innerText(), /"mode": "auto"/);

  console.log("Dialog: focus trap and return");
  await command.getByRole("button", { name: "Go back" }).click();
  await command.waitFor({ state: "hidden" });
  assert.equal(source.steward.types[0].mode, "recommend", "nothing was sent");
  await page.goto(app.url + "/");
  await page.getByRole("button", { name: "Build reliable invoice tools" }).click();
  const pause = page.getByRole("dialog").filter({ hasText: "inspector" }).getByRole("button", { name: "Pause mission" });
  await pause.click();
  const pauseDialog = page.getByRole("dialog", { name: "Pause mission" });
  await pauseDialog.waitFor();
  await expect(pauseDialog.getByLabel("Reason", { exact: true })).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await inDialog("Pause mission"), `focus left the dialog after ${i + 1} Tab presses`);
  }
  // Focus may rest on a control whose tooltip is open; the first Escape closes that layer only.
  await page.keyboard.press("Escape");
  if (await pauseDialog.isVisible()) await page.keyboard.press("Escape");
  await pauseDialog.waitFor({ state: "hidden" });
  await expect(pause).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  // "?" opens the shortcuts dialog, which traps focus the same way.
  await page.locator("main h1").focus();
  await page.keyboard.press("?");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await shortcuts.waitFor();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await inDialog("Keyboard shortcuts"));
  }
  await page.keyboard.press("Escape");
  await shortcuts.waitFor({ state: "hidden" });
  await expect(page.locator("main h1")).toBeFocused();

  console.log("Jump palette");
  await page.keyboard.press("Control+k");
  const jump = page.getByRole("combobox", { name: "Jump to" });
  await expect(jump).toBeFocused();
  await jump.fill("Implement integer-cent totals");
  await page.getByRole("option", { name: /Implement integer-cent totals/, selected: true }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Task objective" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "tasks:tsk_demo");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+k");
  await jump.fill("Quality");
  // Enter opens the active option; wait until the filtered list made it active.
  await page.getByRole("option", { name: "Quality & approvals", selected: true }).waitFor();
  await page.keyboard.press("Enter");
  await h1("Quality & approvals").waitFor();

  console.log("Overflow and accessibility");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const path of ["/activity", "/autonomy/all", "/new-work"]) {
      await page.goto(app.url + path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} overflow at ${width}`);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `${path} at ${width}`);
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: library Select keyboard use, radio group skipping disabled options, dialog focus trap and return (command and shortcuts dialogs), jump palette to a task and a page, overflow and axe on control-heavy pages at 390/768/1440");
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
