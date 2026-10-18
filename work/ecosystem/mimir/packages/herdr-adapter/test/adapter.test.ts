import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isMimirError,
  RuntimeEventSchema,
  RuntimeCapabilitiesSchema,
  RuntimeSessionSchema,
} from "@mimir/protocol";
import {
  HerdrAdapter,
  JsonFileBindingStore,
  TRUST_PROMPT_STATUS,
  defaultBindingsPath,
  isBareShell,
} from "../src/index.js";
import {
  Collector,
  cleanupAll,
  fixtureEnvelopes,
  loadFixture,
  setup,
  spec,
  until,
} from "./helpers.js";

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

describe("capabilities and health", () => {
  it("reports version from ping + session.snapshot and the fixed feature set", async () => {
    const { adapter, fake } = await setup();
    const caps = await adapter.capabilities();
    expect(RuntimeCapabilitiesSchema.parse(caps)).toEqual(caps);
    expect(caps.runtime).toBe("herdr");
    expect(caps.version).toBe("0.9.4");
    expect(caps.features).toMatchObject({
      pause: false,
      multiHost: false,
      sendKeys: true,
      softStop: true,
      forceStop: true,
      subscribe: true,
    });
    expect(caps.agentKinds).toEqual(expect.arrayContaining(["claude", "codex", "shell"]));
    expect(fake.requests.map((r) => r.method)).toEqual(["ping", "session.snapshot"]);
  });

  it("health is ok on protocol 22 and not ok on a mismatch or a missing socket", async () => {
    const { adapter } = await setup();
    expect((await adapter.health()).ok).toBe(true);
    const { adapter: old } = await setup({ protocol: 16 });
    expect(await old.health()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("protocol_mismatch"),
    });
    const gone = new HerdrAdapter({
      socketPath: "/nonexistent/herdr.sock",
      timing: { connectTimeoutMs: 100 },
    });
    expect(await gone.health()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ENOENT"),
    });
  });

  it("maps connect ENOENT to runtime_unavailable", async () => {
    const gone = new HerdrAdapter({
      socketPath: "/nonexistent/herdr.sock",
      timing: { connectTimeoutMs: 100 },
    });
    const err = await rejection(gone.listSessions());
    expect(isMimirError(err)).toBe(true);
    expect(err.code).toBe("runtime_unavailable");
  });

  it("defaults to the named session 'mimir', never the user's default socket", () => {
    const a = new HerdrAdapter({});
    expect(a.client.socketPath).toBe(
      path.join(os.homedir(), ".config/herdr/sessions/mimir/herdr.sock"),
    );
    expect(defaultBindingsPath({ MIMIR_DATA_DIR: "/data" })).toBe("/data/herdr-bindings.json");
  });
});

describe("fact 1: one request per connection", () => {
  it("drives a whole createSession through single-request connections (the fake closes after each response)", async () => {
    const { adapter, fake } = await setup();
    await adapter.createSession(spec({ argv: ["true"] }));
    const methods = fake.requests.map((r) => r.method);
    expect(methods.slice(0, 3)).toEqual([
      "workspace.create",
      "pane.report_metadata",
      "pane.process_info",
    ]);
    expect(methods).toContain("pane.send_text");
  });
});

