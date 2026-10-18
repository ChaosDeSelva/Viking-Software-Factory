# Component reuse

A new component must earn its place. Search first, extend second, create last.

## Always

- Search the component library, design system and shared folders for an existing match before writing markup.
- Extend an existing component with a prop or variant when behavior is shared by two or more callers.
- Compose small primitives; pass content through `children` or slots rather than long prop lists.
- Put a new reusable component beside its siblings with the same naming, exports and tests.
- Use the design system's tokens and spacing scale in new components.

## Never

- Never copy a component to tweak one style; add a variant instead.
- Never add a second implementation of buttons, inputs, modals, tooltips or tables.
- Never leave a new shared component without a usage example or test.
- Never introduce a new UI library dependency without approval.

## Verify

- The diff reuses existing components for every standard control; new components have a stated reason.
- Unit tests cover each new variant, and no duplicated markup remains in the diff.
