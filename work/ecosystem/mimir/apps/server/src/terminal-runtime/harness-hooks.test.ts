import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { wireHarnessHooks } from "./harness-hooks.js";
import { normalizeHook } from "./hooks.js";
it("wires session-owned launch hooks without changing the user's settings", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-hooks-"));
  try {
    for (const kind of ["codex", "claude", "gemini", "opencode", "pi", "pi-signed", "omp"]) {
      const argv = [kind, "prompt"];
      const env = wireHarnessHooks(kind, argv, process.execPath, "/hook.js", join(root, kind));
      if (kind === "gemini")
        expect(
          JSON.parse(readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8")).hooks.AfterAgent,
        ).toHaveLength(1);
      else if (kind === "opencode")
        expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).plugin[0]).toMatch(/^file:/);
      else expect(argv.length).toBeGreaterThan(2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("Pi settlement ignores inner turns and continued runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hook-"));
  try {
    const file = join(root, "observation.json"),
      argv = ["pi", "prompt"];
    const hook = fileURLToPath(
      new URL("../../dist/terminal-runtime/hook-command.js", import.meta.url),
    );
    wireHarnessHooks("pi", argv, process.execPath, hook, file);
    const extension = await import(pathToFileURL(file + ".extension.mjs").href);
    const handlers: Record<string, (event: unknown, ctx?: unknown) => Promise<void>> = {};
    extension.default({
      on: (name: string, fn: (typeof handlers)[string]) => {
        handlers[name] = fn;
      },
    });
    expect(handlers.turn_end).toBeUndefined();
    await handlers.agent_settled!({}, { isIdle: () => false });
    expect(existsSync(file)).toBe(false);
    await handlers.agent_start!({});
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("running");
    await handlers.agent_settled!({}, { isIdle: () => true });
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("waiting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("vendor end events are waiting observations, never completion", () => {
  for (const type of ["agent-turn-complete", "AfterAgent", "StopFailure", "SessionEnd"])
    expect(normalizeHook({ type })?.state).toBe("waiting");
});

it("Command Code run boundaries and shutdown emit lifecycle facts without global settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "commandcode-hook-"));
  try {
    const file = join(root, "observation.json"),
      argv = ["commandcode", "prompt"];
    const hook = fileURLToPath(
      new URL("../../dist/terminal-runtime/hook-command.js", import.meta.url),
    );
    wireHarnessHooks("commandcode", argv, process.execPath, hook, file);
    const extension = await import(pathToFileURL(file + ".mod.mjs").href);
    const events: Record<string, (event?: unknown) => void> = {};
    let shutdown = () => {};
    extension.default({
      on: (name: string, handler: () => void) => {
        events[name] = handler;
      },
      hooks: (handlers: { onSessionEnd: () => void }) => {
        shutdown = handlers.onSessionEnd;
      },
    });
    events.run_start!();
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("running");
    events.run_end!({ result: { stopReason: "interrupted" } });
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("waiting");
    events.run_start!();
    shutdown();
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("waiting");
    expect(argv.slice(1, 3)).toEqual(["--mod", file + ".mod.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Devin preserves user hooks in a private snapshot and reports task boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-hook-"));
  const prior = process.env.MIMIR_DEVIN_CONFIG;
  try {
    const source = join(root, "config.json"),
      file = join(root, "observation.json");
    const original = JSON.stringify({ model: "existing", hooks: { Stop: [{ hooks: [] }] } });
    writeFileSync(source, original);
    process.env.MIMIR_DEVIN_CONFIG = source;
    const argv = ["devin", "prompt"];
    const hook = fileURLToPath(
      new URL("../../dist/terminal-runtime/hook-command.js", import.meta.url),
    );
    wireHarnessHooks("devin", argv, process.execPath, hook, file);
    const settings = JSON.parse(readFileSync(file + ".devin.json", "utf8"));
    expect(readFileSync(source, "utf8")).toBe(original);
    expect(settings.model).toBe("existing");
    expect(settings.read_config_from.claude).toBe(false);
    expect(settings.hooks.Stop).toHaveLength(2);
    for (const [event, state] of [
      ["UserPromptSubmit", "running"],
      ["Stop", "waiting"],
      ["SessionEnd", "waiting"],
    ]) {
      execFileSync("sh", ["-c", settings.hooks[event!].at(-1).hooks[0].command]);
      expect(JSON.parse(readFileSync(file, "utf8")).state).toBe(state);
    }
    writeFileSync(source, "[]");
    expect(() => wireHarnessHooks("devin", ["devin"], process.execPath, hook, file)).toThrow(
      "object",
    );
  } finally {
    if (prior === undefined) delete process.env.MIMIR_DEVIN_CONFIG;
    else process.env.MIMIR_DEVIN_CONFIG = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
