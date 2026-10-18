# Component design

A component API is a contract: small, typed and hard to misuse.

## Always

- Keep props minimal and typed; prefer composition over boolean flags.
- Forward `ref`, `className` and remaining native attributes on leaf components.
- Support controlled and uncontrolled use only when callers need both.
- Define loading, empty, error and disabled states explicitly.
- Colocate the component, its types, tests and story.

## Never

- Never couple a presentational component to a data source or router.
- Never accept props that can contradict each other.
- Never swallow native event handlers passed by callers.

## Verify

- Tests cover each state and variant through the public props.
- The component renders with only its required props.
