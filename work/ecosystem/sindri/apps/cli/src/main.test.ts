import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApproveOptions } from "./approve.js";
import type { CliError as CliErrorType } from "./env.js";

/** A CliError from the env.js instance main.ts loaded (modules are reset per run). */
const cliError = async (message: string, code: number): Promise<CliErrorType> => {
  const { CliError } = await import("./env.js");
  return new CliError(message, code);
};

/**
 * main.ts parses process.argv when imported, so each run re-imports it with the command
 * modules replaced by these fakes; the commands themselves have their own tests.
 */
const m = vi.hoisted(() => ({
  init: vi.fn(),
  showToken: vi.fn(),
  doctor: vi.fn(),
  start: vi.fn(),
  exportData: vi.fn(),
  approve: vi.fn(),
  demo: vi.fn(),
  question: vi.fn(),
  rlClose: vi.fn(),
  createInterface: vi.fn(),
}));
vi.mock("./init.js", () => ({ init: m.init, showToken: m.showToken }));
vi.mock("./doctor.js", () => ({ doctor: m.doctor }));
vi.mock("./start.js", () => ({ start: m.start }));
vi.mock("./export.js", () => ({ exportData: m.exportData }));
vi.mock("./approve.js", () => ({ approve: m.approve }));
vi.mock("./demo.js", () => ({ demo: m.demo }));
vi.mock("node:readline/promises", () => ({ createInterface: m.createInterface }));

const argv = process.argv;
const ttys = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
beforeEach(() => {
  vi.resetAllMocks();
  m.createInterface.mockReturnValue({ question: m.question, close: m.rlClose });
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  process.stdin.isTTY = ttys.stdin;
  process.stderr.isTTY = ttys.stderr;
  vi.restoreAllMocks();
});

async function sindri(...args: string[]) {
  vi.resetModules();
  process.argv = ["node", "sindri", ...args];
  process.exitCode = undefined;
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((stderr += String(s)), true));
  try {
    await import("./main.js");
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
  const code = process.exitCode;
  process.exitCode = undefined;
  return { stdout, stderr, code };
}

