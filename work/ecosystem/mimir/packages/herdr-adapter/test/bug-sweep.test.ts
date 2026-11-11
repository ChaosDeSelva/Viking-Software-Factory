// Regression tests for defects found in the bug sweep; each failed before its fix.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  HerdrSocketClient,
  JsonFileBindingStore,
  mapAgentStatus,
  parseSentinel,
  releaseState,
  sentinelRegex,
  type HerdrEnvelope,
  type SessionBinding,
} from "../src/index.js";
import { Collector, cleanupAll, setup, spec, until } from "./helpers.js";

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await cleanupAll();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-sweep-"));
  dirs.push(d);
  return d;
}

/** A server that hands each request line (already parsed) to `onRequest`. */
function rawServer(
  onRequest: (sock: net.Socket, msg: { id: string; method: string }) => void,
): Promise<string> {
  const p = path.join(tmpDir(), "s.sock");
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = "";
      onRequest(sock, JSON.parse(line) as { id: string; method: string });
    });
  });
  servers.push(server);
  return new Promise((res) => server.listen(p, () => res(p)));
}

async function rejection(p: Promise<unknown>): Promise<Error & { code: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string };
  }
  throw new Error("expected a rejection");
}

function binding(n: number): SessionBinding {
  return {
    sessionId: `ses_${n}`,
    idempotencyKey: `idem_${n}`,
    paneId: `w${n}:p1`,
    workspaceId: `w${n}`,
    cwd: "/tmp",
    agentKind: "shell",
    createdAt: new Date(0).toISOString(),
  };
}

describe("socket client: multi-byte characters split across chunks", () => {
  // "é" is 0xC3 0xA9, "→" is 0xE2 0x86 0x92, "😀" is four bytes.
  const text = "né → 😀";

  it("request: a response cut inside a UTF-8 sequence is decoded intact", async () => {
    const p = await rawServer((sock, msg) => {
      const bytes = Buffer.from(JSON.stringify({ id: msg.id, result: { text } }) + "\n", "utf8");
      const cut = bytes.indexOf(0xf0) + 2; // inside the 4-byte emoji
      sock.write(bytes.subarray(0, cut));
      setTimeout(() => sock.end(bytes.subarray(cut)), 30);
    });
    await expect(new HerdrSocketClient(p).request("pane.read")).resolves.toEqual({ text });
  });

  it("subscribe: a pushed event cut inside a UTF-8 sequence is decoded intact", async () => {
    const p = await rawServer((sock, msg) => {
      sock.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
      const bytes = Buffer.from(
        JSON.stringify({ event: "pane.output_matched", data: { matched_line: text } }) + "\n",
        "utf8",
      );
      const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
      setTimeout(() => sock.write(bytes.subarray(0, cut)), 10);
      setTimeout(() => sock.write(bytes.subarray(cut)), 40);
    });
    const seen: HerdrEnvelope[] = [];
    const sub = await new HerdrSocketClient(p).subscribe(["pane.created"], (e) => seen.push(e));
    await until(() => seen.length > 0);
    sub.close();
    expect(seen[0]!.data.matched_line).toBe(text);
  });
});

describe("state map: unknown HerdR statuses", () => {
  it("maps names that exist on Object.prototype to unknown, not to a function", () => {
    for (const status of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(mapAgentStatus(status)).toBe("unknown");
    }
  });
});

