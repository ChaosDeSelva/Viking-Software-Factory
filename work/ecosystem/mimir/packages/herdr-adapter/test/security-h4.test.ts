// Audit H4: pane metadata tokens are writable by any pane (pane.report_metadata takes any
// pane_id and source), and the shell sentinel nonce used to be typed into the pane. Neither may
// be trusted as proof of identity or completion.
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TOKEN_KEY, paneMatchesBinding, parseSentinel } from "../src/index.js";
import { Collector, cleanupAll, setup, spec, until } from "./helpers.js";

afterEach(cleanupAll);

const forge = async (
  fake: Awaited<ReturnType<typeof setup>>["fake"],
  paneId: string,
  value: string,
) =>
  fake.client().request("pane.report_metadata", {
    pane_id: paneId,
    source: "mimir",
    tokens: { [SESSION_TOKEN_KEY]: value },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("H4: metadata tokens are not identity", () => {
  it("paneMatchesBinding: HerdR-observed facts decide; a token only ever downgrades to conflict", () => {
    const b = { sessionId: "ses_a", cwd: "/tmp/a", launchTerminalId: "term_1" };
    const pane = (over: Record<string, unknown>) => ({
      terminal_id: "term_1",
      cwd: "/tmp/a",
      ...over,
    });
    // same terminal: ours, whatever the token says
    expect(paneMatchesBinding(b, pane({ tokens: { [SESSION_TOKEN_KEY]: "ses_x" } }))).toBe("match");
    // different terminal + different cwd: not ours, even with our session id forged on it
    expect(
      paneMatchesBinding(
        b,
        pane({ terminal_id: "term_2", cwd: "/tmp/b", tokens: { [SESSION_TOKEN_KEY]: "ses_a" } }),
      ),
    ).toBe("mismatch");
    // different terminal, same cwd, foreign token: cannot tell; never "mismatch" on a token alone
    expect(
      paneMatchesBinding(b, pane({ terminal_id: "term_2", tokens: { [SESSION_TOKEN_KEY]: "x" } })),
    ).toBe("conflict");
    // our own token with nothing else to go on is still only unverified
    expect(
      paneMatchesBinding(
        b,
        pane({ terminal_id: "term_2", tokens: { [SESSION_TOKEN_KEY]: "ses_a" } }),
      ),
    ).toBe("unverified");
  });

  it("another pane forging a marker on a live session's pane does not mark it lost", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    const created = await adapter.createSession(s);
    await forge(fake, created.runtimeRef.paneId!, "ses_attacker");
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([]);
    expect(c.events.some((e) => e.kind === "session.lost")).toBe(false);
    expect(await adapter.getSession(s.sessionId)).not.toBeNull();
  });

  it("forging our session id onto a reused pane (new terminal, other cwd) does not make it ours", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    // a finished session: nothing but the binding check stands between it and re-binding
    const a = spec({ argv: ["true"], cwd: "/tmp/project-a" });
    await adapter.createSession(a);
    await c.waitFor((e) => e.kind === "session.exited");
    await fake.recreate();
    fake.seedPane({
      pane_id: "w1:p1",
      workspace_id: "w1",
      terminal_id: "term_attacker",
      cwd: "/tmp/elsewhere",
    });
    await forge(fake, "w1:p1", a.sessionId);
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([a.sessionId]);
  });

  it("a foreign marker where identity cannot be verified → unknown(marker_conflict), never lost", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const a = spec({ agentKind: "claude", argv: ["claude"], cwd: "/tmp" });
    await adapter.createSession(a);
    await fake.recreate();
    fake.seedPane({ pane_id: "w1:p1", workspace_id: "w1", terminal_id: "term_new", cwd: "/tmp" });
    await forge(fake, "w1:p1", "ses_someone_else");
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([]);
    expect(c.events.some((e) => e.kind === "session.lost")).toBe(false);
    const last = c.events
      .filter((e) => e.kind === "session.state_changed" && e.sessionId === a.sessionId)
      .at(-1);
    expect(last).toMatchObject({ state: "unknown", runtimeStatus: "marker_conflict" });
  });
});

