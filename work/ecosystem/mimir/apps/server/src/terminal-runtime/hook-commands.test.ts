import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const roots: string[] = [];
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function observed() {
  const dir = mkdtempSync(join(tmpdir(), "mimir-hook-command-"));
  roots.push(dir);
  return { dir, file: join(dir, "observed.json") };
}
/** Runs a hook helper in this process, as the harness would start it. */
async function run(
  script: "hook-command" | "vendor-hook-command",
  args: string[],
  stdin: (string | Buffer)[] = [],
) {
  process.argv = [process.execPath, script + ".js", ...args];
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from(stdin, { objectMode: false }) as unknown as typeof process.stdin,
  );
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  vi.resetModules();
  await (script === "hook-command"
    ? import("./hook-command.js")
    : import("./vendor-hook-command.js"));
  return written.join("");
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

it("hook helper refuses a missing or relative observation path", async () => {
  await expect(run("hook-command", [])).rejects.toThrow("absolute hook observation path");
  await expect(
    run("hook-command", ["relative/observed.json", '{"type":"turn.end"}']),
  ).rejects.toThrow("absolute hook observation path");
  expect(existsSync("relative/observed.json")).toBe(false);
});
it("hook helper stores only the normalized fact from an argument payload", async () => {
  const { dir, file } = observed();
  await run("hook-command", [
    file,
    JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "secret summary" }),
  ]);
  const observation = read(file);
  expect(observation).toMatchObject({ state: "waiting", reason: "harness_awaiting_input" });
  expect(Object.keys(observation).sort()).toEqual(["id", "observedAt", "reason", "state"]);
  expect(readFileSync(file, "utf8")).not.toContain("secret summary");
  // The atomic write leaves no temporary file beside the observation.
  expect(readdirSync(dir)).toEqual(["observed.json"]);
});
it("hook helper reads a chunked stdin payload when no argument is given", async () => {
  const { file } = observed();
  const payload = JSON.stringify({
    hook_event_name: "PermissionRequest",
    tool_input: { command: "do-not-store" },
  });
  await run("hook-command", [file], [payload.slice(0, 10), Buffer.from(payload.slice(10))]);
  expect(read(file)).toMatchObject({ state: "waiting", reason: "harness_permission_request" });
  expect(readFileSync(file, "utf8")).not.toContain("do-not-store");
});
it("hook helper keeps prior evidence when the event is not a lifecycle fact", async () => {
  const { file } = observed();
  writeFileSync(file, "prior evidence");
  await run("hook-command", [file, JSON.stringify({ type: "completed" })]);
  expect(readFileSync(file, "utf8")).toBe("prior evidence");
});
it("hook helper rejects oversized or malformed input without overwriting prior evidence", async () => {
  const { file } = observed();
  writeFileSync(file, "prior evidence");
  await expect(run("hook-command", [file, " ".repeat(65537)])).rejects.toThrow(
    "Hook input limit exceeded",
  );
  await expect(
    run("hook-command", [file], ["{", " ".repeat(40000), " ".repeat(40000)]),
  ).rejects.toThrow("Hook input limit exceeded");
  await expect(run("hook-command", [file, "not json"])).rejects.toThrow(SyntaxError);
  await expect(run("hook-command", [file], [])).rejects.toThrow(SyntaxError);
  expect(readFileSync(file, "utf8")).toBe("prior evidence");
});

