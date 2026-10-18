# React performance

Measure first; optimize the bottleneck you can show.

## Always

- Profile with React DevTools or a trace before changing code, and record the baseline.
- Split routes and heavy widgets with `lazy` and `Suspense`.
- Virtualize long lists; paginate or window server data.
- Where React Compiler is enabled, rely on it and drop manual memoization in new code; elsewhere memoize only measured hot paths.
- Keep expensive computation out of render or memoize it with correct dependencies.
- Size and lazy-load images; set explicit width and height to prevent layout shift.

## Never

- Never sprinkle `useMemo`/`useCallback`/`memo` without evidence of a re-render problem.
- Never create new object or function props inside hot loops of memoized children.
- Never import a whole utility library for one function.

## Verify

- The measured metric (render count, bundle size or interaction time) improves versus the baseline.
- Tests still pass and behavior is unchanged.
