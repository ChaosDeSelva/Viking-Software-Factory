import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./env.js";

// The child process is replaced by a fake, so these tests start no server and bind no port.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  hidden: new Set<string>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => !mocks.hidden.has(p) && actual.existsSync(p),
  };
});

const { DEFAULT_WEB_ROOT, SERVER_MAIN, checkRuntime, runServer, spawnServer } =
  await import("./serve.js");

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((signal?: NodeJS.Signals) => {
    void signal;
    return true;
  });
}

let home: string;
let data: string;
let webRoot: string;
let child: FakeChild;
let stderrWrite: ReturnType<typeof vi.spyOn>;
let stdoutWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-spawn-"));
  data = join(home, "data");
  webRoot = join(home, "web");
  mkdirSync(data);
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
  child = new FakeChild();
  mocks.spawn.mockReset().mockReturnValue(child);
  mocks.hidden.clear();
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  MIMIR_DATA_DIR: data,
  MIMIR_WEB_ROOT: webRoot,
  ...extra,
});
const childEnv = (): Record<string, string> =>
  (mocks.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }])[2].env;
const written = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
const tick = () => new Promise((r) => setImmediate(r));
const signalListeners = () => ({
  int: process.listeners("SIGINT"),
  term: process.listeners("SIGTERM"),
});

describe("checkRuntime", () => {
  it("accepts no runtime and every runtime the server knows", () => {
    expect(() => checkRuntime(undefined)).not.toThrow();
    for (const r of [
      "fake",
      "herdr",
      "cli",
      "ssh",
      "tmux",
      "fleet",
      "tmux-interactive",
      "zellij",
      "cmux",
      "orca",
      "none",
    ]) {
      expect(() => checkRuntime(r), r).not.toThrow();
    }
  });
  it("rejects anything else with exit 2, listing the choices", () => {
    for (const bad of ["bogus", "", "FAKE", "fake "]) {
      let caught: unknown;
      try {
        checkRuntime(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(bad)).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode).toBe(2);
      expect((caught as CliError).message).toMatch(/--runtime must be one of fake, herdr, /);
    }
  });
});

