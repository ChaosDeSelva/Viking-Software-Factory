# @factory/ui

The shared React 19 + Tailwind v4 component library for the factory web apps (Sindri, Mimir, Heimdall
and Skidbladnir). It contains tokens, the AppShell, layout primitives, controls, data display, the
status map, Docs and the Guide chat.

## Use it

Install the packed tarball the same way the apps vendor Brokkr:

```json
"@factory/ui": "file:vendor/factory/factory-ui-0.1.1.tgz"
```

`react` and `react-dom` (^19.3) are peer dependencies.

In the app's main CSS file:

```css
@import "tailwindcss";
@import "@factory/ui/styles.css";
```

`styles.css` is Tailwind source, so the app's Tailwind compiles it. Its `@source "."` scans the
package's `dist`, which emits the classes the components use. It gives the app:

- semantic utilities: `bg-surface`, `bg-canvas`, `bg-sunken`, `text-muted`, `text-fg`,
  `border-line`, `text-danger-fg`, `gap-section`, `gap-group`, `p-card`, `h-control-md`, …;
- the type scale (`text-xs` … `text-3xl`);
- light and dark tokens. Dark applies through `<html data-theme="dark">`, or through
  `prefers-color-scheme` unless `data-theme="light"` is set;
- a brand focus ring;
- reduced-motion handling.

To avoid a theme flash, inline `themeScript` in `<head>`.

```tsx
import { AppShell, Page, PageHeader, StatusPill, LinkProvider } from "@factory/ui";
```

- **Routing:** wrap the app in `<LinkProvider render={(p) => <RouterLink to={p.href} {...p} />}>`.
  Every link the library draws then goes through your router.
- **Glossary:** wrap the app in `<GlossaryProvider entries={glossary}>`, using `glossary.json` from
  `@factory/docs`. `InfoHint term="…"` and `Field term="…"` then show the definitions.
- **Page header:** pass the app's "Learn more" router link as `PageHeader learnMore={…}` (not
  inside `description`), so it and the InfoHint stay on one line.
- **Disabled reasons:** `Button disabledReason="…"` keeps the button focusable and exposes the
  reason as its description (tooltip + `aria-describedby`); the accessible name stays the label.
- **Statuses:** call `statusRole(app, value, domain?)`, or use the `StatusPill` component. They map
  every status from the four apps to 8 roles: neutral, progress, waiting, success, warning, danger,
  ended and unknown. A value the map does not know renders its raw text with the `unknown` role; it
  never throws. `STATUS_ROLES` is the plain `{ app: { value: role } }` map.

## Develop

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm catalog`   | Serves the component catalog on http://127.0.0.1:4395      |
| `pnpm test`      | Runs Vitest + Testing Library, with axe on composite views |
| `pnpm typecheck` | Type-checks the code                                       |
| `pnpm lint`      | Lints the code                                             |
| `pnpm build`     | Builds `dist/`: ESM, `.d.ts` files and `styles.css`        |
| `pnpm pack`      | Writes `factory-ui-0.1.1.tgz`                              |
