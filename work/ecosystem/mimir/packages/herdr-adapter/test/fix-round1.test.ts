// T8 fix round 1 (review .sdd/reviews/T8-review.md): C1 pane id reuse,
// I1 status lost during re-subscribe, I2 forgeable sentinel, and minors.
import { afterEach, describe, expect, it } from "vitest";
import {
  HerdrAdapter,
  MemoryBindingStore,
  isTrustPrompt,
  parseSentinel,
  SESSION_TOKEN_KEY,
} from "../src/index.js";
import { Collector, FAST_TIMING, cleanupAll, loadFixture, setup, spec, until } from "./helpers.js";

afterEach(cleanupAll);

async function rejection(
  p: Promise<unknown>,
): Promise<Error & { code: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}

describe("C1: HerdR reuses pane ids; bindings verify pane_id + cwd + session marker", () => {
  it("restart after the highest workspace closed hands its id out again; the new session's events reach the new binding and the stale one is lost", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const a = spec({ argv: ["true"] });
    await adapter.createSession(a);
    await c.waitFor((e) => e.kind === "session.exited" && e.sessionId === a.sessionId);
    const b = spec({ argv: ["sleep", "30"] });
    const bs = await adapter.createSession(b);
    expect(bs.runtimeRef.paneId).toBe("w2:p1");
    await adapter.requestStop(b.sessionId, "force"); // closes w2, the highest workspace
    await fake.restart({ downMs: 40 });
    await c.waitFor((e) => e.kind === "runtime.gap");
    await until(() => fake.subscriptionCount >= 1);

    const n = spec({ argv: ["sleep", "1"] }); // ~1 s in the fake
    const ns = await adapter.createSession(n);
    expect(ns.runtimeRef.paneId).toBe("w2:p1"); // reused id
    expect(c.events).toContainEqual(
      expect.objectContaining({
        kind: "session.lost",
        sessionId: b.sessionId,
        reason: "pane_reused",
      }),
    );
    const exited = await c.waitFor(
      (e) => e.kind === "session.exited" && e.sessionId === n.sessionId,
      5_000,
    );
    expect(exited).toMatchObject({ exitCode: 0 });
    expect(c.states(n.sessionId).at(-1)).toBe("completed");
    expect(await adapter.getSession(b.sessionId)).toBeNull();
    const r = await adapter.reconcile();
    expect(r.lost).toContain(b.sessionId);
    expect(r.sessions.map((x) => x.sessionId)).toEqual(
      expect.arrayContaining([a.sessionId, n.sessionId]),
    );
  });

  it("session delete + recreate: ids restart at w1; status events go to the new agent session, never the stale finished one", async () => {
    const { adapter, fake } = await setup();
    const old = spec({ agentKind: "claude", argv: ["claude", "-p", "x"] });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    await adapter.createSession(old);
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" &&
        e.sessionId === old.sessionId &&
        e.state === "completed",
    );
    await fake.recreate();
    await c.waitFor((e) => e.kind === "runtime.gap");
    await until(() => fake.subscriptionCount >= 1);
    const fresh = spec({ agentKind: "claude", argv: ["claude"] });
    const fs = await adapter.createSession(fresh);
    expect(fs.runtimeRef.paneId).toBe("w1:p1");
    fake.setStatus("w1:p1", "working");
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" &&
        e.sessionId === fresh.sessionId &&
        e.state === "running",
    );
    expect(c.events).toContainEqual(
      expect.objectContaining({ kind: "session.lost", sessionId: old.sessionId }),
    );
    expect(c.states(old.sessionId)).not.toContain("running");
  });

  it("stamps the session marker as a pane metadata token at creation", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const report = fake.requests.find((r) => r.method === "pane.report_metadata");
    expect(report?.params).toEqual({
      pane_id: "w1:p1",
      source: "mimir",
      tokens: { [SESSION_TOKEN_KEY]: s.sessionId },
    });
    expect(fake.panes.get("w1:p1")!.tokens[SESSION_TOKEN_KEY]).toBe(s.sessionId);
  });

  it("a pane reused by another adapter (same cwd, new terminal, foreign marker) is a conflict, never lost (audit H4)", async () => {
    const { adapter, fake, bindings } = await setup();
    const a = spec({ argv: ["true"] });
    await adapter.createSession(a);
    await until(async () => (await bindings.get(a.idempotencyKey))?.finalState === "completed");
    const launched = (await bindings.get(a.idempotencyKey))!.launchTerminalId;
    await fake.recreate();
    const other = new HerdrAdapter({
      socketPath: fake.socketPath,
      bindings: new MemoryBindingStore(),
      timing: FAST_TIMING,
    });
    const o = await other.createSession(spec({ argv: ["sleep", "30"] }));
    expect(o.runtimeRef.paneId).toBe("w1:p1");
    const r = await adapter.reconcile();
    // The marker token is forgeable, so it cannot retire the binding on its own...
    expect(r.lost).toEqual([]);
    const kept = r.sessions.find((x) => x.sessionId === a.sessionId)!;
    expect(kept.state).toBe("completed");
    // ...nor is the foreign pane adopted.
    expect(kept.runtimeRef.terminalId).toBe(launched);
    expect((await bindings.get(a.idempotencyKey))!.launchTerminalId).toBe(launched);
    await other.dispose();
  });

  it("reconcile marks a binding lost when the pane at its id has a different cwd and no marker", async () => {
    const { adapter, fake } = await setup();
    const a = spec({ agentKind: "claude", argv: ["claude"], cwd: "/tmp/project-a" });
    await adapter.createSession(a);
    await fake.recreate();
    fake.seedPane({
      pane_id: "w1:p1",
      workspace_id: "w1",
      terminal_id: "term_other",
      cwd: "/tmp/elsewhere",
    });
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([a.sessionId]);
  });

  it("pane_created for a bound pane id with a different terminal retires the stale binding", async () => {
    const { adapter, fake, bindings } = await setup();
    await bindings.put({
      sessionId: "ses_stale",
      idempotencyKey: "stale",
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/tmp",
      agentKind: "claude",
      launchTerminalId: "term_old",
      finalState: "completed",
      createdAt: new Date().toISOString(),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    await fake.client().request("workspace.create", { cwd: "/tmp" }); // someone else creates w1
    await c.waitFor((e) => e.kind === "session.lost" && e.sessionId === "ses_stale");
    expect((await bindings.get("stale"))?.lost).toBe(true);
  });
});

