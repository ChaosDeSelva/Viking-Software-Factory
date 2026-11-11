import { describe, expect, it } from "vitest";
import type { PrivilegedAction } from "./actions.js";
import { classifyCommand, type ClassifyOptions } from "./classify.js";

/** Each row runs in `heuristic` mode and again in the default mode. */
const U = "shell.unclassified" as const;
const SECRET = "secret.read" as const;
const BASE: ClassifyOptions = { worktree: "/wt", cwd: "/wt", currentBranch: "feat" };

type Row = [argv: string[], expected: PrivilegedAction | null, options?: ClassifyOptions];

function run(rows: Row[]) {
  it.each(rows.map(([argv, expected, options]) => ({ argv, expected, options })))(
    "$argv -> $expected",
    ({ argv, expected, options }) => {
      const o = { ...BASE, ...options };
      expect(classifyCommand(argv, { ...o, mode: "heuristic" })).toBe(expected);
      const strict = classifyCommand(argv, { ...o, mode: "exact-allowlist" });
      if (expected === null) expect([null, U]).toContain(strict);
      else expect(strict).toBe(expected);
    },
  );
}

describe("a secret path attached to a short option is still a secret read", () => {
  run([
    // `-F<file>`: the commit/tag message is the file's contents (then pushed).
    [["git", "commit", "-F/etc/shadow"], SECRET],
    [["git", "tag", "-F/etc/shadow", "v1"], SECRET],
    [["git", "commit", "-F~/.mimir/auth-token"], SECRET],
    [["git", "commit", "-F/Users/me/.claude/.credentials.json"], SECRET],
    // `grep -f<file>` prints matching lines using the file as patterns.
    [["grep", "-f/etc/shadow", "x"], SECRET],
    [["grep", "-rf~/.aws/credentials", "x"], SECRET],
    [["head", "-n1", "-c5"], null],
    // Separate and long forms are secret reads too.
    [["git", "commit", "-F", "/etc/shadow"], SECRET],
    [["grep", "--file=/etc/shadow", "x"], SECRET],
  ]);
});

describe("hook-runner configs are as sensitive as .husky", () => {
  // `git commit` runs the shared `.git/hooks/pre-commit`, which for pre-commit/lefthook users
  // runs whatever command these files name.
  run([
    [["bash", "-c", "echo x > .pre-commit-config.yaml"], U],
    [["bash", "-c", "echo x > sub/.pre-commit-config.yaml"], U],
    [["bash", "-c", "echo x > lefthook.yml"], U],
    [["bash", "-c", "echo x > .lefthook.yaml"], U],
    [["bash", "-c", "echo x > lefthook-local.json"], U],
    [["bash", "-c", "echo x > notes.yml"], null],
  ]);
});

describe("credential CLIs with global options before the subcommand", () => {
  run([
    [
      ["aws", "--region", "us-east-1", "secretsmanager", "get-secret-value", "--secret-id", "x"],
      SECRET,
    ],
    [["aws", "--profile", "prod", "ssm", "get-parameter", "--name", "x"], SECRET],
    [["aws", "--profile=prod", "sts", "get-session-token"], SECRET],
    [["gcloud", "--project", "p", "auth", "print-access-token"], SECRET],
    [["op", "--account", "me", "read", "op://vault/item/field"], SECRET],
    [["aws", "--region", "us-east-1", "s3", "ls"], U],
  ]);
});

describe("$'\\c' quote handling", () => {
  run([[["bash", "-c", `echo $'\\c'; rm -rf /; echo "'" # "`], "shell.destructive"]]);
});
