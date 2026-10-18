/** Milliseconds since epoch for an injected clock value or ISO timestamp. */
export function toMs(t: Date | string | number): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") return Date.parse(t);
  return t.getTime();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