describe("I1: status changes between snapshot and the per-pane subscription ack are not lost", () => {
  it("applies agent.get right after each status subscription acks", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const c = new Collector();
    fake.beforeSubscribeAck = (entries) => {
      if (entries.some((e) => e.type === "pane.agent_status_changed" && e.pane_id === "w1:p1")) {
        fake.beforeSubscribeAck = null;
        fake.setStatus("w1:p1", "blocked"); // nobody is subscribed to this pane yet
      }
    };
    await adapter.subscribe(c.handler);
    expect(c.states(s.sessionId)[0]).toBe("idle"); // from the snapshot
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" && e.sessionId === s.sessionId && e.state === "blocked",
    );
    const methods = fake.requests.map((r) => r.method);
    const lastSub = methods.lastIndexOf("events.subscribe");
    expect(methods.indexOf("agent.get", lastSub)).toBeGreaterThan(lastSub);
  });

  it("bootstrap order: lifecycle events.subscribe before session.snapshot", async () => {
    const { adapter, fake } = await setup();
    await adapter.subscribe(() => {});
    const methods = fake.requests.map((r) => r.method);
    expect(methods.indexOf("events.subscribe")).toBeLessThan(methods.indexOf("session.snapshot"));
  });

  it("pane_created (not createSession) adds the status watch for a bound pane", async () => {
    const { adapter, fake, bindings } = await setup();
    await bindings.put({
      sessionId: "ses_later",
      idempotencyKey: "later",
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/tmp",
      agentKind: "claude",
      createdAt: new Date().toISOString(),
    });
    await adapter.subscribe(() => {});
    expect(
      fake
        .subscriptionEntries()
        .flat()
        .some((e) => e.pane_id === "w1:p1"),
    ).toBe(false);
    await fake.client().request("workspace.create", { cwd: "/tmp" });
    await until(() =>
      fake
        .subscriptionEntries()
        .flat()
        .some((e) => e.type === "pane.agent_status_changed" && e.pane_id === "w1:p1"),
    );
  });
});