describe("fact 5: createSession", () => {
  it("agent kind: workspace.create with env marker → bare shell → agent.start retried on agent_pane_busy → agent.wait", async () => {
    const { adapter, fake } = await setup({ busyStartsPerPane: 2 });
    const s = spec({
      agentKind: "claude",
      argv: ["claude", "--model", "x"],
      env: { FOO: "1" },
      cwd: "/tmp/w",
    });
    const session = await adapter.createSession(s);
    const create = fake.requests.find((r) => r.method === "workspace.create")!;
    expect(create.params).toEqual({
      cwd: "/tmp/w",
      env: { FOO: "1", MIMIR_SESSION_ID: s.sessionId },
      label: "mimir-test",
      focus: false,
    });
    const starts = fake.requests.filter((r) => r.method === "agent.start");
    expect(starts).toHaveLength(3); // two agent_pane_busy, then success
    expect(starts[2]!.params).toEqual({
      name: s.sessionId.toLowerCase(),
      kind: "claude",
      pane_id: "w1:p1",
      args: ["--model", "x"],
      timeout_ms: 5_000,
    });
    const wait = fake.requests.find((r) => r.method === "agent.wait")!;
    expect(wait.params).toMatchObject({ target: "w1:p1", until: ["idle", "blocked"] });
    expect(fake.requests.some((r) => r.method === "pane.send_text")).toBe(false);
    expect(RuntimeSessionSchema.parse(session)).toEqual(session);
    expect(session).toMatchObject({
      state: "idle",
      agentKind: "claude",
      runtimeRef: { paneId: "w1:p1", workspaceId: "w1" },
    });
  });

  it("waits for a stable bare shell: a flickering zsh startup would eat typed input", async () => {
    const { adapter } = await setup(
      { shellStartupMs: 200, startupFlickerMs: 25 },
      { shellReadyIntervalMs: 10, shellReadyAttempts: 60 },
    );
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["true"] });
    await adapter.createSession(s);
    await c.waitFor((e) => e.kind === "session.exited" && e.sessionId === s.sessionId);
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
  });

  it("gives up after the bounded agent_pane_busy retries with a retryable conflict", async () => {
    const { adapter } = await setup({ busyStartsPerPane: 50 }, { agentBusyRetries: 3 });
    const err = await rejection(
      adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] })),
    );
    expect(err.code).toBe("conflict");
    expect(err.details).toMatchObject({ herdrCode: "agent_pane_busy", retryable: true });
  });

  it("is idempotent on idempotencyKey (no second workspace)", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ argv: ["sleep", "50"] });
    const a = await adapter.createSession(s);
    const b = await adapter.createSession({ ...s });
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.runtimeRef.paneId).toBe(a.runtimeRef.paneId);
    expect(fake.requests.filter((r) => r.method === "workspace.create")).toHaveLength(1);
  });

  it("shell kind: never calls agent.start; send_text + Enter, then the sentinel line; running → completed with exit 0", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "2"] });
    const session = await adapter.createSession(s);
    expect(session.state).toBe("running");
    expect(fake.requests.some((r) => r.method === "agent.start")).toBe(false);
    const text = fake.requests.find((r) => r.method === "pane.send_text")!.params.text;
    // no sentinel or nonce on the command line (audit H4): the exit status waits in a variable
    expect(text).toBe("sleep 2; __mimir_rc=$?");
    expect(fake.requests.find((r) => r.method === "pane.send_keys")!.params).toEqual({
      pane_id: "w1:p1",
      keys: ["enter"],
    });
    await c.waitFor((e) => e.kind === "session.exited");
    expect(c.states(s.sessionId)).toEqual(["starting", "running", "completed"]);
    expect(c.events.find((e) => e.kind === "session.exited")).toMatchObject({ exitCode: 0 });
    for (const e of c.events) expect(RuntimeEventSchema.parse(e)).toEqual(e);
    // after sealing, the shell pane carries a sentinel output_matched entry with the exact nonce
    const entries = fake.subscriptionEntries().flat();
    expect(entries.some((e) => e.type === "pane.output_matched" && e.pane_id === "w1:p1")).toBe(
      true,
    );
  });

  it("shell kind: a non-zero exit is failed with the exit code", async () => {
    const { adapter } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["exit-with", "3"] });
    await adapter.createSession(s);
    const exited = await c.waitFor((e) => e.kind === "session.exited");
    expect(exited).toMatchObject({ exitCode: 3 });
    expect(c.states(s.sessionId).at(-1)).toBe("failed");
    expect((await adapter.getSession(s.sessionId))?.state).toBe("failed");
  });

  it("rejects an unsupported agent kind as capability_unavailable and marks the session failed", async () => {
    const { adapter } = await setup();
    const s = spec({ agentKind: "nonesuch", argv: ["nonesuch"] });
    const err = await rejection(adapter.createSession(s));
    expect(err.code).toBe("capability_unavailable");
    expect((await adapter.listSessions()).find((x) => x.sessionId === s.sessionId)?.state).toBe(
      "failed",
    );
  });
});

