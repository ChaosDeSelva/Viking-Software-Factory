import { describe, expect, it } from "vitest";
import { formatArgv, parseArgv, problemsOf, toForm, toProfile } from "./profile-form.js";
import type { ExecutionProfile } from "./types.js";

describe("parseArgv", () => {
  it("splits on whitespace and keeps quoted text together", () => {
    expect(parseArgv("  make   lint ").argv).toEqual(["make", "lint"]);
    expect(parseArgv(`pytest -k "not slow" 'my tests'`).argv).toEqual([
      "pytest",
      "-k",
      "not slow",
      "my tests",
    ]);
    expect(parseArgv(`--name="a b" it's" "fine'`).argv).toEqual(["--name=a b", `its" "fine`]);
    expect(parseArgv(`run ''`).argv).toEqual(["run", ""]);
  });

  it("has no shell features: backslashes, variables and operators stay as typed", () => {
    expect(parseArgv("echo $HOME a\\ b && ls | wc").argv).toEqual([
      "echo",
      "$HOME",
      "a\\",
      "b",
      "&&",
      "ls",
      "|",
      "wc",
    ]);
  });

  it("reports a quote that is never closed", () => {
    expect(parseArgv(`make "lint`).unclosed).toBe(true);
    expect(parseArgv(`make "lint"`).unclosed).toBe(false);
  });
});

describe("formatArgv", () => {
  it("writes a command line that parses back to the same argv", () => {
    for (const argv of [
      ["make", "lint"],
      ["sh", "run tests.sh"],
      ["echo", "it's"],
      ["echo", `both ' and "`],
      ["x", ""],
      ["a\\b", "$HOME"],
    ])
      expect(parseArgv(formatArgv(argv)), formatArgv(argv)).toEqual({ argv, unclosed: false });
    expect(formatArgv(["sh", "run tests.sh"])).toBe("sh 'run tests.sh'");
  });
});

describe("quoting shared with the operator dashboard", () => {
  it("reads and writes an argument holding both quote characters the same way it does", () => {
    const argv = ["echo", `a'b"c`, "back\\slash"];
    expect(formatArgv(argv)).toBe(`echo "a'b\\"c" back\\slash`);
    expect(parseArgv(formatArgv(argv))).toEqual({ argv, unclosed: false });
    // Only a quote or a backslash is escaped, and only inside double quotes.
    expect(parseArgv(`"a\\nb" 'c\\"d'`).argv).toEqual(["a\\nb", `c\\"d`]);
  });
});

describe("profile form conversion", () => {
  const full: ExecutionProfile = {
    checks: [
      {
        id: "lint",
        title: "make lint",
        command: ["make", "lint"],
        cwd: "src",
        timeoutSeconds: 900,
      },
      { id: "extra", command: ["make", "extra"], required: false },
    ],
    network: "deny",
    env: { GOCACHE: "/cache/go" },
    pathPrepend: ["/opt/shims"],
    codexSandbox: { writableRoots: ["/cache/go"], networkAccess: false },
    verificationTimeoutMs: 2_700_000,
  };

  it("sends back a loaded profile unchanged, including what the form does not show", () => {
    expect(toProfile(toForm(full))).toStrictEqual(full);
    expect(toProfile(toForm({}))).toStrictEqual({});
  });

  it("states a default again when the saved profile stated it", () => {
    const form = toForm({ codexSandbox: { networkAccess: true } });
    expect(toProfile({ ...form, networkAccess: false })).toStrictEqual({
      codexSandbox: { networkAccess: false },
    });
    expect(toProfile({ ...toForm({}), network: "allow" })).toStrictEqual({ network: "allow" });
  });

  it("finds the obvious mistakes only", () => {
    const form = toForm({
      checks: [{ id: "", command: [] }],
      pathPrepend: ["/ok", "bin"],
      codexSandbox: { writableRoots: ["cache"] },
    });
    const p = problemsOf({ ...form, timeoutMinutes: "soon" });
    const row = p.checks[form.checks[0]!.key]!;
    expect(row.id).toMatch(/id/);
    expect(row.command).toMatch(/command/);
    expect(p.pathPrepend).toBe("Not an absolute path: bin");
    expect(p.writableRoots).toBe("Not an absolute path: cache");
    expect(p.timeoutMinutes).toBeTruthy();
    expect(p.count).toBe(5);
    expect(problemsOf(toForm({})).count).toBe(0);
  });
});