describe("spawnServer environment", () => {
  it("runs the server entry with this Node and piped output", () => {
    spawnServer(baseEnv(), {}, () => undefined);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mocks.spawn.mock.calls[0] as [string, string[], { stdio: string[] }];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([SERVER_MAIN]);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("fails with exit 3, spawning nothing, when the server is not built", () => {
    mocks.hidden.add(SERVER_MAIN);
    let caught: unknown;
    try {
      spawnServer(baseEnv(), {}, () => undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(3);
    expect((caught as CliError).message).toContain(`server not found at ${SERVER_MAIN}`);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("takes host and port from config.json when the environment does not set them", () => {
    writeFileSync(join(data, "config.json"), JSON.stringify({ host: "127.0.0.2", port: 4999 }));
    spawnServer(baseEnv({ MIMIR_PORT: "", MIMIR_HOST: undefined }), {}, () => undefined);
    expect(childEnv()).toMatchObject({ MIMIR_HOST: "127.0.0.2", MIMIR_PORT: "4999" });
  });

  it("lets the environment win over config.json", () => {
    writeFileSync(join(data, "config.json"), JSON.stringify({ host: "127.0.0.2", port: 4999 }));
    spawnServer(baseEnv({ MIMIR_PORT: "0", MIMIR_HOST: "localhost" }), {}, () => undefined);
    expect(childEnv()).toMatchObject({ MIMIR_HOST: "localhost", MIMIR_PORT: "0" });
  });

  it("ignores config.json values of the wrong type", () => {
    for (const cfg of [{ host: 5, port: "80" }, { host: "", port: 1.5 }, null, "text", 7]) {
      mocks.spawn.mockClear();
      writeFileSync(join(data, "config.json"), JSON.stringify(cfg));
      spawnServer(baseEnv(), {}, () => undefined);
      expect(childEnv(), JSON.stringify(cfg)).not.toHaveProperty("MIMIR_HOST");
      expect(childEnv(), JSON.stringify(cfg)).not.toHaveProperty("MIMIR_PORT");
    }
  });

  it("fails with exit 2 on an unparseable config.json", () => {
    writeFileSync(join(data, "config.json"), "{not json");
    let caught: unknown;
    try {
      spawnServer(baseEnv(), {}, () => undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(2);
    expect((caught as CliError).message).toContain(join(data, "config.json"));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("skips config.json with ignoreConfig, even an unparseable one", () => {
    writeFileSync(join(data, "config.json"), "{not json");
    spawnServer(baseEnv(), { ignoreConfig: true }, () => undefined);
    expect(childEnv()).not.toHaveProperty("MIMIR_PORT");
  });

  it("drops empty and undefined variables, applies --runtime, then extraEnv last", () => {
    spawnServer(
      baseEnv({
        MIMIR_RUNTIME: "herdr",
        MIMIR_TICK_MS: "",
        MIMIR_AUTH_TOKEN: undefined,
        KEEP: "1",
      }),
      { runtime: "none", extraEnv: { MIMIR_ALLOWED_ROOTS: "", MIMIR_DATA_DIR: "/elsewhere" } },
      () => undefined,
    );
    const env = childEnv();
    expect(env["MIMIR_RUNTIME"]).toBe("none");
    expect(env["KEEP"]).toBe("1");
    expect(env).not.toHaveProperty("MIMIR_TICK_MS");
    expect(env).not.toHaveProperty("MIMIR_AUTH_TOKEN");
    expect(env["MIMIR_ALLOWED_ROOTS"]).toBe("");
    expect(env["MIMIR_DATA_DIR"]).toBe("/elsewhere");
  });

  it("keeps MIMIR_RUNTIME from the environment when --runtime is not given", () => {
    spawnServer(baseEnv({ MIMIR_RUNTIME: "herdr" }), {}, () => undefined);
    expect(childEnv()["MIMIR_RUNTIME"]).toBe("herdr");
  });

  it("serves the API only, with a warning, when the web root has no index.html", () => {
    const missing = join(home, "nope");
    spawnServer(baseEnv({ MIMIR_WEB_ROOT: missing }), {}, () => undefined);
    expect(childEnv()).not.toHaveProperty("MIMIR_WEB_ROOT");
    expect(written(stderrWrite)).toContain(`web app not found at ${missing}`);
  });

  it("passes an existing web root on, and falls back to the built web app by default", () => {
    spawnServer(baseEnv(), {}, () => undefined);
    expect(childEnv()["MIMIR_WEB_ROOT"]).toBe(webRoot);
    expect(written(stderrWrite)).toBe("");

    mocks.spawn.mockClear();
    mocks.hidden.add(join(DEFAULT_WEB_ROOT, "index.html"));
    spawnServer(baseEnv({ MIMIR_WEB_ROOT: "" }), {}, () => undefined);
    expect(childEnv()).not.toHaveProperty("MIMIR_WEB_ROOT");
    expect(written(stderrWrite)).toContain(`web app not found at ${DEFAULT_WEB_ROOT}`);
  });
});

describe("spawnServer output and exit", () => {
  it("splits output into lines across chunk boundaries and reports the bound URL", async () => {
    const lines: [string, string][] = [];
    const s = spawnServer(baseEnv(), {}, (line, stream) => lines.push([line, stream]));
    child.stdout.write("mimir server listening on http://127.0");
    child.stdout.write(".0.1:5123\nauth token: /x\nrun");
    child.stderr.write("warn one\n");
    child.stdout.write("time: fake\n");
    await expect(s.url).resolves.toBe("http://127.0.0.1:5123");
    await tick();
    expect(lines).toEqual(
      expect.arrayContaining([
        ["mimir server listening on http://127.0.0.1:5123", "stdout"],
        ["auth token: /x", "stdout"],
        ["runtime: fake", "stdout"],
        ["warn one", "stderr"],
      ]),
    );
    expect(lines).toHaveLength(4);
  });

  it("delivers a final line that has no trailing newline", async () => {
    const lines: [string, string][] = [];
    spawnServer(baseEnv(), {}, (line, stream) => lines.push([line, stream]));
    child.stderr.write("first\nfatal: could not open the store");
    child.stderr.end();
    child.stdout.end();
    await tick();
    await tick();
    expect(lines).toEqual([
      ["first", "stderr"],
      ["fatal: could not open the store", "stderr"],
    ]);
  });

  it("keeps a multi-byte character that is split across two chunks intact", async () => {
    const lines: string[] = [];
    spawnServer(baseEnv(), {}, (line) => lines.push(line));
    const bytes = Buffer.from("task: smörgåsbord ✓\n");
    const cut = bytes.indexOf(Buffer.from("ö")) + 1;
    child.stdout.write(bytes.subarray(0, cut));
    await tick();
    child.stdout.write(bytes.subarray(cut));
    await tick();
    expect(lines).toEqual(["task: smörgåsbord ✓"]);
  });

  it("resolves exited with the exit code, and stop() sends SIGTERM", async () => {
    const s = spawnServer(baseEnv(), {}, () => undefined);
    s.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 0, null);
    await expect(s.exited).resolves.toBe(0);
  });

  it("rejects the URL when the server exits before listening", async () => {
    const s = spawnServer(baseEnv(), {}, () => undefined);
    child.emit("exit", 7, null);
    await expect(s.exited).resolves.toBe(7);
    await expect(s.url).rejects.toThrow("server exited with code 7");
  });

  it("counts death by signal and a spawn error as failures", async () => {
    const killed = spawnServer(baseEnv(), {}, () => undefined);
    child.emit("exit", null, "SIGKILL");
    await expect(killed.exited).resolves.toBe(1);

    child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const failed = spawnServer(baseEnv(), {}, () => undefined);
    child.emit("error", new Error("spawn EAGAIN"));
    await expect(failed.exited).resolves.toBe(1);
    await expect(failed.url).rejects.toThrow("server exited with code 1");
  });
});

describe("runServer", () => {
  it("forwards output to the matching stream and returns 0 on a clean exit", async () => {
    const before = signalListeners();
    const done = runServer(baseEnv(), { runtime: "fake" });
    expect(childEnv()["MIMIR_RUNTIME"]).toBe("fake");
    child.stdout.write("to stdout\n");
    child.stderr.write("to stderr\n");
    await tick();
    expect(written(stdoutWrite)).toBe("to stdout\n");
    expect(written(stderrWrite)).toBe("to stderr\n");
    child.emit("exit", 0, null);
    await expect(done).resolves.toBe(0);
    expect(signalListeners()).toEqual(before);
  });

  it("forwards SIGINT and SIGTERM to the server as SIGTERM while it runs", async () => {
    const before = signalListeners();
    const done = runServer(baseEnv(), {});
    const added = {
      int: process.listeners("SIGINT").filter((l) => !before.int.includes(l)),
      term: process.listeners("SIGTERM").filter((l) => !before.term.includes(l)),
    };
    expect(added.int).toHaveLength(1);
    expect(added.term).toHaveLength(1);
    (added.int[0] as () => void)();
    (added.term[0] as () => void)();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGTERM"]]);
    child.emit("exit", 0, null);
    await expect(done).resolves.toBe(0);
    expect(signalListeners()).toEqual(before);
  });

  it("returns 3 for any failing exit, whatever the server's own code", async () => {
    const done = runServer(baseEnv(), {});
    child.emit("exit", 1, null);
    await expect(done).resolves.toBe(3);

    child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const killed = runServer(baseEnv(), {});
    child.emit("exit", null, "SIGKILL");
    await expect(killed).resolves.toBe(3);
  });
});