describe("fact 2: subscriptions", () => {
  it("lifecycle by dotted type (no status entry without pane_id); one status entry per bound pane", async () => {
    const { adapter, fake } = await setup();
    const a = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const entries = fake.subscriptionEntries();
    const lifecycle = entries.find((e) => e.some((x) => x.type === "pane.created"))!;
    expect(lifecycle.every((x) => x.pane_id === undefined)).toBe(true);
    expect(lifecycle.some((x) => x.type === "pane.agent_status_changed")).toBe(false);
    const status = entries.flat().filter((x) => x.type === "pane.agent_status_changed");
    expect(status).toEqual([{ type: "pane.agent_status_changed", pane_id: a.runtimeRef.paneId }]);
    // a pane created after subscribe gets its own entry
    const b = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    await until(() =>
      fake
        .subscriptionEntries()
        .flat()
        .some((x) => x.type === "pane.agent_status_changed" && x.pane_id === b.runtimeRef.paneId),
    );
    // bootstrap emitted the current state of the bound session
    expect(c.states(a.sessionId)[0]).toBe("idle");
  });

  it("the fake rejects a status subscription without pane_id, like HerdR 0.9.4", async () => {
    const { fake, adapter } = await setup();
    const err = await rejection(adapter.client.subscribe(["pane.agent_status_changed"], () => {}));
    expect(err.code).toBe("invalid_request");
    expect(err.message).toContain("missing field `pane_id`");
    expect(fake.subscriptionCount).toBe(0);
  });

  it("tolerates pane_not_found for a bound pane: drops it, marks unknown, keeps the rest", async () => {
    const { adapter, bindings } = await setup();
    const a = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    await bindings.put({
      sessionId: "ses_ghost",
      idempotencyKey: "ghost",
      paneId: "w99:p1",
      workspaceId: "w99",
      cwd: "/tmp",
      agentKind: "claude",
      createdAt: new Date().toISOString(),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    expect(c.events).toContainEqual(
      expect.objectContaining({
        sessionId: "ses_ghost",
        state: "unknown",
        runtimeStatus: "pane_missing",
      }),
    );
    expect(c.states(a.sessionId)).toEqual(["idle"]);
  });

  it("maps status events: working→running, blocked→blocked, done→completed, idle→idle", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    fake.setStatus(s.runtimeRef.paneId!, "working");
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "running");
    fake.setStatus(s.runtimeRef.paneId!, "idle");
    await until(() => c.states(s.sessionId).filter((x) => x === "idle").length >= 2);
    fake.setStatus(s.runtimeRef.paneId!, "done");
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "completed");
    fake.setStatus(s.runtimeRef.paneId!, "working"); // terminal is sticky
    await new Promise((r) => setTimeout(r, 50));
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
  });
});

describe("fact 3: dedupe by (pane_id, state_change_seq)", () => {
  it("uses agent.get's state_change_seq as sourceEventId and drops a replayed duplicate", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    const pane = s.runtimeRef.paneId!;
    fake.setStatus(pane, "working");
    const ev = await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "running");
    const seq = fake.panes.get(pane)!.state_change_seq;
    expect(ev).toMatchObject({ sourceEventId: `${pane}:${seq}` });
    expect(fake.requests.some((r) => r.method === "agent.get" && r.params.target === pane)).toBe(
      true,
    );
    const before = c.events.length;
    fake.push({
      event: "pane.agent_status_changed",
      data: { pane_id: pane, workspace_id: "w1", agent_status: "working" },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(c.events.length).toBe(before);
  });

  it("falls back to (pane_id, observedAt, status) when agent.get fails", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    await new Promise((r) => setTimeout(r, 50)); // let the launch-time status event settle
    fake.failNext.set("agent.get", { code: "agent_not_found", message: "gone", count: 1 });
    fake.setStatus(s.runtimeRef.paneId!, "working");
    const ev = await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "running");
    expect(ev.kind === "session.state_changed" && ev.sourceEventId).toBe(
      `${s.runtimeRef.paneId}:${ev.observedAt}:working`,
    );
  });
});