describe("state map: the shell sentinel", () => {
  it("sentinelRegex without a nonce matches any well-formed nonce; parseSentinel needs the exact one", () => {
    const any = new RegExp(sentinelRegex("ses.1"));
    expect(any.test("MIMIR_DONE:ses.1:0123456789abcdef:7")).toBe(true);
    expect(any.test("MIMIR_DONE:sesX1:0123456789abcdef:7")).toBe(false); // the id is escaped
    expect(any.test("MIMIR_DONE:ses.1:short:7")).toBe(false);
    expect(any.test("echo MIMIR_DONE:ses.1:0123456789abcdef:7")).toBe(false);
    const text = "noise\nMIMIR_DONE:ses.1:0123456789abcdef:7  \nmore";
    expect(parseSentinel("ses.1", "0123456789abcdef", text)).toBe(7);
    expect(parseSentinel("ses.1", "fedcba9876543210", text)).toBeUndefined();
    expect(parseSentinel("ses.1", undefined, text)).toBeUndefined();
  });

  it("releaseState: only idle and done count as a clean end", () => {
    expect(["idle", "done", "working", "blocked", "unknown", undefined].map(releaseState)).toEqual([
      "completed",
      "completed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
  });
});

describe("JsonFileBindingStore", () => {
  it("keeps both bindings when the first two puts run concurrently on a fresh store", async () => {
    const file = path.join(tmpDir(), "bindings.json");
    const store = new JsonFileBindingStore(file);
    await Promise.all([store.put(binding(1)), store.put(binding(2))]);
    expect((await store.list()).map((b) => b.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
    const onDisk = await new JsonFileBindingStore(file).list();
    expect(onDisk.map((b) => b.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
  });

  it("a failed write does not make every later put fail", async () => {
    const dir = path.join(tmpDir(), "data");
    fs.mkdirSync(dir, { mode: 0o700 });
    const store = new JsonFileBindingStore(path.join(dir, "bindings.json"));
    expect(await store.list()).toEqual([]);
    fs.chmodSync(dir, 0o500); // the temp file cannot be created
    await expect(store.put(binding(1))).rejects.toThrow();
    fs.chmodSync(dir, 0o700);
    await store.put(binding(2));
    const onDisk = await new JsonFileBindingStore(store.filePath).list();
    expect(onDisk.map((b) => b.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
  });
});

describe("createSession", () => {
  it("two concurrent calls with one idempotencyKey create one workspace and return the same pane", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ argv: ["sleep", "1"] });
    const [a, b] = await Promise.all([adapter.createSession(s), adapter.createSession(s)]);
    expect(fake.requests.filter((r) => r.method === "workspace.create")).toHaveLength(1);
    expect(fake.panes.size).toBe(1);
    expect(a.runtimeRef.paneId).toBe(b.runtimeRef.paneId);
  });

  it("a failed launch does not block a later call with the same key from seeing the failed session", async () => {
    const { adapter, fake } = await setup();
    const s = spec({ agentKind: "nope", argv: ["nope"] });
    const [x, y] = await Promise.all([
      rejection(adapter.createSession(s)),
      rejection(adapter.createSession(s)),
    ]);
    expect(x.code).toBe("capability_unavailable");
    expect(y.code).toBe("capability_unavailable");
    expect(fake.requests.filter((r) => r.method === "workspace.create")).toHaveLength(1);
    expect((await adapter.createSession(s)).state).toBe("failed");
  });

  it("shell kind: rejects a sessionId the shell would interpret in the sentinel line", async () => {
    const { adapter, fake } = await setup();
    for (const sessionId of ["ses_1;touch pwned", "ses_$(id)", "ses 1", "ses_`id`"]) {
      const err = await rejection(adapter.createSession(spec({ sessionId })));
      expect(err.code).toBe("validation_failed");
    }
    expect(fake.requests.some((r) => r.method === "workspace.create")).toBe(false);
  });

  it("shell kind: quotes words zsh would expand or treat as an assignment (`=cmd`, `NAME=value`)", async () => {
    const { adapter, fake } = await setup();
    await adapter.createSession(spec({ argv: ["echo", "=ls", "A=1", "--flag=v"] }));
    const text = fake.requests.find((r) => r.method === "pane.send_text")!.params.text;
    expect(text).toBe("echo '=ls' 'A=1' '--flag=v'; __mimir_rc=$?");
  });
});

describe("requestStop", () => {
  it("soft: a HerdR error while confirming does not leave the session stuck in stopping", async () => {
    const { adapter, fake } = await setup({
      agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    expect(c.states(s.sessionId).at(-1)).toBe("idle");
    fake.failNext.set("pane.process_info", {
      code: "server_unavailable",
      message: "busy",
      count: 1,
    });
    const err = await rejection(adapter.requestStop(s.sessionId, "soft"));
    expect(err.code).toBe("runtime_unavailable");
    expect(c.states(s.sessionId).slice(-2)).toEqual(["stopping", "idle"]);
    // not stopping any more, so status events are applied again
    fake.setStatus("w1:p1", "working");
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" && e.sessionId === s.sessionId && e.state === "running",
    );
  });

  it("soft: a failed Ctrl-C send reverts to the prior state", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    fake.failNext.set("pane.send_keys", { code: "server_unavailable", message: "busy", count: 1 });
    const err = await rejection(adapter.requestStop(s.sessionId, "soft"));
    expect(err.code).toBe("runtime_unavailable");
    expect(c.states(s.sessionId).slice(-2)).toEqual(["stopping", "running"]);
    await adapter.requestStop(s.sessionId, "soft");
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  });

  it("force: when pane.close fails the pane keeps its status watch", async () => {
    const { adapter, fake } = await setup({
      agentBehavior: () => ({ kind: "interactive" }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.failNext.set("pane.close", { code: "server_unavailable", message: "busy", count: 1 });
    const err = await rejection(adapter.requestStop(s.sessionId, "force"));
    expect(err.code).toBe("runtime_unavailable");
    expect(fake.panes.has("w1:p1")).toBe(true);
    await until(() =>
      fake
        .subscriptionEntries()
        .flat()
        .some((e) => e.type === "pane.agent_status_changed" && e.pane_id === "w1:p1"),
    );
    fake.setStatus("w1:p1", "working");
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" && e.sessionId === s.sessionId && e.state === "running",
    );
  });
});

describe("binding bookkeeping", () => {
  it("pane_updated handled after the session finished does not erase the persisted final state", async () => {
    const { adapter, fake, bindings } = await setup({
      agentBehavior: () => ({ kind: "interactive" }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const pane = fake.panes.get("w1:p1")!;
    // Both envelopes are read before the first one's agent.get round trip finishes.
    fake.setStatus("w1:p1", "done");
    pane.agent_session = { agent: "claude", kind: "id", source: "herdr:claude", value: "abc" };
    fake.push({ event: "pane_updated", data: { type: "pane_updated", pane: fake.paneInfo(pane) } });
    await c.waitFor(
      (e) =>
        e.kind === "session.state_changed" &&
        e.sessionId === s.sessionId &&
        e.state === "completed",
    );
    await until(async () => (await bindings.getBySessionId(s.sessionId))?.agentSessionId === "abc");
    expect((await bindings.getBySessionId(s.sessionId))?.finalState).toBe("completed");
  });
});
