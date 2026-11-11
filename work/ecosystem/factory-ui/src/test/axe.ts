import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core against a jsdom subtree and asserts no serious/critical violations.
 * jsdom has no layout or computed colors, so `color-contrast` is checked in the Playwright e2e
 * instead; `region` is page-level and also checked there.
 */
export async function expectNoSeriousA11yViolations(node: Element): Promise<void> {
  const result = await axe.run(node, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const serious = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
  expect(serious).toEqual([]);
}