describe("fact 4: loss is EOF", () => {
  it("any EOF → runtime.gap(reconnect), resubscribe, re-snapshot, re-emit bound sessions", async () => {
    const { adapter, fake } = await setup();
    const s = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    const c = new Collector();
    await adapter.subscribe(c.handler);
    expect(fake.subscriptionCount).toBe(2);
    fake.dropSubscriptions(); // stalled reader: silent EOF, no events_lost line
    await c.waitFor((e) => e.kind === "runtime.gap");
    expect(c.events.find((e) => e.kind === "runtime.gap")).toMatchObject({ reason: "reconnect" });
    await until(() => fake.subscriptionCount === 2);
    await until(() => c.states(s.sessionId).length >= 2);
    const snapshots = fake.requests.filter((r) => r.method === "session.snapshot").length;
    expect(snapshots).toBeGreaterThanOrEqual(2);
    // and the new subscriptions work
    fake.setStatus(s.runtimeRef.paneId!, "working");
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "running");
  });

  it("an events_lost line is reported as gap reason events_lost", async () => {
    const { adapter, fake } = await setup();
    await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    const c = new Collector();
    await adapter.subscribe(c.handler);
    fake.eventsLost();
    const gap = await c.waitFor((e) => e.kind === "runtime.gap");
    expect(gap).toMatchObject({ reason: "events_lost" });
    await until(() => fake.subscriptionCount === 2);
  });

  it("a gap during a shell command still observes the sentinel after resubscribing", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 60 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "1"] });
    await adapter.createSession(s);
    fake.dropSubscriptions();
    await c.waitFor((e) => e.kind === "session.exited");
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
  });

  it("close() stops the monitor; no more resubscribes", async () => {
    const { adapter, fake } = await setup();
    const sub = await adapter.subscribe(() => {});
    expect(fake.subscriptionCount).toBe(1);
    sub.close();
    await until(() => fake.subscriptionCount === 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.subscriptionCount).toBe(0);
  });
});

