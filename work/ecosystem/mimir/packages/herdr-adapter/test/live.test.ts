// Opt-in live test against a real HerdR 0.9.4 (MIMIR_LIVE_HERDR=1).
// Uses ONLY the dedicated named session `mimir-adapter-test`; it is started
// here and stopped + deleted afterwards. The user's default session is never
// touched. A Claude Code folder-trust prompt is recorded, never accepted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId, type RuntimeEvent } from "@mimir/protocol";
import {
  HerdrAdapter,
  MemoryBindingStore,
  SESSION_TOKEN_KEY,
  TRUST_PROMPT_STATUS,
  isBareShell,
} from "../src/index.js";
import { Collector, spec } from "./helpers.js";

const LIVE = process.env.MIMIR_LIVE_HERDR === "1";
const SESSION = "mimir-adapter-test";
const HERDR = process.env.HERDR_BIN ?? path.join(os.homedir(), ".local/bin/herdr");
const redact = (v: unknown) => String(v).split(os.homedir()).join("~");
const log = (...a: unknown[]) => console.log("[live]", ...a.map(redact));

function herdr(args: string[]): string {
  return execFileSync(HERDR, args, { encoding: "utf8", timeout: 30_000 }).trim();
}

function startServer(logFile: string): void {
  const fd = fs.openSync(logFile, "a");
  spawn(HERDR, ["--session", SESSION, "server"], {
    detached: true,
    stdio: ["ignore", fd, fd],
  }).unref();
}

