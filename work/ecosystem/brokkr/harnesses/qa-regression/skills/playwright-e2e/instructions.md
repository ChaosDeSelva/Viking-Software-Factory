# Playwright end-to-end regression tests

End-to-end tests guard user-visible flows. Keep them few, stable and meaningful.

## Always

- Cover each acceptance criterion's main user flow end to end, plus one failure path.
- Locate elements by role, label or test id (`getByRole`, `getByLabel`, `getByTestId`), never by CSS structure.
- Use web-first assertions (`await expect(locator).toBeVisible()`), which wait for the condition.
- Seed test data through an API or fixture and make each test independent of order.
- Run desktop and mobile projects (for example 1280x800 and 390x844) when layout matters.
- Keep traces and screenshots on failure as evidence.

## Never

- Never use fixed `waitForTimeout` sleeps.
- Never depend on production services or the public network in a regression run.
- Never update visual snapshots without a reviewer seeing the diff.

## Verify

- The suite passes three times in a row locally with no retries.
- A deliberately broken build makes the relevant test fail.
