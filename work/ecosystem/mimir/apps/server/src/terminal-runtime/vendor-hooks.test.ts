import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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
