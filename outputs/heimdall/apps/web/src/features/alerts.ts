// Which notifications become desktop alerts, free of React so node --test covers it.
type R = Record<string, any>;

/**
 * The notifications new since the last call, and the seen set to pass next time. `seen` is null
 * until primed; `items` is undefined until the first snapshot, whose backlog only primes it.
 * News that `shown` rejects (an archived project's) is marked seen without alerting.
 */
export function newAlerts(
  seen: Set<string> | null,
  items: R[] | undefined,
  shown: (n: R) => boolean = () => true,
): [Set<string> | null, R[]] {
  if (!items) return [seen, []];
  const keys = items.map((n) => n.id + ":" + n.revision);
  if (!seen) return [new Set(keys), []];
  const fresh = items.filter(
    (n, i) => !seen.has(keys[i]) && n.active && !n.seen && shown(n),
  );
  for (const key of keys) seen.add(key);
  return [seen, fresh];
}

/** Switches desktop alerts on or off; `requestPermission` is null where the browser has none. */
export async function toggleDesktopAlerts(
  enabled: boolean,
  requestPermission: (() => Promise<string>) | null,
  save: (value: R) => Promise<unknown>,
  warn: (message: string) => void,
): Promise<void> {
  if (enabled) {
    // Switching off only stops alerts, so a revoked permission must not keep them on.
    await save({ desktopNotifications: false });
    return;
  }
  if (!requestPermission) {
    warn("Desktop notifications are unavailable in this browser.");
    return;
  }
  const permission = await requestPermission();
  if (permission === "granted") await save({ desktopNotifications: true });
  else
    warn(
      "Browser notification permission was not granted. In-app alerts remain available.",
    );
}