describe("fact 6: end of a claude -p run", () => {
  it("release(final_status idle) → completed; the trailing status unknown is ignored; readTerminal uses pane.read", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({
      agentKind: "claude",
      argv: ["claude", "-p", "Reply with the single word PONG"],
    });
    await adapter.createSession(s);
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "completed");
    await new Promise((r) => setTimeout(r, 50));
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
    expect(
      c.events.filter((e) => e.kind === "session.state_changed" && e.state === "unknown"),
    ).toEqual([]);
    expect(await adapter.readTerminal(s.sessionId)).toContain("PONG");
    expect(fake.requests.at(-1)).toMatchObject({ method: "pane.read" });
    // binding learned the agent session id from pane_updated
    const session = await adapter.getSession(s.sessionId);
    expect(session?.runtimeRef.agentSessionId).toBe("6e333a66-0320-4e7f-b464-d788bbf200d8");
    expect(session?.state).toBe("completed");
  });

  it("release with a non-idle final_status → failed", async () => {
    const { adapter } = await setup({
      agentBehavior: () => ({ kind: "oneshot", output: "err", runMs: 30, finalStatus: "blocked" }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude", "-p", "x"] });
    await adapter.createSession(s);
    const ev = await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "failed");
    expect(ev).toMatchObject({ runtimeStatus: "released:blocked" });
  });

  it("replays the recorded 0.9.4 one-shot envelopes (fixture lifecycle-events.ndjson) to completed", async () => {
    const { adapter, fake, bindings } = await setup();
    const records = loadFixture("lifecycle-events.ndjson");
    const created = records.find((r) => r.kind === "response" && r.method === "workspace.create")!
      .result as {
      root_pane: { pane_id: string; workspace_id: string; terminal_id: string; cwd: string };
    };
    fake.seedPane(created.root_pane);
    await bindings.put({
      sessionId: "ses_fixture",
      idempotencyKey: "fixture",
      paneId: created.root_pane.pane_id,
      workspaceId: created.root_pane.workspace_id,
      cwd: created.root_pane.cwd,
      agentKind: "claude",
      launchTerminalId: created.root_pane.terminal_id,
      createdAt: new Date().toISOString(),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const envelopes = fixtureEnvelopes("lifecycle-events.ndjson").filter(
      (e) =>
        e.data.pane_id === "w5:p1" ||
        (e.data.pane as { pane_id?: string } | undefined)?.pane_id === "w5:p1",
    );
    // the recording mixes underscore lifecycle names with the dotted status name
    expect(new Set(envelopes.map((e) => e.event))).toEqual(
      new Set([
        "pane_created",
        "pane_focused",
        "pane_updated",
        "pane_agent_detected",
        "pane.agent_status_changed",
      ]),
    );
    for (const e of envelopes) {
      fake.push(e);
      await new Promise((r) => setTimeout(r, 15));
    }
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "completed");
    expect(c.states("ses_fixture")).toEqual(["unknown", "idle", "completed"]);
    expect((await bindings.get("fixture"))?.agentSessionId).toBe(
      "6e333a66-0320-4e7f-b464-d788bbf200d8",
    );
  });
});

describe("fact 7: stop", () => {
  it("soft stop of a shell `sleep` is confirmed by pane.process_info", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await adapter.requestStop(s.sessionId, "soft");
    expect(
      fake.requests.filter((r) => r.method === "pane.send_keys").map((r) => r.params.keys),
    ).toContainEqual(["ctrl+c"]);
    const lastInfo = fake.requests.filter((r) => r.method === "pane.process_info").at(-1);
    expect(lastInfo).toBeDefined();
    expect(c.states(s.sessionId).slice(-2)).toEqual(["stopping", "stopped"]);
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  });

  it("does not trust `idle` after Ctrl-C: interactive claude needs a second Ctrl-C, confirmed by process_info", async () => {
    const { adapter, fake } = await setup({
      agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 2 }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    await adapter.requestStop(s.sessionId, "soft");
    const ctrlCs = fake.requests.filter(
      (r) => r.method === "pane.send_keys" && (r.params.keys as string[])[0] === "ctrl+c",
    );
    expect(ctrlCs).toHaveLength(2);
    expect(c.states(s.sessionId).at(-1)).toBe("stopped");
    expect(c.states(s.sessionId)).not.toContain("completed");
  });

  it("an unconfirmed soft stop throws a retryable conflict and leaves the session stopping", async () => {
    const { adapter } = await setup({
      agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }),
    });
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const err = await rejection(adapter.requestStop(s.sessionId, "soft"));
    expect(err.code).toBe("conflict");
    expect(err.details).toMatchObject({ retryable: true, reason: "stop_unconfirmed" });
  });

  it("force stop = pane.close; workspace_closed/pane_closed afterwards do not undo stopped", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await adapter.requestStop(s.sessionId, "force");
    expect(fake.requests.at(-1)).toMatchObject({
      method: "pane.close",
      params: { pane_id: "w1:p1" },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(c.states(s.sessionId).at(-1)).toBe("stopped");
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([]);
    expect(r.sessions.find((x) => x.sessionId === s.sessionId)?.state).toBe("stopped");
  });

  it("stop of an unknown session is not_found", async () => {
    const { adapter } = await setup();
    expect((await rejection(adapter.requestStop("ses_nope", "soft"))).code).toBe("not_found");
  });
});

