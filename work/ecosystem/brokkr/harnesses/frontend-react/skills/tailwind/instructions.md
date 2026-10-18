# Tailwind CSS

Style with the project's tokens and utilities; keep one source of truth for design values.

## Always

- Use theme tokens (colors, spacing, radii, fonts) defined in the Tailwind config or CSS theme.
- Extract repeated utility groups into a component, not into a `@apply` pile.
- Order variants consistently (base, responsive, state, dark) and keep class lists readable.
- Build class names from complete literal strings or a mapping so the compiler can see them.
- Use `focus-visible:` and `motion-reduce:` variants for interaction and animation states.

## Never

- Never hard-code hex colors or pixel values when a token exists; arbitrary values need a reason.
- Never assemble class names by string concatenation like `bg-${color}-500`.
- Never use `!important` utilities to win specificity fights.
- Never edit generated CSS output.

## Verify

- The build succeeds and the changed UI renders with the intended styles in the screenshot check.
- A grep of the diff finds no new raw color literals outside the theme file.
