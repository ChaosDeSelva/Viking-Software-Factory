import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTerminalBackend } from "./backend.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// Stand-in terminal CLIs. They record their arguments and print scripted replies; nothing real runs.
const stubSource = (replies: string) => `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
const replies = ${replies};
for (const [match, reply] of replies) {
  if (args.join(" ").includes(match)) {
    if (reply.fail) { process.stderr.write(reply.fail); process.exit(1); }
    process.stdout.write(reply.out ?? "");
    process.exit(0);
  }
}
`;
function stubs(tools: Record<string, [string, { out?: string; fail?: string }][]>) {
  const home = mkdtempSync(join(tmpdir(), "mimir-backend-"));
  roots.push(home);
  const log = join(home, "calls.jsonl");
  for (const [name, replies] of Object.entries(tools))
    writeFileSync(join(home, name), stubSource(JSON.stringify(replies)), { mode: 0o700 });
  vi.stubEnv("STUB_LOG", log);
  vi.stubEnv("PATH", [home, dirname(process.execPath), "/usr/bin", "/bin"].join(":"));
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { home, calls };
}
function tmux(replies: [string, { out?: string; fail?: string }][]) {
  const stub = stubs({ tmux: replies });
  vi.stubEnv("MIMIR_TMUX_BIN", join(stub.home, "tmux"));
  const backend = new NativeTerminalBackend("tmux-interactive", stub.home);
  // Every call goes to a private server named after the home, never the operator's default one.
  const tail = () => stub.calls().map((call) => call.slice(4));
  return { ...stub, backend, tail };
}
it("drives a private tmux server with the prompt as literal keys behind an identity check", async () => {
  const t = tmux([
    ["-V", { out: "tmux 3.4\n" }],
    ["new-session", { out: "%7\n" }],
    ["display-message", { out: "mimir-label\n" }],
    ["capture-pane", { out: "visible\n" }],
  ]);
  expect(await t.backend.health()).toBe(true);
  expect(await t.backend.create("mimir-label", "/work dir")).toBe("%7");
  await t.backend.send("%7", "a prompt; $(literal)", "mimir-label");
  await t.backend.key("%7", "C-c", "mimir-label");
  expect(await t.backend.capture("%7", 50, "mimir-label")).toBe("visible\n");
  await t.backend.close("%7", "mimir-label");
  const calls = t.calls();
  expect(new Set(calls.map((call) => call.slice(0, 4).join(" ")))).toEqual(
    new Set([`-L ${calls[0]![1]} -f /dev/null`]),
  );
  expect(calls[0]![1]).toMatch(/^mimir-[0-9a-f]{12}$/);
  const identity = ["display-message", "-p", "-t", "%7", "#{session_name}"];
  expect(t.tail()).toEqual([
    ["-V"],
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "mimir-label",
      "-c",
      "/work dir",
      "/bin/sh",
    ],
    identity,
    ["send-keys", "-t", "%7", "-l", "--", "a prompt; $(literal)"],
    ["send-keys", "-t", "%7", "Enter"],
    identity,
    ["send-keys", "-t", "%7", "C-c"],
    identity,
    ["capture-pane", "-p", "-t", "%7", "-S", "-50"],
    identity,
    ["kill-session", "-t", "mimir-label"],
  ]);
}, 120000);
it("refuses to act on a pane that now belongs to another session", async () => {
  const t = tmux([["display-message", { out: "someone-else\n" }]]);
  await expect(t.backend.send("%7", "text", "mimir-label")).rejects.toThrow(
    "Terminal identity changed",
  );
  await expect(t.backend.key("%7", "Enter", "mimir-label")).rejects.toThrow(
    "Terminal identity changed",
  );
  await expect(t.backend.capture("%7", 10, "mimir-label")).rejects.toThrow(
    "Terminal identity changed",
  );
  await expect(t.backend.close("%7", "mimir-label")).rejects.toThrow("Terminal identity changed");
  // Only identity probes ran: nothing was typed, captured or closed.
  expect(t.tail().every((call) => call[0] === "display-message")).toBe(true);
}, 120000);
it.each([
  ["an empty target", ""],
  ["a multi-line target", "%1\n%2\n"],
  ["an oversized target", "%".repeat(257)],
])(
  "rejects %s from terminal creation",
  async (_name, out) => {
    const t = tmux([["new-session", { out }]]);
    await expect(t.backend.create("mimir-label", "/work")).rejects.toThrow(
      "Invalid terminal target",
    );
  },
  120000,
);
it("rejects unsupported keys before contacting the terminal", async () => {
  const t = tmux([]);
  await expect(t.backend.key("%7", "q", "mimir-label")).rejects.toThrow("Unsupported key");
  expect(t.calls()).toEqual([]);
}, 120000);
it("reports an unhealthy backend when the terminal CLI fails or is missing", async () => {
  const t = tmux([["-V", { fail: "no server" }]]);
  expect(await t.backend.health()).toBe(false);
  vi.stubEnv("MIMIR_TMUX_BIN", join(t.home, "missing-tmux"));
  expect(await t.backend.health()).toBe(false);
  // The bridge backends fail closed the same way when their CLI is absent.
  expect(await new NativeTerminalBackend("zellij", t.home).health()).toBe(false);
}, 120000);
it.each([
  ["PONG", true],
  ["only processes started inside cmux can connect", false],
  ["Authentication required", false],
])(
  "classifies cmux reachability %j",
  async (ping, healthy) => {
    const { home } = stubs({ cmux: [["ping", { out: ping }]] });
    expect(await new NativeTerminalBackend("cmux", home).health()).toBe(healthy);
  },
  120000,
);
it("routes bridge operations to the Orca CLI and refuses the Escape key it cannot send", async () => {
  const { home, calls } = stubs({
    orca: [
      [
        "terminal create",
        { out: JSON.stringify({ ok: true, result: { terminal: { handle: "term-1" } } }) },
      ],
      ["terminal read", { out: JSON.stringify({ ok: true, result: { tail: ["one", "two"] } }) }],
      ["terminal", { out: JSON.stringify({ ok: true }) }],
    ],
  });
  vi.stubEnv("MIMIR_ORCA_WORKTREE_ID", "wt-1");
  const backend = new NativeTerminalBackend("orca", home);
  expect(await backend.create("mimir-label", "/work")).toBe("term-1");
  await backend.send("term-1", "a prompt; $(literal)", "mimir-label");
  await backend.key("term-1", "Enter", "mimir-label");
  await expect(backend.key("term-1", "Escape", "mimir-label")).rejects.toThrow(
    "Orca does not expose Escape",
  );
  expect(await backend.capture("term-1", 20, "mimir-label")).toBe("one\ntwo");
  await backend.close("term-1", "mimir-label");
  expect(calls()).toEqual([
    ["terminal", "create", "--worktree", "id:wt-1", "--title", "mimir-label", "--json"],
    [
      "terminal",
      "send",
      "--terminal",
      "term-1",
      "--text",
      "a prompt; $(literal)",
      "--enter",
      "--json",
    ],
    ["terminal", "send", "--terminal", "term-1", "--text", "", "--enter", "--json"],
    ["terminal", "read", "--terminal", "term-1", "--limit", "20", "--json"],
    ["terminal", "close", "--terminal", "term-1", "--json"],
  ]);
}, 120000);