describe("fact 8: restart", () => {
  it("socket ENOENT while down; gap + rebootstrap when it returns; reconcile: running shell → lost, completed → re-bound", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const done = spec({ argv: ["true"] });
    const running = spec({ argv: ["sleep", "30"] });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    await adapter.createSession(done);
    await c.waitFor((e) => e.kind === "session.exited");
    const r0 = await adapter.createSession(running);
    const termBefore = r0.runtimeRef.terminalId;
    await fake.restart({ downMs: 80, startupMs: 2_000 }); // restored zsh is busy with startup hooks
    await c.waitFor((e) => e.kind === "runtime.gap");
    await until(() => fake.subscriptionCount >= 1, 3_000);
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([running.sessionId]);
    expect(c.events).toContainEqual(
      expect.objectContaining({ kind: "session.lost", sessionId: running.sessionId }),
    );
    const kept = r.sessions.find((x) => x.sessionId === done.sessionId)!;
    expect(kept.state).toBe("completed");
    expect(kept.runtimeRef.paneId).toBe("w1:p1");
    expect(kept.runtimeRef.terminalId).not.toBe(termBefore);
    expect(await adapter.getSession(running.sessionId)).toBeNull();
    // the restored pane announces itself with pane_updated (revision 1), not pane_created
    const restart = loadFixture("restart-events.ndjson").filter((x) => x.kind === "event");
    expect(
      restart.every(
        (x) =>
          x.msg?.event === "pane_updated" &&
          (x.msg.data?.pane as { revision: number }).revision === 1,
      ),
    ).toBe(true);
  });

  it("reconcile marks a bound pane that is gone as lost only after pane_not_found", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.panes.delete("w1:p1");
    fake.push({
      event: "pane_closed",
      data: { type: "pane_closed", pane_id: "w1:p1", workspace_id: "w1" },
    });
    await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "unknown");
    expect((await adapter.listSessions()).find((x) => x.sessionId === s.sessionId)?.state).toBe(
      "unknown",
    );
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([s.sessionId]);
    expect(fake.requests.filter((x) => x.method === "pane.process_info").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
    });
  });
});

describe("fact 9: Claude Code folder-trust prompt", () => {
  it("surfaces blocked:trust_prompt and never answers the dialog", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "trust_prompt" }) });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    const session = await adapter.createSession(s);
    expect(session.state).toBe("blocked");
    const ev = await c.waitFor((e) => e.kind === "session.state_changed" && e.state === "blocked");
    expect(ev).toMatchObject({ runtimeStatus: TRUST_PROMPT_STATUS });
    expect(
      fake.requests.some((r) => r.method === "pane.read" && r.params.source === "visible"),
    ).toBe(true);
    const inputs = fake.requests.filter((r) =>
      ["pane.send_keys", "pane.send_text", "agent.send_keys", "agent.prompt"].includes(r.method),
    );
    expect(inputs).toEqual([]);
  });
});

describe("fact 10: input", () => {
  it("text → agent.prompt, keys → agent.send_keys; never agent.send", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    await adapter.sendInput(s.sessionId, { text: "hello" });
    await adapter.sendInput(s.sessionId, { keys: ["esc"] });
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toEqual({
      target: "w1:p1",
      text: "hello",
    });
    expect(fake.requests.find((r) => r.method === "agent.send_keys")?.params).toEqual({
      target: "w1:p1",
      keys: ["esc"],
    });
    expect(fake.requests.some((r) => r.method === "agent.send")).toBe(false);
  });

  it("agent_not_ready (agent not idle) → retryable conflict", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.setStatus("w1:p1", "working");
    const err = await rejection(adapter.sendInput(s.sessionId, { text: "hi" }));
    expect(err.code).toBe("conflict");
    expect(err.details).toMatchObject({ herdrCode: "agent_not_ready", retryable: true });
  });

  it("shell kind uses pane.send_text / pane.send_keys", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await adapter.sendInput(s.sessionId, { text: "y", keys: ["enter"] });
    expect(fake.requests.filter((r) => r.method === "pane.send_text").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      text: "y",
    });
    expect(fake.requests.filter((r) => r.method === "pane.send_keys").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      keys: ["enter"],
    });
  });

  it("unknown session → not_found", async () => {
    const { adapter } = await setup();
    expect((await rejection(adapter.sendInput("ses_nope", { text: "x" }))).code).toBe("not_found");
  });
});