it("vendor helper is inert outside the launch that owns the observation file", async () => {
  const { dir, file } = observed();
  const stop = [JSON.stringify({ conversationId: "owned", fullyIdle: true })];
  // No arguments at all, as when a project plugin is discovered by an unrelated tool.
  expect(await run("vendor-hook-command", [])).toBe("");
  vi.stubEnv("MIMIR_HOOK_FILE", join(dir, "another-launch.json"));
  expect(await run("vendor-hook-command", [file, "agy", "SessionStart"], stop)).toBe("{}\n");
  vi.stubEnv("MIMIR_HOOK_FILE", "observed.json");
  await run("vendor-hook-command", ["observed.json", "rovo", "on_complete"], ["{}"]);
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  await run("vendor-hook-command", [file, "rovo"], ["{}"]);
  await run("vendor-hook-command", [file], ["{}"]);
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync("observed.json")).toBe(false);
});
it("vendor helper maps Rovo events and tolerates an empty payload", async () => {
  const { file } = observed();
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  expect(await run("vendor-hook-command", [file, "rovo", "on_tool_permission"], [])).toBe("");
  expect(read(file)).toMatchObject({ state: "waiting", reason: "harness_permission_request" });
  await run("vendor-hook-command", [file, "rovo", "on_error"], ["  \n"]);
  expect(read(file)).toMatchObject({ state: "blocked", reason: "harness_error" });
  const before = readFileSync(file, "utf8");
  await run("vendor-hook-command", [file, "rovo", "unknown_event"], ['{"success":true}']);
  expect(readFileSync(file, "utf8")).toBe(before);
});
it("vendor helper binds AGY to the first conversation and answers every event with an empty response", async () => {
  const { file } = observed();
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  const emit = (event: string, payload: object) =>
    run("vendor-hook-command", [file, "agy", event], [JSON.stringify(payload)]);
  // Without a conversation identity nothing can be attributed to this launch.
  expect(await emit("SessionStart", {})).toBe("{}\n");
  expect(await emit("SessionStart", { conversationId: "x".repeat(1025) })).toBe("{}\n");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(file + ".conversation")).toBe(false);
  // A Stop before any SessionStart cannot claim the launch either.
  await emit("Stop", { conversationId: "early", fullyIdle: true });
  expect(existsSync(file)).toBe(false);
  expect(await emit("SessionStart", { conversationId: "owned" })).toBe("{}\n");
  expect(readFileSync(file + ".conversation", "utf8")).toBe("owned");
  expect(read(file)).toMatchObject({ state: "running", reason: "harness_working" });
  const started = readFileSync(file, "utf8");
  await emit("SessionStart", { conversationId: "foreign" });
  await emit("Stop", { conversationId: "foreign", fullyIdle: true });
  expect(readFileSync(file + ".conversation", "utf8")).toBe("owned");
  expect(readFileSync(file, "utf8")).toBe(started);
  await emit("Stop", { conversationId: "owned", fullyIdle: true });
  expect(read(file)).toMatchObject({ state: "waiting", reason: "harness_awaiting_input" });
});
it("vendor helper rejects malformed or oversized payloads without overwriting prior evidence", async () => {
  const { file } = observed();
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  writeFileSync(file, "prior evidence");
  for (const payload of ["null", "[]", "1", '"text"'])
    await expect(
      run("vendor-hook-command", [file, "rovo", "on_complete"], [payload]),
    ).rejects.toThrow("Hook payload must be an object");
  await expect(
    run("vendor-hook-command", [file, "rovo", "on_complete"], ["{", " ".repeat(70000)]),
  ).rejects.toThrow("Hook payload exceeds 64 KiB");
  expect(readFileSync(file, "utf8")).toBe("prior evidence");
});
it("vendor helper fails without evidence when the launch directory is gone", async () => {
  const { dir } = observed();
  const file = join(dir, "removed", "observed.json");
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  await expect(
    run(
      "vendor-hook-command",
      [file, "agy", "SessionStart"],
      [JSON.stringify({ conversationId: "owned" })],
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("vendor helper lets a concurrent AGY SessionStart keep the conversation it claimed first", async () => {
  const { file } = observed();
  vi.stubEnv("MIMIR_HOOK_FILE", file);
  // Another hook process claims the launch between the existence check and the exclusive create.
  vi.doMock("node:fs", async (original) => {
    const actual = await original<typeof import("node:fs")>();
    return {
      ...actual,
      writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
        if (args[0] === file + ".conversation")
          actual.writeFileSync(file + ".conversation", "other");
        return actual.writeFileSync(...args);
      },
    };
  });
  try {
    expect(
      await run(
        "vendor-hook-command",
        [file, "agy", "SessionStart"],
        [JSON.stringify({ conversationId: "late" })],
      ),
    ).toBe("{}\n");
  } finally {
    vi.doUnmock("node:fs");
  }
  expect(readFileSync(file + ".conversation", "utf8")).toBe("other");
  expect(existsSync(file)).toBe(false);
});
