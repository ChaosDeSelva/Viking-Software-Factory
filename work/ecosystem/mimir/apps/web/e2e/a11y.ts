import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Zero axe violations at every impact level (including color contrast) on the current page. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = result.violations.map(
    (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(violations, `axe on ${label}`).toEqual([]);
}
