# Playwright browser tests

Browser tests prove user-visible behavior. Make them deterministic.

## Always

- Locate elements by role, label or test id (`getByRole`, `getByLabel`, `getByTestId`).
- Rely on web-first assertions (`expect(locator).toBeVisible()`) that auto-wait.
- Define projects named `desktop-1280x800` and `mobile-390x844` with those viewports.
- Tag accessibility tests `@a11y` and run axe on each changed page.
- Isolate tests: own data, no order dependence, mocked or seeded network.
- Disable animations and freeze time for screenshots.

## Never

- Never use fixed `waitForTimeout` sleeps.
- Never select by brittle CSS chains or nth-child positions.
- Never update screenshot baselines without reviewing the diff.
- Never call external services from tests.

## Verify

- `pnpm exec playwright test` passes in both projects with zero retries needed.
- Re-running twice produces identical results (no flakes).
