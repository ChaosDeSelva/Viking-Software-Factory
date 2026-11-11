import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { wireAgy, wireRovo, cleanupPlugin, vendorEvent } from "./vendor-hooks.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function root() {
  const p = mkdtempSync(join(tmpdir(), "vendor-hooks-"));
  roots.push(p);
  execFileSync("git", ["init", "--quiet", p]);
  return p;
}
it("preserves Rovo permissions and existing hooks in a private session config", () => {
  const dir = root(),
    source = join(dir, "original.yml"),
    file = join(dir, "session");
  const original =
    "toolPermissions:\n  default: ask\neventHooks:\n  events:\n    - name: on_complete\n      commands:\n        - command: user-hook\n";
  writeFileSync(source, original);
  const argv = ["acli", "rovodev", "run", "task"];
  wireRovo(argv, process.execPath, "/helper", file, source);
  expect(readFileSync(source, "utf8")).toBe(original);
  const config = parse(readFileSync(file + ".rovo.yml", "utf8"));
  expect(config.toolPermissions.default).toBe("ask");
  expect(config.eventHooks.events[0].commands).toHaveLength(2);
  expect(argv.slice(3, 5)).toEqual(["--config-file", file + ".rovo.yml"]);
  expect(vendorEvent("rovo", "on_error", {})).toBe("agent.error");
});
it("adds documented workspace hooks and removes only its own unchanged entry", () => {
  const dir = root();
  mkdirSync(join(dir, ".agents"));
  const path = join(dir, ".agents/hooks.json");
  writeFileSync(path, JSON.stringify({ operator: { Stop: [] } }));
  const one = wireAgy(dir, process.execPath, "/helper", join(dir, "one"));
  const two = wireAgy(dir, process.execPath, "/helper", join(dir, "two"));
  cleanupPlugin(one);
  expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty(two.key);
  cleanupPlugin(two);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ operator: { Stop: [] } });
  const three = wireAgy(dir, process.execPath, "/helper", join(dir, "three"));
  const changed = JSON.parse(readFileSync(path, "utf8"));
  changed[three.key].operator = true;
  writeFileSync(path, JSON.stringify(changed));
  cleanupPlugin(three);
  expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty(three.key);
});
it("rejects redirected hooks and removes an untouched generated file", () => {
  const dir = root(),
    other = root();
  mkdirSync(join(dir, ".agents"));
  symlinkSync(join(other, "hooks.json"), join(dir, ".agents/hooks.json"));
  writeFileSync(join(other, "hooks.json"), "{}");
  expect(() => wireAgy(dir, "node", "helper", "file")).toThrow("redirected");
  const clean = root(),
    plugin = wireAgy(clean, "node", "helper", "file");
  cleanupPlugin(plugin);
  expect(existsSync(plugin.path)).toBe(false);
});
it("ignores foreign conversations and emits idle only for the owned fully idle AGY event", () => {
  const dir = root(),
    file = join(dir, "observed");
  const helper = fileURLToPath(
    new URL("../../dist/terminal-runtime/vendor-hook-command.js", import.meta.url),
  );
  const emit = (event: string, payload: object, owned = true) =>
    execFileSync(process.execPath, [helper, file, "agy", event], {
      env: { ...process.env, MIMIR_HOOK_FILE: owned ? file : "other" },
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
  emit("SessionStart", { conversationId: "owned" });
  const initial = readFileSync(file, "utf8");
  emit("Stop", { conversationId: "foreign", fullyIdle: true });
  expect(readFileSync(file, "utf8")).toBe(initial);
  emit("Stop", { conversationId: "owned", fullyIdle: true }, false);
  expect(readFileSync(file, "utf8")).toBe(initial);
  emit("Stop", { conversationId: "owned", fullyIdle: true });
  expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("waiting");
});

it("refuses redirected Rovo outputs without touching the target or argv", () => {
  const dir = root(),
    file = join(dir, "session"),
    target = join(dir, "operator.yml");
  writeFileSync(target, "operator content");
  symlinkSync(target, file + ".rovo.yml");
  const argv = ["acli", "rovodev", "run", "task"];
  expect(() => wireRovo(argv, "node", "helper", file, join(dir, "absent.yml"))).toThrow(
    "redirected",
  );
  expect(readFileSync(target, "utf8")).toBe("operator content");
  expect(argv).toEqual(["acli", "rovodev", "run", "task"]);
});

it.each(["null", "[]", "1", '"text"'])(
  "rejects malformed vendor payload %s without overwriting prior evidence",
  (payload) => {
    const dir = root(),
      file = join(dir, "observed");
    writeFileSync(file, "prior evidence");
    const helper = fileURLToPath(
      new URL("../../dist/terminal-runtime/vendor-hook-command.js", import.meta.url),
    );
    expect(() =>
      execFileSync(process.execPath, [helper, file, "rovo", "on_complete"], {
        env: { ...process.env, MIMIR_HOOK_FILE: file },
        input: payload,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe("prior evidence");
  },
);

it("keeps unsupported vendor events unknown and never turns hook completion into delivery approval", () => {
  for (const kind of ["grok", "kimi", "cursor", "muse", "devin", "command-code", "orca"]) {
    expect(vendorEvent(kind, "completed", { success: true })).toBeNull();
    expect(vendorEvent(kind, "on_complete", { success: true })).toBeNull();
  }
  expect(vendorEvent("agy", "Stop", { fullyIdle: "true" })).toBeNull();
  expect(vendorEvent("agy", "Stop", {})).toBeNull();
  expect(vendorEvent("rovo", "unknown", {})).toBeNull();
});

it("replaces an existing Rovo config with private permissions", () => {
  const dir = root(),
    file = join(dir, "session");
  writeFileSync(file + ".rovo.yml", "old", { mode: 0o644 });
  wireRovo(["acli", "rovodev", "run", "task"], "node", "helper", file, join(dir, "absent.yml"));
  expect(statSync(file + ".rovo.yml").mode & 0o777).toBe(0o600);
});
it("rejects oversized argv hook input without overwriting prior evidence", () => {
  const dir = root(),
    file = join(dir, "observed");
  writeFileSync(file, "prior evidence");
  const helper = fileURLToPath(
    new URL("../../dist/terminal-runtime/hook-command.js", import.meta.url),
  );
  expect(() =>
    execFileSync(process.execPath, [helper, file, " ".repeat(65537)], { stdio: "pipe" }),
  ).toThrow();
  expect(readFileSync(file, "utf8")).toBe("prior evidence");
});
it.each(["", "# no settings yet\n"])(
  "treats an empty Rovo configuration %j as no settings",
  (raw) => {
    const dir = root(),
      source = join(dir, "config.yml"),
      file = join(dir, "session");
    writeFileSync(source, raw);
    const argv = ["acli", "rovodev", "run", "task"];
    wireRovo(argv, "node", "helper", file, source);
    const config = parse(readFileSync(file + ".rovo.yml", "utf8"));
    expect(config.eventHooks.events.map((event: { name: string }) => event.name)).toEqual([
      "on_complete",
      "on_error",
      "on_tool_permission",
    ]);
    expect(argv).toEqual(["acli", "rovodev", "run", "--config-file", file + ".rovo.yml", "task"]);
  },
);
it.each([
  ["a non-object document", "- a\n- b\n", "must be an object"],
  ["non-object event hooks", "eventHooks: 3\n", "must be an object"],
  ["non-list events", "eventHooks:\n  events: {}\n", "events must be an array"],
  ["a non-object event", "eventHooks:\n  events:\n    - text\n", "must be an object"],
  [
    "non-list commands",
    "eventHooks:\n  events:\n    - name: on_error\n      commands: run-me\n",
    "commands must be an array",
  ],
  ["an oversized file", "# " + "x".repeat(1024 * 1024) + "\n", "exceeds 1 MiB"],
])("refuses a Rovo configuration with %s and writes nothing", (_name, raw, message) => {
  const dir = root(),
    source = join(dir, "config.yml"),
    file = join(dir, "session");
  writeFileSync(source, raw);
  const argv = ["acli", "rovodev", "run", "task"];
  expect(() => wireRovo(argv, "node", "helper", file, source)).toThrow(message);
  expect(existsSync(file + ".rovo.yml")).toBe(false);
  expect(argv).toEqual(["acli", "rovodev", "run", "task"]);
});
it("adds missing Rovo events beside other configured events", () => {
  const dir = root(),
    source = join(dir, "config.yml"),
    file = join(dir, "session");
  writeFileSync(
    source,
    "eventHooks:\n  enabled: true\n  events:\n    - name: on_session_start\n    - name: on_error\n",
  );
  wireRovo(["acli", "rovodev", "run", "task"], "/node path", "/helper's", file, source);
  const config = parse(readFileSync(file + ".rovo.yml", "utf8"));
  expect(config.eventHooks.enabled).toBe(true);
  expect(
    config.eventHooks.events.map((event: { name: string; commands?: unknown[] }) => [
      event.name,
      event.commands?.length,
    ]),
  ).toEqual([
    ["on_session_start", undefined],
    ["on_error", 1],
    ["on_complete", 1],
    ["on_tool_permission", 1],
  ]);
  expect(config.eventHooks.events[1].commands[0].command).toBe(
    `'/node path' '/helper'\\''s' '${file}' 'rovo' 'on_error'`,
  );
});
it("refuses AGY hooks that are redirected, oversized, malformed or already claimed", () => {
  const redirected = root(),
    elsewhere = root();
  symlinkSync(elsewhere, join(redirected, ".agents"));
  expect(() => wireAgy(redirected, "node", "helper", "file")).toThrow(
    "redirected AGY hook directory",
  );
  const plain = root();
  writeFileSync(join(plain, ".agents"), "");
  expect(() => wireAgy(plain, "node", "helper", "file")).toThrow("redirected AGY hook directory");
  const dir = root(),
    path = join(dir, ".agents", "hooks.json");
  mkdirSync(join(dir, ".agents"));
  for (const [raw, message] of [
    [JSON.stringify({ padding: "x".repeat(1024 * 1024) }), "exceed 1 MiB"],
    ["[]", "must be an object"],
    ["{", "JSON"],
  ] as const) {
    writeFileSync(path, raw);
    expect(() => wireAgy(dir, "node", "helper", "file")).toThrow(message);
    expect(readFileSync(path, "utf8")).toBe(raw);
  }
  writeFileSync(path, "{}");
  wireAgy(dir, "node", "helper", "file");
  const claimed = readFileSync(path, "utf8");
  expect(() => wireAgy(dir, "node", "helper", "file")).toThrow("already exist");
  expect(readFileSync(path, "utf8")).toBe(claimed);
});
it("excludes a generated AGY hook file from git once", () => {
  const dir = root();
  const exclude = join(dir, ".git", "info", "exclude");
  rmSync(exclude, { force: true });
  const first = wireAgy(dir, "node", "helper", join(dir, "one"));
  expect(readFileSync(exclude, "utf8").split("\n")).toContain("/.agents/hooks.json");
  cleanupPlugin(first);
  wireAgy(dir, "node", "helper", join(dir, "two"));
  expect(readFileSync(exclude, "utf8").match(/\/\.agents\/hooks\.json/g)).toHaveLength(1);
  // A workspace outside git cannot hide the generated file, so nothing is wired.
  const loose = mkdtempSync(join(tmpdir(), "vendor-hooks-loose-"));
  roots.push(loose);
  expect(() => wireAgy(loose, "node", "helper", "file")).toThrow();
  expect(existsSync(join(loose, ".agents", "hooks.json"))).toBe(false);
});
it("leaves a hook file untouched when it is missing, redirected, unreadable or keeps other entries", () => {
  const dir = root(),
    path = join(dir, ".agents", "hooks.json");
  const plugin = wireAgy(dir, "node", "helper", "file");
  const owned = readFileSync(path, "utf8");
  for (const replacement of ["{ editing", "[]"]) {
    writeFileSync(path, replacement);
    cleanupPlugin(plugin);
    expect(readFileSync(path, "utf8")).toBe(replacement);
  }
  // Another session's entry added after launch keeps the generated file in place.
  writeFileSync(path, JSON.stringify({ ...JSON.parse(owned), other: {} }));
  cleanupPlugin(plugin);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: {} });
  rmSync(path);
  expect(() => cleanupPlugin(plugin)).not.toThrow();
  const target = join(dir, "target.json");
  writeFileSync(target, owned);
  symlinkSync(target, path);
  cleanupPlugin(plugin);
  expect(readFileSync(target, "utf8")).toBe(owned);
  rmSync(path);
  mkdirSync(path);
  cleanupPlugin(plugin);
  expect(existsSync(path)).toBe(true);
  // A redirected hook directory is not followed either.
  const real = root(),
    linked = root();
  const moved = wireAgy(real, "node", "helper", "file");
  rmSync(join(linked, ".git"), { recursive: true });
  symlinkSync(join(real, ".agents"), join(linked, ".agents"));
  cleanupPlugin({ ...moved, path: join(linked, ".agents", "hooks.json") });
  expect(Object.keys(JSON.parse(readFileSync(moved.path, "utf8")))).toEqual([moved.key]);
});
it("maps the documented vendor lifecycle events", () => {
  expect(vendorEvent("agy", "Stop", { fullyIdle: false })).toBe("turn.start");
  expect(vendorEvent("agy", "PreInvocation", {})).toBe("turn.start");
  expect(vendorEvent("agy", "PostInvocation", {})).toBeNull();
  expect(vendorEvent("rovo", "on_session_end", {})).toBe("turn.end");
  for (const name of ["on_user_prompt", "on_tool_start", "on_tool_end", "on_session_start"])
    expect(vendorEvent("rovo", name, {})).toBe("turn.start");
});
it("removes its temporary Rovo file when the final rename fails", async () => {
  const dir = root(),
    file = join(dir, "session");
  vi.doMock("node:fs", async (original) => {
    const actual = await original<typeof import("node:fs")>();
    return {
      ...actual,
      renameSync: () => {
        throw Object.assign(new Error("EXDEV: rename failed"), { code: "EXDEV" });
      },
    };
  });
  try {
    vi.resetModules();
    const isolated = await import("./vendor-hooks.js");
    const argv = ["acli", "rovodev", "run", "task"];
    expect(() => isolated.wireRovo(argv, "node", "helper", file, join(dir, "absent.yml"))).toThrow(
      "rename failed",
    );
    expect(argv).toEqual(["acli", "rovodev", "run", "task"]);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
  expect(readdirSync(dir).filter((name) => name.startsWith("session"))).toEqual([]);
});