describe("listSessions / getSession / bindings", () => {
  it("joins session.snapshot with bindings and ignores unbound panes", async () => {
    const { adapter, fake } = await setup();
    fake.seedPane({ pane_id: "w50:p1", workspace_id: "w50", terminal_id: "term_x", cwd: "/" });
    const s = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    const list = await adapter.listSessions();
    expect(list.map((x) => x.sessionId)).toEqual([s.sessionId]);
    expect(list[0]).toMatchObject({
      state: "idle",
      runtimeRef: { paneId: "w1:p1", terminalId: expect.stringMatching(/^term_/) },
    });
    expect(await adapter.getSession("ses_nope")).toBeNull();
  });

  it("persists bindings to JSON and a new adapter instance sees them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-bind-"));
    const file = path.join(dir, "herdr-bindings.json");
    const { fake } = await setup();
    const a1 = new HerdrAdapter({
      socketPath: fake.socketPath,
      bindings: new JsonFileBindingStore(file),
      timing: { shellReadyIntervalMs: 10, shellStableMs: 30 },
    });
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await a1.createSession(s);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      bindings: Record<string, { sessionId: string; paneId: string }>;
    };
    expect(stored.bindings[s.idempotencyKey]).toMatchObject({
      sessionId: s.sessionId,
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/tmp",
      agentKind: "claude",
    });
    const a2 = new HerdrAdapter({
      socketPath: fake.socketPath,
      bindings: new JsonFileBindingStore(file),
    });
    expect((await a2.getSession(s.sessionId))?.state).toBe("idle");
    expect((await a2.createSession(s)).runtimeRef.paneId).toBe("w1:p1");
    expect(fake.requests.filter((r) => r.method === "workspace.create")).toHaveLength(1);
    await a1.dispose();
    await a2.dispose();
  });

  it("dispose closes subscriptions and rejects further calls", async () => {
    const { adapter, fake } = await setup();
    await adapter.subscribe(() => {});
    await adapter.dispose();
    await until(() => fake.subscriptionCount === 0);
    expect((await rejection(adapter.createSession(spec()))).code).toBe("runtime_unavailable");
  });
});

describe("isBareShell (fact 5/7 liveness)", () => {
  it("bare only when the shell is the sole foreground process (recorded fixtures + live 0.9.4 observation)", () => {
    const infos = loadFixture("lifecycle-events.ndjson")
      .filter((r) => r.kind === "response" && r.method === "pane.process_info")
      .map((r) => (r.result as { process_info: Parameters<typeof isBareShell>[0] }).process_info);
    expect(infos.map(isBareShell)).toEqual([true, false]); // after claude -p exit: zsh only; interactive claude: claude.exe
    // Live: while zsh runs its prompt/startup hooks the foreground group is still the shell's,
    // but it has child processes; a command typed then has not started yet.
    expect(
      isBareShell({
        pane_id: "w3:p1",
        shell_pid: 100,
        foreground_process_group_id: 100,
        foreground_processes: [
          { pid: 101, name: "printf" },
          { pid: 100, name: "zsh" },
          { pid: 102, name: "zsh" },
          { pid: 103, name: "zsh" },
        ],
      }),
    ).toBe(false);
  });
});