describe("H4: the shell sentinel nonce is not exposed before the command finishes", () => {
  it("no nonce exists, is typed, or is on screen while the command runs", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    const created = await adapter.createSession(s);
    expect(created.state).toBe("running");
    await sleep(150);
    expect((await bindings.get(s.idempotencyKey))?.sentinelNonce).toBeUndefined();
    const typed = fake.requests
      .filter((r) => r.method === "pane.send_text")
      .map((r) => String(r.params.text));
    expect(typed).toEqual(["sleep 30; __mimir_rc=$?"]);
    const screen = fake.panes.get(created.runtimeRef.paneId!)!.screen.join("\n");
    expect(screen).not.toContain("MIMIR_DONE");
  });

  it("after the shell is the sole foreground process again, one final line carries the nonce", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 50 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["exit-with", "3"] });
    await adapter.createSession(s);
    const exited = await c.waitFor((e) => e.kind === "session.exited");
    expect(exited).toMatchObject({ exitCode: 3 });
    expect(c.states(s.sessionId).at(-1)).toBe("failed");
    const nonce = (await bindings.get(s.idempotencyKey))?.sentinelNonce;
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    const typed = fake.requests
      .filter((r) => r.method === "pane.send_text")
      .map((r) => String(r.params.text));
    expect(typed).toEqual([
      "exit-with 3; __mimir_rc=$?",
      ` echo MIMIR_DONE:${s.sessionId}:${nonce}:$__mimir_rc`,
    ]);
    // the final line was only typed once process_info showed a bare shell
    const idx = fake.requests.findIndex(
      (r) => r.method === "pane.send_text" && String(r.params.text).includes("MIMIR_DONE"),
    );
    expect(fake.requests.slice(0, idx).some((r) => r.method === "pane.process_info")).toBe(true);
  });

  it("a correct sentinel printed while a foreground process runs never completes the session", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    const created = await adapter.createSession(s);
    // Worst case: the nonce leaked anyway (e.g. read from the bindings file) and the running
    // command prints a perfect sentinel.
    const b = (await bindings.get(s.idempotencyKey))!;
    await bindings.put({ ...b, sentinelNonce: "0123456789abcdef" });
    fake.panes
      .get(created.runtimeRef.paneId!)!
      .screen.push(`MIMIR_DONE:${s.sessionId}:0123456789abcdef:0`);
    await sleep(200);
    await adapter.reconcile();
    expect(c.events.some((e) => e.kind === "session.exited")).toBe(false);
    expect(c.states(s.sessionId).at(-1)).toBe("running");
  });

  it("a session restored after an adapter restart still completes through the final line", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 100 });
    const s = spec({ argv: ["sleep", "1"] });
    await adapter.createSession(s);
    await adapter.dispose();
    const { HerdrAdapter } = await import("../src/index.js");
    const { FAST_TIMING } = await import("./helpers.js");
    const next = new HerdrAdapter({ socketPath: fake.socketPath, bindings, timing: FAST_TIMING });
    const c = new Collector();
    await next.subscribe(c.handler);
    await until(async () => {
      await next.reconcile();
      return c.events.some((e) => e.kind === "session.exited");
    }, 5_000);
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
    await next.dispose();
  });

  it("parseSentinel never accepts a line without the session's nonce", () => {
    expect(parseSentinel("ses_a", undefined, "MIMIR_DONE:ses_a:0")).toBeUndefined();
    expect(
      parseSentinel("ses_a", undefined, "MIMIR_DONE:ses_a:0123456789abcdef:0"),
    ).toBeUndefined();
    expect(parseSentinel("ses_a", "0123456789abcdef", "MIMIR_DONE:ses_a:0123456789abcdef:4")).toBe(
      4,
    );
  });
});
