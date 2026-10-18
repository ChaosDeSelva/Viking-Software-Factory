# Contributing

Use Node 25+ and the pnpm version pinned in package.json. Install with `pnpm install --frozen-lockfile`, then run `pnpm build`, `pnpm test`, `pnpm test:e2e` and `pnpm test:components`. Browser checks require Playwright Chromium. Source integration tests additionally require built Mimir and Sindri checkouts in the documented local ecosystem layout.

Keep service ownership intact. UI components belong in `apps/web/src/components`; use the Tailwind design tokens and accessible primitives. A displayed success must come from a source receipt or verification artifact. Include regression coverage for state transitions and control behavior, and screenshots for visual changes. Record which tests use fixtures and which use actual services.

Do not commit tokens, pairing codes, personal task history, runtime databases, generated agent output, or machine specific paths. Preserve upstream attribution when adapting code. Discuss substantial API or ownership changes before implementing them. Contributions are under the project's Apache-2.0 license.
