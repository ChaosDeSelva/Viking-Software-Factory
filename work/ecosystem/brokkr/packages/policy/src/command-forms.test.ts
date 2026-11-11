import { describe, expect, it } from "vitest";
import { CLASSIFIED_HEADS, INLINE_CODE, UNANALYZABLE, analyzeCommand } from "./index.js";

describe("analyzeCommand: equivalent spellings of denied forms", () => {
  const DENY: Array<[string[], string]> = [
    // `env -` is `env -i`: the command follows
    [["env", "-", "rm", "-rf", "/x"], UNANALYZABLE],
    [["-", "rm", "-rf", "/x"], UNANALYZABLE],
    [["-rf", "x"], UNANALYZABLE],
    // npm's `x` alias of `exec`
    [["npm", "x", "rimraf", "dist"], "rimraf"],
    [["npm", "x", "--", "rm", "-rf", "x"], "rm -rf"],
    [["npm", "x", "-c", "rm -rf x"], INLINE_CODE],
    [["npm", "x"], UNANALYZABLE],
    // pnpx is `pnpm dlx`
    [["pnpx", "rimraf", "dist"], "rimraf"],
    [["pnpx", "--package", "left-pad", "rm", "-rf", "x"], "rm -rf"],
    [["pnpx", "-c", "rm -rf x"], INLINE_CODE],
    [["pnpx"], UNANALYZABLE],
    // git branch: -d with -f is -D
    [["git", "branch", "-d", "-f", "main"], "git branch -D"],
    [["git", "branch", "-df", "main"], "git branch -D"],
    [["git", "branch", "--delete", "-f", "main"], "git branch -D"],
    [["git", "branch", "-d", "--force", "main"], "git branch -D"],
    // sed: attached -e script, and -e next to a script file
    [["sed", "-es/x/id/e", "f"], INLINE_CODE],
    [["sed", "-n", "-e1e id", "f"], INLINE_CODE],
    [["sed", "-f", "script.sed", "-e", "1e id", "f"], INLINE_CODE],
    [["sed", "--file=script.sed", "-e", "1e id", "f"], INLINE_CODE],
    // awk: program text next to a program file
    [["awk", "-f", "prog.awk", "-e", 'BEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "prog.awk", "--source", 'BEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "prog.awk", '--source=BEGIN{system("id")}'], INLINE_CODE],
    // fish spells -c as --command
    [["fish", "--command=rm -rf /x"], "shell -c"],
    [["fish", "--command", "rm -rf /x"], "shell -c"],
    [["fish", "--init-command=rm -rf /x"], "shell -c"],
    // TypeScript runners take inline code like node
    [["tsx", "-e", "process.exit(0)"], INLINE_CODE],
    [["ts-node", "--eval", "process.exit(0)"], INLINE_CODE],
    [["ts-node", "-pe", "1"], INLINE_CODE],
    // yarn berry publishes through `yarn npm`
    [["yarn", "npm", "publish"], "publish"],
  ];
  for (const [argv, label] of DENY) {
    it(`denies ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBe(label);
    });
  }

  const ALLOW: string[][] = [
    ["git", "branch", "-d", "merged"],
    ["git", "branch", "-f", "main", "HEAD"],
    ["sed", "-e", "s/a/b/", "f"],
    ["sed", "-es/a/b/", "f"],
    ["sed", "-f", "script.sed", "e"],
    ["sed", "--file=script.sed", "e"],
    ["awk", "-f", "prog.awk", "data.txt"],
    ["fish", "script.fish"],
    ["tsx", "scripts/build.ts", "-e"],
    ["ts-node", "scripts/build.ts"],
    ["yarn", "npm", "whoami"],
    ["env", "-i", "ls"],
  ];
  for (const argv of ALLOW) {
    it(`allows ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBeUndefined();
    });
  }
});

