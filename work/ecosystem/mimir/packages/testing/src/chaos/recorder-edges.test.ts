import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_SAMPLES, recordRuntime, secretCores, type AppendLike } from "./index.js";

/** An adapter the test drives by hand: `emit` delivers, `reconcileWith` sets the next answer. */
function manualAdapter() {
  let handler: ((e: RuntimeEvent) => void) | undefined;
  let answer: { sessions: RuntimeSession[]; lost: string[] } = { sessions: [], lost: [] };
  let release: (() => void) | undefined;
  const adapter = {
    subscribe: (h: (e: RuntimeEvent) => void) => {
      handler = h;
      return Promise.resolve({ close: () => (handler = undefined) });
    },
    reconcile: () =>
      release === undefined
        ? Promise.resolve(answer)
        : new Promise<typeof answer>((r) => {
            const go = release as () => void;
            release = () => {
              go();
              r(answer);
            };
          }),
  } as unknown as RuntimeAdapter;
  return {
    adapter,
    emit: (e: RuntimeEvent) => handler?.(e),
    reconcileWith: (a: typeof answer) => (answer = a),
    holdReconcile: () => {
      release = () => undefined;
    },
    releaseReconcile: () => release?.(),
    get subscribed() {
      return handler !== undefined;
    },
  };
}

const at = "2026-01-01T00:00:00.000Z";
const session = (sessionId: string, state: RuntimeSession["state"]): RuntimeSession =>
  ({ sessionId, state, lastObservedAt: at, runtimeRef: {}, agentKind: "shell", cwd: "/" }) as never;

describe("recordRuntime edges", () => {
  it("records output and exits without a code, and skips reconciled sessions whose state is unchanged", async () => {
    const m = manualAdapter();
    const events: AppendLike[] = [];
    const rec = await recordRuntime(m.adapter, { append: (e) => events.push(e) });
    m.emit({ kind: "session.state_changed", sessionId: "s1", state: "running", observedAt: at });
    m.emit({ kind: "session.output", sessionId: "s1", text: "a\nb", observedAt: at });
    m.emit({ kind: "session.exited", sessionId: "s1", observedAt: at });
    m.reconcileWith({ sessions: [session("s1", "running")], lost: ["s2"] });
    m.emit({ kind: "runtime.gap", reason: "events_lost", observedAt: at });
    await rec.idle();
    expect(rec.gaps).toBe(1);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["session.state_changed", { from: "starting", to: "running" }],
      ["session.output", { text: "a\nb", redacted: false, lines: 2 }],
      ["session.exited", {}],
      ["recovery.reconciled", { sessions: 1, lostSessionIds: ["s2"], gap: true }],
      ["session.lost", { reason: "lost (reconcile)" }],
    ]);
    expect(events[0]?.sourceEventId).toBe(`s1:state:running:${at}`);
    rec.close();
    expect(m.subscribed).toBe(false);
  });

  it("records nothing after close, including a reconcile that was still running", async () => {
    const m = manualAdapter();
    const events: AppendLike[] = [];
    const rec = await recordRuntime(m.adapter, { append: (e) => events.push(e) });
    const emit = m.emit;
    m.holdReconcile();
    emit({ kind: "runtime.gap", reason: "events_lost", observedAt: at });
    rec.close();
    m.releaseReconcile();
    await rec.idle();
    expect(events).toEqual([]);
  });
});

describe("secretCores", () => {
  it("strips the Bearer and password= prefixes, leaving the secret value", () => {
    expect(secretCores(["Bearer abc", "password=xyz", "sk-1"])).toEqual(["abc", "xyz", "sk-1"]);
    expect(secretCores()).toHaveLength(CREDENTIAL_SAMPLES.length);
    expect(secretCores().some((c) => c.startsWith("Bearer "))).toBe(false);
  });
});
