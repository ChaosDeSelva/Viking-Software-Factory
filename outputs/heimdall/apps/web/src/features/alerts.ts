// Which notifications become desktop alerts, free of React so node --test covers it.
type R = Record<string, any>;

/**
 * The notifications new since the last call, and the seen set to pass next time. `seen` is null
 * until primed; `items` is undefined until the first snapshot, whose backlog only primes it.
 */
export function newAlerts(
  seen: Set<string> | null,
  items: R[] | undefined,
): [Set<string> | null, R[]] {
  if (!items) return [seen, []];
  const keys = items.map((n) => n.id + ":" + n.revision);
  if (!seen) return [new Set(keys), []];
  const fresh = items.filter(
    (n, i) => !seen.has(keys[i]) && n.active && !n.seen,
  );
  for (const key of keys) seen.add(key);
  return [seen, fresh];
}
