import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.js";

/**
 * Every screen rendered from the real routes against a static fixture client (e2e/harness),
 * checked with axe (WCAG 2.1 AA incl. color contrast) in light and dark mode.
 */
const SCREENS: readonly [string, string, RegExp][] = [
  ["/", "overview", /Overview/],
  ["/projects", "projects", /Projects/],
  ["/missions", "missions", /Missions/],
  ["/missions/:mission", "mission detail", /Mission: Add login/],
  ["/crews", "crews", /Crews/],
  ["/crews/:crew", "crew detail", /Crew: default/],
  ["/agents/:session", "agent inspector", /Agent implementer/],
  ["/reviews", "reviews", /Reviews/],
  ["/activity", "activity", /Activity/],
  ["/settings", "settings", /Settings/],
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    for (const [path, label, heading] of SCREENS) {
      test(`${label} has no serious axe violations`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("mimir.theme", theme), scheme);
        await page.goto(`/e2e/harness/index.html?path=${encodeURIComponent(path)}`);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.getByTestId("connection")).toHaveText(/Live/);
        await expectAccessible(page, `${label} (${scheme})`);
      });
    }
  });
}

test("mission detail tabs are each accessible", async ({ page }) => {
  await page.goto(`/e2e/harness/index.html?path=${encodeURIComponent("/missions/:mission")}`);
  for (const tab of ["Plan", "Timeline", "Agents", "Files", "Tests", "Artifacts", "Costs"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await expectAccessible(page, `mission tab ${tab}`);
  }
});

test("keyboard shortcuts and help dialog work in a real browser", async ({ page }) => {
  await page.goto(`/e2e/harness/index.html?path=/`);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("m");
  await expect(page.getByRole("heading", { level: 1, name: "Missions" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page.getByRole("heading", { level: 1, name: "Reviews" })).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expectAccessible(page, "help dialog");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