async function waitUp(adapter: HerdrAdapter, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await adapter.health()).ok) {
    if (Date.now() > deadline) throw new Error("HerdR test session did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!LIVE)("live HerdR (session mimir-adapter-test)", () => {
  let adapter: HerdrAdapter;
  const c = new Collector();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-live-"));
  const serverLog = path.join(cwd, "herdr-server.log");
  let completedShell = "";

  beforeAll(async () => {
    adapter = new HerdrAdapter({
      sessionName: SESSION,
      bindings: new MemoryBindingStore(),
      timing: { stopPollAttempts: 20, stopPollIntervalMs: 250, shellReadyAttempts: 240 },
    });
    if (!adapter.client.socketPath.includes(`/sessions/${SESSION}/`)) {
      throw new Error(`refusing: ${adapter.client.socketPath} is not the ${SESSION} socket`);
    }
    log("socket", adapter.client.socketPath.replace(os.homedir(), "~"));
    startServer(serverLog);
    await waitUp(adapter);
    log("health", (await adapter.health()).detail?.replace(os.homedir(), "~"));
    log("capabilities", JSON.stringify(await adapter.capabilities()));
    await adapter.subscribe((e: RuntimeEvent) => {
      c.handler(e);
      log("event", JSON.stringify(e));
    });
  }, 120_000);

  afterAll(async () => {
    await adapter?.dispose();
    try {
      log(herdr(["session", "stop", SESSION]));
    } catch (e) {
      log("stop failed", String(e));
    }
    try {
      log(herdr(["session", "delete", SESSION]));
    } catch (e) {
      log("delete failed", String(e));
    }
    log(
      "sessions after cleanup:\n" +
        herdr(["session", "list"]).replace(new RegExp(os.homedir(), "g"), "~"),
    );
  }, 120_000);

  it("shell kind: pane.send_text sentinel → running → completed", async () => {
    const s = spec({ sessionId: newId("ses"), argv: ["sh", "-c", "sleep 2; echo shell-ok"], cwd });
    const session = await adapter.createSession(s);
    log("created", JSON.stringify(session));
    expect(session.state).toBe("running");
    await c.waitFor((e) => e.kind === "session.exited" && e.sessionId === s.sessionId, 30_000);
    expect(c.states(s.sessionId)).toEqual(expect.arrayContaining(["running", "completed"]));
    expect(c.states(s.sessionId).at(-1)).toBe("completed");
    expect(await adapter.readTerminal(s.sessionId)).toContain("shell-ok");
    completedShell = s.sessionId;
    // C1 marker: the pane carries the session id as a metadata token
    const snap = await adapter.client.request<{
      snapshot: { panes: { pane_id: string; cwd?: string; tokens?: Record<string, string> }[] };
    }>("session.snapshot");
    const pane = snap.snapshot.panes.find((p) => p.pane_id === session.runtimeRef.paneId);
    log("pane tokens", JSON.stringify(pane?.tokens), "pane cwd", pane?.cwd);
    expect(pane?.tokens?.[SESSION_TOKEN_KEY]).toBe(s.sessionId);
  }, 120_000);

  it('claude -p "Reply with the single word PONG" → release → completed; readTerminal has PONG', async () => {
    const s = spec({
      sessionId: newId("ses"),
      agentKind: "claude",
      argv: ["claude", "-p", "Reply with the single word PONG"],
      cwd,
    });
    const session = await adapter.createSession(s);
    log("created", JSON.stringify(session));
    const end = await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" &&
        e.sessionId === s.sessionId &&
        (e.state === "completed" ||
          e.state === "failed" ||
          e.runtimeStatus === TRUST_PROMPT_STATUS),
      150_000,
    );
    if (end.kind === "session.state_changed" && end.runtimeStatus === TRUST_PROMPT_STATUS) {
      log("TRUST PROMPT: claude stopped at the folder-trust dialog; not accepting it");
      await adapter.requestStop(s.sessionId, "force");
    }
    expect(end).toMatchObject({ state: "completed" });
    const text = await adapter.readTerminal(s.sessionId);
    log(
      "terminal tail",
      JSON.stringify(
        text.split("\n").slice(-6).join("\n").replace(new RegExp(os.homedir(), "g"), "~"),
      ),
    );
    expect(text).toContain("PONG");
  }, 180_000);

  it("soft stop of `sleep 30` is confirmed by pane.process_info", async () => {
    const s = spec({ sessionId: newId("ses"), argv: ["sleep", "30"], cwd });
    const session = await adapter.createSession(s);
    // The command must really be running (not eaten by a starting zsh) before we stop it.
    type PI = { process_info: Parameters<typeof isBareShell>[0] };
    const t0 = Date.now();
    let before = await adapter.client.request<PI>("pane.process_info", {
      pane_id: session.runtimeRef.paneId,
    });
    while (!before.process_info.foreground_processes?.some((p) => p.name === "sleep")) {
      if (Date.now() - t0 > 15_000) break;
      await new Promise((r) => setTimeout(r, 200));
      before = await adapter.client.request<PI>("pane.process_info", {
        pane_id: session.runtimeRef.paneId,
      });
    }
    log(
      `process before stop (+${Date.now() - t0}ms)`,
      JSON.stringify(before.process_info.foreground_processes?.map((p) => p.name)),
    );
    expect(before.process_info.foreground_processes?.map((p) => p.name)).toContain("sleep");
    expect(isBareShell(before.process_info)).toBe(false);
    await adapter.requestStop(s.sessionId, "soft");
    const after = await adapter.client.request<{ process_info: Parameters<typeof isBareShell>[0] }>(
      "pane.process_info",
      { pane_id: session.runtimeRef.paneId },
    );
    log(
      "process after stop",
      JSON.stringify(after.process_info.foreground_processes?.map((p) => p.name)),
    );
    expect(isBareShell(after.process_info)).toBe(true);
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  }, 120_000);

  it("force stop closes the pane", async () => {
    const s = spec({ sessionId: newId("ses"), argv: ["sleep", "30"], cwd });
    const session = await adapter.createSession(s);
    await adapter.requestStop(s.sessionId, "force");
    const err = await adapter.client
      .request("pane.process_info", { pane_id: session.runtimeRef.paneId })
      .then(
        () => null,
        (e: { code: string }) => e.code,
      );
    log("process_info after force stop", err);
    expect(err).toBe("pane_not_found");
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  }, 120_000);

  it("restart of the named session: reconcile reports the bound running pane lost and re-binds the finished one", async () => {
    const s = spec({ sessionId: newId("ses"), argv: ["sleep", "300"], cwd });
    const running = await adapter.createSession(s);
    await new Promise((r) => setTimeout(r, 1_000));
    const before = await adapter.listSessions();
    log(
      "before restart",
      JSON.stringify(before.map((x) => [x.sessionId.slice(-6), x.state, x.runtimeRef.terminalId])),
    );
    log(herdr(["session", "stop", SESSION]));
    const health = await adapter.health();
    log("health while stopped", health.detail?.replace(os.homedir(), "~"));
    expect(health.ok).toBe(false);
    startServer(serverLog);
    await waitUp(adapter);
    await c.waitFor((e) => e.kind === "runtime.gap", 10_000);
    const r = await adapter.reconcile();
    log(
      "reconcile",
      JSON.stringify({
        lost: r.lost,
        sessions: r.sessions.map((x) => [
          x.sessionId.slice(-6),
          x.state,
          x.runtimeRef.paneId,
          x.runtimeRef.terminalId,
        ]),
      }),
    );
    expect(r.lost).toContain(s.sessionId);
    const kept = r.sessions.find((x) => x.sessionId === completedShell);
    expect(kept?.state).toBe("completed");
    expect(kept?.runtimeRef.terminalId).toBeDefined();
    expect(running.runtimeRef.terminalId).toBeDefined();
  }, 150_000);
});
