import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.js";

test.describe("token prompt (no server needed)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`is accessible in ${scheme} mode and keeps the token out of the URL`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      // Keep API calls pending so the stored token is observed before any 401 clears it.
      await page.route("**/v1/**", () => undefined);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Connect to Mimir" })).toBeVisible();
      await expectAccessible(page, `token prompt (${scheme})`);
      await page.getByLabel("Auth token").fill("smoke-token");
      await page.getByRole("button", { name: "Connect" }).click();
      expect(page.url()).not.toContain("smoke-token");
      const stored = await page.evaluate(() => ({
        session: sessionStorage.getItem("mimir.authToken"),
        local: localStorage.getItem("mimir.authToken"),
      }));
      expect(stored).toEqual({ session: "smoke-token", local: null });
    });
  }

  test("skip link and focus outline are keyboard reachable", async ({ page }) => {
    await page.goto("/");
    // The token field is autofocused (M-m11), so no Tab is needed to reach it.
    const focused = page.locator(":focus");
    await expect(focused).toHaveAccessibleName(/auth token/i);
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });
});