describe("I2: the shell sentinel carries a per-session nonce", () => {
  it("types the nonce only after the command ends and ignores a forged line without it", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 100 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec();
    // the command itself prints a forged sentinel (session id, no nonce) before the real one
    await adapter.createSession({ ...s, argv: ["echo", `MIMIR_DONE:${s.sessionId}:9`] });
    const exited = await c.waitFor(
      (e) => e.kind === "session.exited" && e.sessionId === s.sessionId,
    );
    expect(exited).toMatchObject({ exitCode: 0 }); // not 9 from the forged line
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
    const nonce = (await bindings.get(s.idempotencyKey))?.sentinelNonce;
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    const typed = fake.requests
      .filter((r) => r.method === "pane.send_text")
      .map((r) => String(r.params.text));
    expect(typed).toEqual([
      `echo MIMIR_DONE:${s.sessionId}:9; __mimir_rc=$?`,
      ` echo MIMIR_DONE:${s.sessionId}:${nonce}:$__mimir_rc`,
    ]);
    expect(parseSentinel(s.sessionId, nonce!, `MIMIR_DONE:${s.sessionId}:0`)).toBeUndefined();
    expect(parseSentinel(s.sessionId, nonce!, `MIMIR_DONE:${s.sessionId}:${nonce}:7`)).toBe(7);
  });

  it("a forged line alone never completes the session", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    const created = await adapter.createSession(s);
    // program output that echoes the session id (but cannot know the nonce)
    fake.panes.get(created.runtimeRef.paneId!)!.screen.push(`MIMIR_DONE:${s.sessionId}:0`);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.states(s.sessionId).at(-1)).toBe("running");
    expect(c.events.some((e) => e.kind === "session.exited")).toBe(false);
  });
});

describe("minors", () => {
  it("trust detection matches Claude Code's dialog, not any 'trusted' text", () => {
    const visible = loadFixture("lifecycle-events.ndjson").find(
      (r) =>
        r.kind === "response" &&
        r.method === "pane.read" &&
        (r.result as { read: { source: string } }).read.source === "visible" &&
        /safety check/.test((r.result as { read: { text: string } }).read.text),
    );
    expect(isTrustPrompt((visible!.result as { read: { text: string } }).read.text)).toBe(true);
    expect(isTrustPrompt("Yes, I trust this folder")).toBe(true);
    expect(isTrustPrompt("Waiting for the trusted publisher to approve the release")).toBe(false);
  });

  it("rejects shell argv with control characters (validation_failed) before touching HerdR", async () => {
    const { adapter, fake } = await setup();
    const err = await rejection(adapter.createSession(spec({ argv: ["echo", "a\nb"] })));
    expect(err.code).toBe("validation_failed");
    expect(fake.requests.some((r) => r.method === "workspace.create")).toBe(false);
  });

  it("an unconfirmed soft stop reverts to the last observed state so later statuses are seen", async () => {
    const { adapter, fake } = await setup({
      agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    await rejection(adapter.requestStop(s.sessionId, "soft"));
    expect(c.states(s.sessionId).at(-1)).toBe("idle");
    fake.setStatus("w1:p1", "working");
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" && e.sessionId === s.sessionId && e.state === "running",
    );
  });
});
