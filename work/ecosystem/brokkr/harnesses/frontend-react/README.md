# frontend-react

React + TypeScript frontend engineering harness with accessibility, responsive and browser verification gates.

- Version: 1.0.0
- Task types: frontend, ui, react
- Required skills: react-architecture, typescript, accessibility, responsive-design
- Optional skills: component-reuse, playwright, visual-qa, tailwind, performance, component-design

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `typecheck` | `pnpm exec tsc --noEmit` | yes | fileExists: tsconfig.json |
| `lint` | `pnpm run lint` | no | scriptExists: lint |
| `unit` | `pnpm test` | yes | scriptExists: test |
| `build` | `pnpm run build` | no | scriptExists: build |
| `screenshot-desktop` | `pnpm exec playwright test --project=desktop-1280x800 --grep-invert=@a11y` | yes | anyFileExists: playwright.config.{ts,mts,js,mjs} |
| `screenshot-mobile` | `pnpm exec playwright test --project=mobile-390x844 --grep-invert=@a11y` | yes | anyFileExists: playwright.config.{ts,mts,js,mjs} |
| `axe` | `pnpm exec playwright test --project=desktop-1280x800 --grep=@a11y` | yes | anyFileExists: playwright.config.{ts,mts,js,mjs} |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/frontend-react`.
