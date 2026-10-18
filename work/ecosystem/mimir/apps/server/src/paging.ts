/** Shape shared by every EventStore `read()` contract revision. */
export interface PageLike {
  events: readonly unknown[];
  nextCursor: string | null;
  hasMore?: boolean;
  /** Position of the last returned event (newer store revisions). */
  lastCursor?: string;
}

/** True when the store reports more matching events; falls back to `nextCursor !== null`. */
export function hasMoreOf(page: PageLike): boolean {
  return typeof page.hasMore === "boolean" ? page.hasMore : page.nextCursor !== null;
}

/**
 * Cursor to continue reading after this page, or `null` when the reader is caught up.
 * Prefers `lastCursor` when the store provides it.
 */
export function continueCursorOf(page: PageLike): string | null {
  if (!hasMoreOf(page) || page.events.length === 0) return null;
  return page.lastCursor ?? page.nextCursor;
}
