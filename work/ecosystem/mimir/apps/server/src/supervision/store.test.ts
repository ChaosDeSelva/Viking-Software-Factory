import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SupervisorStore } from "./store.js";
import { SupervisorEngine } from "./engine.js";
const roots: string[] = [],
  stores: SupervisorStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  roots.push(root);
  let time = 1000;
  const open = () => {
    const s = new SupervisorStore(join(root, "state.sqlite"), () => time);
    stores.push(s);
    return s;
  };
  const store = open();
  store.register("primary");
  return {
    store,
    open,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
it("fences stale owners and refuses a simultaneous lease", () => {
  const f = fixture();
  const lease = f.store.acquire("primary", "one", 1000)!;
  expect(f.open().acquire("primary", "two")).toBe(null);
  f.advance(1001);
  const next = f.open().acquire("primary", "two")!;
  expect(next.epoch).toBeGreaterThan(lease.epoch);
  expect(() => f.store.claim(lease)).toThrow("ownership");
});
it("persists pending work and converts interrupted mutations to uncertain", () => {
  const f = fixture();
  f.store.enqueue("m1", "primary", "input", { text: "hello" });
  const lease = f.store.acquire("primary", "one", 1000)!;
  expect(f.store.claim(lease)?.id).toBe("m1");
  f.advance(1001);
  const resumed = f.open();
  resumed.acquire("primary", "two");
  expect(resumed.messages("primary")[0]!.state).toBe("uncertain");
  expect(resumed.claim(resumed.acquire("primary", "two")!)).toBe(null);
});
it("rejects changed idempotent messages including different recipients", () => {
  const { store } = fixture();
  store.register("child", "primary");
  store.enqueue("m1", "primary", "input", { text: "hello" });
  expect(() => store.enqueue("m1", "child", "input", { text: "hello" })).toThrow("changed");
  expect(store.enqueue("m1", "primary", "input", { text: "hello" }).id).toBe("m1");
});
it("preserves multiline human holds through restart and never claims held work", () => {
  const f = fixture();
  const reason = "Waiting for owner’s approval\nDo not retry: quota / policy?";
  f.store.setState("primary", "held", reason);
  f.store.enqueue("m1", "primary", "observe", {});
  const resumed = f.open();
  expect(resumed.get("primary")!.reason).toBe(reason);
  expect(resumed.claim(resumed.acquire("primary", "one")!)).toBe(null);
});
it("records reconciliation evidence and refuses blind retry", () => {
  const f = fixture();
  f.store.enqueue("m1", "primary", "stop", {});
  const lease = f.store.acquire("primary", "one")!;
  f.store.claim(lease);
  f.store.finish(lease, "m1", "uncertain", "network timeout");
  expect(() => f.store.resolve("primary", "m1", "done", "")).toThrow("evidence");
  f.store.resolve("primary", "m1", "done", "Observed worker stopped with exit evidence");
  expect(f.store.messages("primary")[0]!.state).toBe("done");
  expect(f.store.observations("primary").length).toBeGreaterThan(3);
});
it("dispatches pending controls once and resumes without replay", async () => {
  const f = fixture();
  let calls = 0;
  f.store.enqueue("m1", "primary", "observe", {});
  const engine = new SupervisorEngine(f.store, async () => {
    calls++;
    return "observed";
  });
  await Promise.all([engine.tick(), engine.tick()]);
  await engine.tick();
  expect(calls).toBe(1);
  expect(f.store.messages("primary")[0]!.state).toBe("done");
  await engine.stop();
});
it("requires parent identity and prevents reparenting cycles", () => {
  const { store } = fixture();
  expect(() => store.register("child", "missing")).toThrow("Parent");
  store.register("child", "primary");
  expect(() => store.register("primary", "child")).toThrow("parent");
});
it("a held parent stops child dispatch without discarding child work", () => {
  const { store } = fixture();
  store.register("child", "primary");
  store.enqueue("m1", "child", "observe", {});
  store.setState("primary", "held", "Review the fleet");
  const lease = store.acquire("child", "one")!;
  expect(store.claim(lease)).toBe(null);
  store.setState("primary", "ready", null);
  expect(store.claim(lease)?.id).toBe("m1");
});
