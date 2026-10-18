import { MimirError } from "@mimir/protocol";

/** Deepest JSON nesting Mimir stores (event payloads, command requests). */
export const MAX_JSON_DEPTH = 64;

/**
 * Nesting depth of a JSON-like value (`{}` and `[]` count 1, scalars 0), computed iteratively so
 * hostile input cannot overflow the stack. Stops early once the depth exceeds `limit`.
 */
export function jsonDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (v === null || typeof v !== "object") continue;
    if (d > max) max = d;
    if (max > limit) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return max;
}

/** Throws `MimirError('validation_failed')` when `value` nests deeper than `maxDepth`. */
export function assertJsonDepth(value: unknown, what: string, maxDepth = MAX_JSON_DEPTH): void {
  if (jsonDepth(value, maxDepth) > maxDepth) {
    throw new MimirError("validation_failed", `${what} is nested too deeply`, { maxDepth });
  }
}
