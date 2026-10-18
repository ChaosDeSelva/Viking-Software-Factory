# React architecture

Keep components small, state close to where it is used, and data flow one-directional.

## Always

- Own each piece of state in the lowest component that needs it; lift only when two siblings share it.
- Derive values during render instead of mirroring props into state.
- Separate data fetching and side effects (hooks, loaders) from presentational components.
- Give list items stable keys from data identity, never the array index for reorderable lists.
- Put effects behind cleanup: every subscription, timer and listener is released on unmount.
- On React 19, pass `ref` as a regular prop (no `forwardRef` in new code) and use Actions (`useActionState`, `useOptimistic`) and `use` for form and async flows.
- Follow the repository's existing folder layout and naming before introducing a new one.

## Never

- Never use `useEffect` to compute derived data or to sync two pieces of state.
- Never mutate props, state or context values in place.
- Never reach into another feature's internals; import from its public entry point.
- Never add a global store for state used by a single subtree.

## Verify

- Typecheck and unit tests pass for the touched packages.
- No new `react-hooks/exhaustive-deps` warnings; every effect has a complete dependency list and a cleanup where it subscribes.
- Components render without console errors or React warnings in the test run.
