# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: frontend-react

Skills: react-architecture, typescript, accessibility, responsive-design

Checks that must pass before completion:

- `typecheck`: `pnpm exec tsc --noEmit` (when fileExists tsconfig.json)
- `lint`: `pnpm run lint` (when scriptExists lint)
- `unit`: `pnpm test` (when scriptExists test)
- `build`: `pnpm run build` (when scriptExists build)
- `screenshot-desktop`: `pnpm exec playwright test --project=desktop-1280x800 --grep-invert=@a11y` (when anyFileExists playwright.config.{ts,mts,js,mjs})
- `screenshot-mobile`: `pnpm exec playwright test --project=mobile-390x844 --grep-invert=@a11y` (when anyFileExists playwright.config.{ts,mts,js,mjs})
- `axe`: `pnpm exec playwright test --project=desktop-1280x800 --grep=@a11y` (when anyFileExists playwright.config.{ts,mts,js,mjs})

Do not report completion without the exit codes of these checks.