describe("analyzeCommand: dependency installation spellings", () => {
  const INSTALLS: string[][] = [
    ["npm", "clean-install"],
    ["npm", "ic"],
    ["npm", "install-clean"],
    ["npm", "isntall"],
    ["npm", "clean-install-test"],
    ["npm", "--prefix", "web", "clean-install"],
    ["yarn", "global", "add", "left-pad"],
  ];
  for (const argv of INSTALLS) {
    it(`flags ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv)).toMatchObject({ dependencyInstall: true, needsNetwork: true });
    });
  }

  it("does not flag yarn global subcommands that install nothing", () => {
    expect(analyzeCommand(["yarn", "global", "list"])).toMatchObject({
      dependencyInstall: false,
      needsNetwork: false,
    });
    expect(analyzeCommand(["yarn", "global"]).dependencyInstall).toBe(false);
  });
});

describe("analyzeCommand: package runners that download need the network", () => {
  it("bunx and pnpx are flagged like `bun x` and `pnpm dlx`", () => {
    expect(analyzeCommand(["bun", "x", "cowsay"]).needsNetwork).toBe(true);
    expect(analyzeCommand(["bunx", "cowsay"]).needsNetwork).toBe(true);
    expect(analyzeCommand(["bunx", "--bun", "cowsay"])).toMatchObject({
      needsNetwork: true,
      effective: ["cowsay"],
    });
    expect(analyzeCommand(["pnpm", "dlx", "cowsay"]).needsNetwork).toBe(true);
    expect(analyzeCommand(["pnpx", "cowsay"])).toMatchObject({
      needsNetwork: true,
      effective: ["cowsay"],
    });
  });

  it("a destructive inner command stays destructive", () => {
    expect(analyzeCommand(["bunx", "rimraf", "dist"])).toMatchObject({
      destructive: "rimraf",
      needsNetwork: true,
    });
  });

  it("wrappers that only run a local command do not need the network", () => {
    expect(analyzeCommand(["env", "CI=1", "tsc"]).needsNetwork).toBe(false);
    expect(analyzeCommand(["npm", "exec", "tsc"]).needsNetwork).toBe(false);
  });
});

describe("CLASSIFIED_HEADS", () => {
  // The runner maps a renamed hard link back to one of these names; a classified
  // command missing from the list would be run under its alias unclassified.
  const denied: string[][] = [
    ["rimraf", "x"],
    ["del-cli", "x"],
    ["trash", "x"],
    ["shred", "x"],
    ["dd", "if=a"],
    ["mkfs", "x"],
    ["sudo", "ls"],
    ["doas", "ls"],
    ["pkexec", "ls"],
    ["ionice", "ls"],
    ["chrt", "ls"],
    ["taskset", "ls"],
    ["flock", "ls"],
    ["busybox", "ls"],
    ["toybox", "ls"],
    ["script", "ls"],
    ["watch", "ls"],
    ["setsid", "ls"],
    ["strace", "ls"],
    ["ltrace", "ls"],
    ["unshare", "ls"],
    ["chroot", "ls"],
    ["su", "ls"],
    ["runuser", "ls"],
    ["nsenter", "ls"],
    ["firejail", "ls"],
    ["systemd-run", "ls"],
    ["caffeinate", "ls"],
    ["parallel", "ls"],
    ["gtar", "-I", "x"],
    ["bsdtar", "-I", "x"],
    ["tar", "-I", "x"],
    ["gmake", "--eval=x"],
    ["make", "--eval=x"],
    ["vi", "-c", "x"],
    ["view", "-c", "x"],
    ["gvim", "-c", "x"],
    ["vim", "-c", "x"],
    ["nvim", "-c", "x"],
    ["ex", "-c", "x"],
    ["tsx", "-e", "x"],
    ["ts-node", "-e", "x"],
    ["node", "-e", "x"],
    ["nodejs", "-e", "x"],
    ["bun", "-e", "x"],
    ["deno", "eval", "x"],
    ["python", "-c", "x"],
    ["python3", "-c", "x"],
    ["perl", "-e", "x"],
    ["ruby", "-e", "x"],
    ["php", "-r", "x"],
    ["pwsh", "-c", "x"],
    ["powershell", "-c", "x"],
    ["osascript", "-e", "x"],
    ["awk", "x"],
    ["gawk", "x"],
    ["mawk", "x"],
    ["nawk", "x"],
    ["sed", "1e id"],
    ["sh", "-c", "x"],
    ["bash", "-c", "x"],
    ["zsh", "-c", "x"],
    ["dash", "-c", "x"],
    ["ksh", "-c", "x"],
    ["fish", "-c", "x"],
    ["csh", "-c", "x"],
    ["tcsh", "-c", "x"],
    ["ash", "-c", "x"],
    ["rm", "-rf", "x"],
    ["git", "reset", "--hard"],
    ["find", ".", "-delete"],
    ["npm", "publish"],
    ["pnpm", "publish"],
    ["yarn", "publish"],
  ];
  for (const argv of denied) {
    it(`lists '${argv[0]}', which the classifier denies as ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBeDefined();
      expect(CLASSIFIED_HEADS).toContain(argv[0]);
    });
  }

  const unwrapped = [
    "env",
    "timeout",
    "nice",
    "nohup",
    "time",
    "xargs",
    "command",
    "stdbuf",
    "npx",
    "bunx",
    "pnpx",
  ];
  for (const head of unwrapped) {
    it(`lists the wrapper '${head}'`, () => {
      const argv = head === "timeout" ? [head, "5", "rm", "-rf", "x"] : [head, "rm", "-rf", "x"];
      expect(analyzeCommand(argv).destructive).toBe("rm -rf");
      expect(CLASSIFIED_HEADS).toContain(head);
    });
  }

  it("has no duplicates", () => {
    expect(new Set(CLASSIFIED_HEADS).size).toBe(CLASSIFIED_HEADS.length);
  });
});
