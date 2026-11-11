import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventStore } from "./event-store.js";
import { eventInput } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventStore defaults", () => {
  it("reports a throwing listener through console.error by default and keeps the append", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = openEventStore(":memory:");
    try {
      const boom = new Error("boom");
      store.subscribe(() => {
        throw boom;
      });
      const e = store.append(eventInput());
      expect(store.read({ limit: 10 }).events.map((x) => x.id)).toEqual([e.id]);
      expect(logged).toHaveBeenCalledWith(boom);
    } finally {
      store.close();
    }
  });
});
