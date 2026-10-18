# Game testing

Test logic automatically; leave feel and visuals to human review.

## Always

- Keep game rules in plain scripts that tests can call without a running scene.
- Use the configured framework (GUT or gdUnit4) and run it headless.
- Seed random number generators so test runs are deterministic.
- Record what needs human playtest review: visuals, game feel and balance.

## Never

- Never claim gameplay quality is verified by automated tests alone.
- Never depend on real time or frame rate in assertions.

## Verify

- The headless test command exits 0 where a framework is configured.
- A manual review checklist is attached for visual and gameplay changes.