describe("sindri (main)", () => {
  it("init prints paths as text, or the result as one JSON line", async () => {
    const r = {
      dataDir: "/d",
      configPath: "/d/config.json",
      tokenPath: "/d/t",
      tokenCreated: true,
    };
    m.init.mockReturnValue(r);
    const text = await sindri("init");
    expect(text.stdout).toBe(
      "data dir: /d\nconfig: /d/config.json (environment variables override it)\ntoken: /d/t (created)\n",
    );
    expect(text.code).toBeUndefined();
    m.init.mockReturnValue({ ...r, tokenCreated: false });
    expect((await sindri("init")).stdout).toContain("token: /d/t (already present)");
    expect(JSON.parse((await sindri("init", "--json")).stdout)).toEqual({
      ...r,
      tokenCreated: false,
    });
  });

  it("token show prints the token", async () => {
    m.showToken.mockReturnValue("t0k");
    expect((await sindri("token", "show")).stdout).toBe("t0k\n");
    expect((await sindri("token", "show", "--json")).stdout).toBe('{"token":"t0k"}\n');
  });

  it("doctor prints aligned checks and exits 3 when a required check fails", async () => {
    m.doctor.mockResolvedValue({
      ok: false,
      checks: [
        { name: "node", status: "ok", detail: "25.0.0", required: true },
        { name: "git", status: "fail", detail: "missing", required: true },
      ],
    });
    const r = await sindri("doctor");
    expect(r.stdout).toBe(`OK   ${"node".padEnd(13)} 25.0.0\nFAIL ${"git".padEnd(13)} missing\n`);
    expect(r.code).toBe(3);
    m.doctor.mockResolvedValue({ ok: true, checks: [] });
    const ok = await sindri("doctor", "--json");
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true, checks: [] });
    expect(ok.code).toBeUndefined();
  });

  it("start prints the URL and closes, then exits 0, on SIGINT or SIGTERM", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    m.start.mockResolvedValue({ url: "http://127.0.0.1:9", close });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const sig of signals) {
      const before = new Set(signals.flatMap((s) => process.listeners(s)));
      const r = await sindri("start", ...(sig === "SIGINT" ? [] : ["--json"]));
      const added = new Map(
        signals.map((s) => [s, process.listeners(s).filter((l) => !before.has(l))]),
      );
      try {
        expect(r.stdout).toBe(
          sig === "SIGINT"
            ? "sindri listening on http://127.0.0.1:9\n"
            : '{"url":"http://127.0.0.1:9"}\n',
        );
        expect(added.get("SIGINT")).toHaveLength(1);
        expect(added.get("SIGTERM")).toHaveLength(1);
        exit.mockClear();
        close.mockClear();
        (added.get(sig)![0] as () => void)();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(close).toHaveBeenCalledOnce();
      } finally {
        for (const [s, ls] of added) for (const l of ls) process.off(s, l);
      }
    }
  });

  it("export passes --out and --force through", async () => {
    m.exportData.mockReturnValue({ out: "/o.zip", bytes: 12 });
    expect((await sindri("export", "--out", "/o.zip")).stdout).toBe(
      "exported 12 bytes to /o.zip\n",
    );
    expect(m.exportData).toHaveBeenLastCalledWith("/o.zip", { force: false });
    await sindri("export", "--out", "/o.zip", "--force", "--json");
    expect(m.exportData).toHaveBeenLastCalledWith("/o.zip", { force: true });
    const missing = await sindri("export");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--out");
  });

  it("demo prints the next steps, with the planted test only when asked", async () => {
    const r = {
      repoPath: "/r",
      ticketPath: "/t.json",
      projectId: "prj_1",
      intakeId: "int_1",
      failingTest: null,
      bootstrap: { indexed: 4, skipped: 0 },
      url: "http://127.0.0.1:7800/#/inbox?project=prj_1",
    };
    m.demo.mockResolvedValue(r);
    const plain = await sindri("demo");
    expect(m.demo).toHaveBeenLastCalledWith({ failingTest: false });
    expect(plain.stdout).toContain("demo repo: /r\n");
    expect(plain.stdout).toContain("(bootstrap indexed 4 files)");
    expect(plain.stdout).not.toContain("planted failing test");
    expect(plain.stdout.trimEnd().endsWith(r.url)).toBe(true);
    m.demo.mockResolvedValue({ ...r, failingTest: "test/planted.test.js" });
    const planted = await sindri("demo", "--dir", "/x", "--with-failing-test");
    expect(m.demo).toHaveBeenLastCalledWith({ dir: "/x", failingTest: true });
    expect(planted.stdout).toContain("planted failing test: test/planted.test.js (fails once)");
  });

  describe("approve", () => {
    it("rejects an unknown kind with exit 2, as JSON under --json", async () => {
      const r = await sindri("approve", "task", "t1");
      expect(r).toMatchObject({ code: 2, stdout: "" });
      expect(r.stderr).toBe("sindri: unknown kind task: use spec, plan or pr\n");
      const j = await sindri("approve", "task", "t1", "--json");
      expect(JSON.parse(j.stdout)).toEqual({
        ok: false,
        error: "unknown kind task: use spec, plan or pr",
        exitCode: 2,
      });
      expect(m.approve).not.toHaveBeenCalled();
    });

    it("without a TTY opens no readline and answers prompts with an empty string", async () => {
      process.stdin.isTTY = false;
      m.approve.mockImplementation(async (_k: string, _id: string, o: ApproveOptions) => {
        expect(o.io.isTTY).toBe(false);
        expect(await o.io.prompt("q? ")).toBe("");
        throw await cliError("needs a TTY", 2);
      });
      const r = await sindri("approve", "spec", "s1");
      expect(r.code).toBe(2);
      expect(m.createInterface).not.toHaveBeenCalled();
    });

    it("on a TTY prompts through readline on stderr, prints the approver and closes", async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;
      m.question.mockResolvedValue("yes");
      m.approve.mockImplementation(async (kind: string, id: string, o: ApproveOptions) => {
        expect(o.io.isTTY).toBe(true);
        o.io.write("About to approve\n");
        expect(await o.io.prompt("Approve? ")).toBe("yes");
        return { kind, id, approvedBy: "local:me/cli#aps_1" };
      });
      const r = await sindri("approve", "plan", "p1");
      expect(r.stdout).toBe("plan p1 approved by local:me/cli#aps_1\n");
      expect(r.stderr).toBe("About to approve\n");
      expect(m.question).toHaveBeenCalledWith("Approve? ");
      expect(m.createInterface).toHaveBeenCalledWith(
        expect.objectContaining({ input: process.stdin, output: process.stderr, terminal: true }),
      );
      expect(m.rlClose).toHaveBeenCalledOnce();
      const j = await sindri("approve", "pr", "e1", "--json");
      expect(JSON.parse(j.stdout)).toEqual({
        kind: "pr",
        id: "e1",
        approvedBy: "local:me/cli#aps_1",
      });
    });

    it("closes readline when approval fails, and reports a TTY only when stderr is one too", async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = false;
      m.approve.mockImplementation(async (_k: string, _id: string, o: ApproveOptions) => {
        expect(o.io.isTTY).toBe(false);
        throw await cliError("needs a TTY", 2);
      });
      expect((await sindri("approve", "spec", "s1")).code).toBe(2);
      expect(m.rlClose).toHaveBeenCalledOnce();
    });
  });

  describe("errors", () => {
    it("maps an unexpected error to exit 3 on stderr, or JSON under --json", async () => {
      m.showToken.mockImplementation(() => {
        throw new Error("EISDIR: illegal operation on a directory");
      });
      const r = await sindri("token", "show");
      expect(r).toEqual({
        code: 3,
        stdout: "",
        stderr: "sindri: EISDIR: illegal operation on a directory\n",
      });
      const j = await sindri("token", "show", "--json");
      expect(JSON.parse(j.stdout)).toMatchObject({ ok: false, exitCode: 3 });
    });

    it("exits 0 for --help and 2 for an unknown command", async () => {
      const help = await sindri("--help");
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Usage: sindri");
      const bogus = await sindri("bogus");
      expect(bogus.code).toBe(2);
      expect(bogus.stderr).toContain("unknown command 'bogus'");
    });
  });
});
