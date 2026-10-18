import { describe, expect, it } from "vitest";
import { continueCursorOf, hasMoreOf } from "./paging.js";

describe("paging helpers", () => {
  it("handle the nullable-nextCursor contract", () => {
    expect(hasMoreOf({ events: [1], nextCursor: "c" })).toBe(true);
    expect(hasMoreOf({ events: [1], nextCursor: null })).toBe(false);
    expect(continueCursorOf({ events: [1], nextCursor: "c" })).toBe("c");
    expect(continueCursorOf({ events: [], nextCursor: null })).toBeNull();
  });

  it("prefer hasMore and lastCursor when present", () => {
    const end = { events: [1], nextCursor: "c", hasMore: false };
    expect(hasMoreOf(end)).toBe(false);
    expect(continueCursorOf(end)).toBeNull();
    const more = { events: [1], nextCursor: "n", hasMore: true, lastCursor: "l" };
    expect(continueCursorOf(more)).toBe("l");
    expect(
      continueCursorOf({ events: [1], nextCursor: null, hasMore: true, lastCursor: "l" }),
    ).toBe("l");
  });
});
