import { basename } from "node:path";

export interface CommandAnalysis {
  /**
   * Why the command is denied under `destructiveCommands: deny`, e.g. `rm -rf`,
   * `inline_code`, `shell -c`, `unanalyzable_wrapper`.
   */
  destructive?: string;
  /** True for dependency installation (`npm|pnpm|yarn|bun install|add|ci|i|update`). */
  dependencyInstall: boolean;
  /** True for commands that need the network (`audit`, `outdated`, `dlx`, installs...). */
  needsNetwork: boolean;
  /** argv of the innermost command after unwrapping wrappers. */
  effective: string[];
}

/**
 * Every command name the classifier has rules for. The runner uses it to
 * identify a resolved binary by inode (`zap` hard-linked to `rm` is `rm`).
 */
export const CLASSIFIED_HEADS: readonly string[] = [
  "rm",
  "dd",
  "mkfs",
  "git",
  "find",
  "sudo",
  "doas",
  "pkexec",
  "rimraf",
  "shred",
  "trash",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ash",
  "node",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "pwsh",
  "powershell",
  "osascript",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "tar",
  "make",
  "vim",
  "nvim",
  "ex",
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
  "npm",
  "pnpm",
  "yarn",
  "setsid",
  "su",
  "busybox",
  "script",
  "watch",
];

/** Label for a wrapper, flag or head Brokkr cannot model: denied (fail closed). */
export const UNANALYZABLE = "unanalyzable_wrapper";
/** Label for interpreter code passed on the command line. */
export const INLINE_CODE = "inline_code";

type FlagKind = "flag" | "value" | { deny: string };

/** Exact option grammar of a wrapper that runs another command. */
interface WrapperSpec {
  short?: Record<string, FlagKind>;
  long?: Record<string, FlagKind>;
  /** `NAME=VALUE` tokens before the command (env). */
  assignments?: boolean;
  /** Validates one required positional (timeout's duration) before the command. */
  positional?: RegExp;
  /** The wrapper may legitimately run without a command (env prints, xargs echoes). */
  emptyOk?: boolean;
}

const F: FlagKind = "flag";
const V: FlagKind = "value";
const inline: FlagKind = { deny: INLINE_CODE };

const DURATION = /^\d+(\.\d+)?[smhd]?$/;

const WRAPPERS: Record<string, WrapperSpec> = {
  env: {
    short: { i: F, "0": F, v: F, u: V, C: V, P: V, S: { deny: "env -S" } },
    long: {
      "ignore-environment": F,
      null: F,
      debug: F,
      unset: V,
      chdir: V,
      "split-string": { deny: "env -S" },
    },
    assignments: true,
    emptyOk: true,
  },
  timeout: {
    short: { s: V, k: V, v: F },
    long: { signal: V, "kill-after": V, "preserve-status": F, foreground: F, verbose: F },
    positional: DURATION,
  },
  nice: { short: { n: V }, long: { adjustment: V } },
  nohup: {},
  time: {
    short: { p: F, a: F, v: F, q: F, f: V, o: V },
    long: { portability: F, append: F, verbose: F, quiet: F, format: V, output: V },
  },
  xargs: {
    short: {
      "0": F,
      r: F,
      t: F,
      p: F,
      x: F,
      I: V,
      n: V,
      L: V,
      P: V,
      s: V,
      d: V,
      E: V,
      a: V,
    },
    long: {
      null: F,
      "no-run-if-empty": F,
      verbose: F,
      interactive: F,
      exit: F,
      "open-tty": F,
      replace: V,
      "max-args": V,
      "max-lines": V,
      "max-procs": V,
      "max-chars": V,
      delimiter: V,
      eof: V,
      "arg-file": V,
    },
    emptyOk: true,
  },
  command: { short: { p: F, v: F, V: F } },
  stdbuf: { short: { i: V, o: V, e: V }, long: { input: V, output: V, error: V } },
  npx: {
    short: { p: V, y: F, q: F, c: inline },
    long: {
      package: V,
      yes: F,
      no: F,
      quiet: F,
      "no-install": F,
      "ignore-existing": F,
      call: inline,
    },
  },
  bunx: { short: { p: V }, long: { package: V, bun: F } },
};

/** Wrappers that run another command but are not modelled: always denied. */
const OPAQUE_WRAPPERS = new Set([
  "exec",
  "ionice",
  "chrt",
  "taskset",
  "flock",
  "busybox",
  "toybox",
  "script",
  "watch",
  "setsid",
  "strace",
  "ltrace",
  "unshare",
  "chroot",
  "su",
  "runuser",
  "nsenter",
  "firejail",
  "systemd-run",
  "caffeinate",
  "parallel",
  "eval",
  "builtin",
]);

const PRIVILEGE = new Set(["sudo", "doas", "pkexec"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL = new Set([
  "install",
  "i",
  "add",
  "ci",
  "update",
  "up",
  "upgrade",
  "install-test",
  "it",
  "install-ci-test",
  "cit",
]);
const NETWORK = new Set(["audit", "outdated", "view", "info", "search", "dlx", "publish", "x"]);
const PUBLISH = new Set(["publish", "unpublish", "deprecate", "dist-tag"]);
const DELETE_TOOLS = new Set(["rimraf", "del-cli", "trash", "shred"]);
const SCRIPT_FILE = /(\/|\.(m|c)?(j|t)s$|\.py$|\.pl$|\.rb$|\.php$)/;

/** Global options each package manager accepts before its subcommand. */
const PM_GLOBALS: Record<string, WrapperSpec> = {
  pnpm: {
    short: { C: V, F: V, r: F, w: F, s: F },
    long: {
      dir: V,
      filter: V,
      "filter-prod": V,
      reporter: V,
      loglevel: V,
      "workspace-concurrency": V,
      "test-pattern": V,
      "changed-files-ignore-pattern": V,
      recursive: F,
      "workspace-root": F,
      silent: F,
      stream: F,
      parallel: F,
      "aggregate-output": F,
      "no-bail": F,
      bail: F,
      "if-present": F,
      "frozen-lockfile": F,
      offline: F,
      "prefer-offline": F,
      "ignore-scripts": F,
      color: F,
      "no-color": F,
      sort: F,
      "no-sort": F,
      "include-workspace-root": F,
      "fail-if-no-match": F,
    },
  },
  npm: {
    short: { w: V, C: V, s: F, q: F, d: F, y: F },
    long: {
      prefix: V,
      workspace: V,
      loglevel: V,
      userconfig: V,
      registry: V,
      workspaces: F,
      "include-workspace-root": F,
      silent: F,
      quiet: F,
      yes: F,
      "ignore-scripts": F,
      offline: F,
      "prefer-offline": F,
      "if-present": F,
      json: F,
    },
  },
  yarn: { short: { s: F }, long: { cwd: V, silent: F, offline: F, json: F, verbose: F } },
  bun: { long: { cwd: V, silent: F, bun: F } },
};

/** Options of `<pm> exec` / `dlx` before the command. */
const PM_EXEC: Record<string, WrapperSpec> = {
  pnpm: {
    short: { r: F, c: inline },
    long: {
      recursive: F,
      parallel: F,
      "no-reporter-hide-prefix": F,
      "report-summary": F,
      "resume-from": V,
      "shell-mode": inline,
    },
  },
  npm: {
    short: { c: inline, p: V, y: F, w: V },
    long: { package: V, call: inline, yes: F, no: F, workspaces: F, workspace: V },
  },
  yarn: {},
  bun: {},
};
const PM_DLX: WrapperSpec = {
  short: { p: V, c: inline },
  long: { package: V, "shell-mode": inline, silent: F },
};

type ParseResult = { ok: true; rest: string[] } | { ok: false; deny: string };

/** Consume a wrapper's options exactly as `spec` describes; anything unknown fails closed. */
function parseOptions(args: readonly string[], spec: WrapperSpec): ParseResult {
  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok === "--") {
      i++;
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = tok.slice(2, eq < 0 ? undefined : eq);
      const kind = spec.long?.[name];
      if (kind === undefined) return { ok: false, deny: UNANALYZABLE };
      if (typeof kind === "object") return { ok: false, deny: kind.deny };
      if (kind === "value" && eq < 0) {
        if (i + 1 >= args.length) return { ok: false, deny: UNANALYZABLE };
        i += 2;
      } else i++;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      let consumedNext = false;
      for (let c = 1; c < tok.length; c++) {
        const kind = spec.short?.[tok[c]!];
        if (kind === undefined) return { ok: false, deny: UNANALYZABLE };
        if (typeof kind === "object") return { ok: false, deny: kind.deny };
        if (kind === "value") {
          if (c === tok.length - 1) {
            if (i + 1 >= args.length) return { ok: false, deny: UNANALYZABLE };
            consumedNext = true;
          }
          break; // the rest of the token (if any) is the value
        }
      }
      i += consumedNext ? 2 : 1;
      continue;
    }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    break;
  }
  if (spec.positional) {
    const value = args[i];
    if (value === undefined || !spec.positional.test(value))
      return { ok: false, deny: UNANALYZABLE };
    i++;
  }
  return { ok: true, rest: args.slice(i) };
}

function flagsOf(args: readonly string[]): { short: Set<string>; long: Set<string> } {
  const short = new Set<string>();
  const long = new Set<string>();
  for (const a of args) {
    if (a.startsWith("--")) long.add(a.split("=")[0]!);
    else if (a.startsWith("-") && a.length > 1) for (const c of a.slice(1)) short.add(c);
  }
  return { short, long };
}

const GIT_VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--exec-path",
  "--list-cmds",
]);

/** git config keys whose values are executed as commands (or pull in commands). */
const GIT_COMMAND_KEY =
  /^(core\..*|alias\..*|diff\..*\.textconv|diff\..*\.command|diff\.external|filter\..*|credential\..*|sequence\.editor|gpg\..*|pager\..*|merge\..*\.driver|uploadpack\..*|receive\..*|remote\..*\.(uploadpack|receivepack|vcs)|protocol\..*|include\..*|includeif\..*)$/i;

/** True when git global `-c key=value` / `--config-env key=VAR` sets a command-bearing key. */
function gitCommandConfig(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let spec: string | undefined;
    if (a === "-c" || a === "--config-env") spec = args[++i];
    else if (a.startsWith("-c") && a.length > 2) spec = a.slice(2);
    else if (a.startsWith("--config-env=")) spec = a.slice("--config-env=".length);
    else if (GIT_VALUE_GLOBALS.has(a))
      i++; // skip the option operand, not the remaining options
    else if (!a.startsWith("-")) break; // the subcommand
    if (spec !== undefined && GIT_COMMAND_KEY.test(spec.split("=")[0] ?? "")) return true;
  }
  return false;
}

function gitSubcommand(args: readonly string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    i += GIT_VALUE_GLOBALS.has(args[i]!) ? 2 : 1;
  }
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/** Heads that cannot be a real command (a mis-parsed option value). */
function implausibleHead(raw: string): boolean {
  return (
    raw === "" ||
    raw.includes("=") ||
    /^[\d.]+[smhd]?$/.test(raw) ||
    /^[{}[\]%]/.test(raw) ||
    // a signal name left over from a mis-parsed option value (e.g. `timeout -s KILL`)
    /^(SIG)?(KILL|TERM|INT|HUP|QUIT|USR1|USR2|STOP|CONT|ALRM)$/i.test(raw)
  );
}

/** Inline code for interpreters: arguments before the script file decide. */
function inlineCode(head: string, args: readonly string[]): boolean {
  const beforeScript = (pattern: RegExp, stopAt: RegExp = SCRIPT_FILE): boolean => {
    for (const a of args) {
      if (pattern.test(a)) return true;
      if (!a.startsWith("-") && stopAt.test(a)) return false;
    }
    return false;
  };
  if (head === "node" || head === "nodejs" || head === "bun") {
    // Preloaded modules given as data: or remote URLs are inline code too.
    const MODULE_FLAGS = /^(--import|--require|-r|--loader|--experimental-loader)$/;
    const INLINE_MODULE = /^(data:|https?:)/i;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const eq = /^(--import|--require|--loader|--experimental-loader)=(.*)$/.exec(a);
      if (eq && INLINE_MODULE.test(eq[2]!)) return true;
      if (MODULE_FLAGS.test(a)) {
        if (INLINE_MODULE.test(args[i + 1] ?? "")) return true;
        i++;
        continue;
      }
      if (/^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/.test(a)) return true;
      if (!a.startsWith("-") && SCRIPT_FILE.test(a)) return false;
    }
    return false;
  }
  if (head === "deno") return args[0] === "eval" || beforeScript(/^(--eval(=.*)?|-e)$/);
  if (/^python(\d+(\.\d+)?)?$/.test(head)) {
    for (const a of args) {
      if (/^-[A-Za-z]*c/.test(a) && !a.startsWith("--")) return true;
      if (a === "-m" || (!a.startsWith("-") && SCRIPT_FILE.test(a))) return false;
    }
    return false;
  }
  if (head === "perl") return beforeScript(/^-[A-Za-z]*[eE]/);
  if (head === "ruby") return beforeScript(/^-[A-Za-z]*e/);
  // -r code, -B/-R/-E begin/per-line/end code, -F per-line file
  if (head === "php") return beforeScript(/^-[A-Za-z]*[rBREF]$/);
  if (head === "sed") {
    const scripts: string[] = [];
    let sawExpression = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-e" || a === "--expression") {
        scripts.push(args[i + 1] ?? "");
        sawExpression = true;
        i++;
      } else if (a.startsWith("--expression=")) {
        scripts.push(a.slice("--expression=".length));
        sawExpression = true;
      } else if (a === "-f" || a === "--file")
        return false; // script file: like any script
      else if (!a.startsWith("-") && !sawExpression) {
        scripts.push(a);
        sawExpression = true;
      }
    }
    // the `e` command, or the `e` flag of `s///e`, runs a shell command
    return scripts.some(
      (sc) =>
        /(^|[;{}\s0-9$,/])e(\s|;|$)/.test(sc) || /^s(.).*\1.*\1[a-zA-Z0-9]*e[a-zA-Z0-9]*$/.test(sc),
    );
  }
  if (head === "tar" || head === "gtar" || head === "bsdtar")
    return args.some(
      (a) =>
        /^--(to-command|checkpoint-action|use-compress-program|rsh-command|info-script|new-volume-script)\b/.test(
          a,
        ) ||
        a === "-I" ||
        a === "-F",
    );
  if (head === "make" || head === "gmake") return args.some((a) => /^--eval\b/.test(a));
  if (["vim", "nvim", "vi", "ex", "view", "gvim"].includes(head))
    return args.some((a) => a === "-c" || a.startsWith("-c") || a === "--cmd" || a.startsWith("+"));
  if (head === "pwsh" || head === "powershell")
    return args.some((a) => /^-(c|command|e|ec|encodedcommand)$/i.test(a));
  if (head === "osascript") return args.some((a) => a === "-e");
  if (["awk", "gawk", "mawk", "nawk"].includes(head)) return !args.includes("-f");
  return false;
}

function destructiveOf(head: string, args: readonly string[]): string | undefined {
  if (PRIVILEGE.has(head)) return head;
  // Any option cluster containing c/C (case-insensitive, e.g. -c, -Ec, -lc, -Cc) makes
  // the shell read a command string: uninspectable, so denied.
  if (SHELLS.has(head) && args.some((a) => /^-[A-Za-z]*[cC][A-Za-z]*$/.test(a))) return "shell -c";
  if (inlineCode(head, args)) return INLINE_CODE;
  if (head === "rm") {
    const { short, long } = flagsOf(args);
    const recursive = short.has("r") || short.has("R") || long.has("--recursive");
    const force = short.has("f") || long.has("--force");
    if (recursive && force) return "rm -rf";
    if (recursive) return "rm -r";
  }
  if (head === "dd") return "dd";
  if (head === "mkfs" || head.startsWith("mkfs.")) return "mkfs";
  if (DELETE_TOOLS.has(head)) return head;
  if (head === "git" && gitCommandConfig(args)) return INLINE_CODE;
  if (head === "git") {
    const { sub, rest } = gitSubcommand(args);
    const { short, long } = flagsOf(rest);
    if (sub === "push") {
      const force =
        short.has("f") ||
        long.has("--force") ||
        long.has("--force-with-lease") ||
        long.has("--force-if-includes") ||
        rest.some((a) => a.startsWith("+"));
      if (force) return "git push --force";
      if (long.has("--mirror")) return "git push --mirror";
      if (short.has("d") || long.has("--delete") || rest.some((a) => a.startsWith(":")))
        return "git push --delete";
    }
    if (sub === "branch" && (short.has("D") || (long.has("--delete") && long.has("--force"))))
      return "git branch -D";
    if (sub === "update-ref" && (short.has("d") || long.has("--delete")))
      return "git update-ref -d";
    if (sub === "reset" && long.has("--hard")) return "git reset --hard";
    if (sub === "clean" && (short.has("f") || long.has("--force"))) return "git clean -f";
  }
  return undefined;
}

const EMPTY = (effective: string[]): CommandAnalysis => ({
  dependencyInstall: false,
  needsNetwork: false,
  effective,
});

function analyze(argv: readonly string[], depth: number): CommandAnalysis {
  const deny = (label: string): CommandAnalysis => ({ ...EMPTY([...argv]), destructive: label });
  if (depth > 16) return deny(UNANALYZABLE);
  const raw = argv[0] ?? "";
  if (implausibleHead(raw)) return deny(UNANALYZABLE);
  // Command names are matched case-insensitively: on case-insensitive file systems
  // (macOS APFS, Windows) `Rm`, `Bash` or `GIT` run the same binary as `rm`, `bash`, `git`.
  const head = basename(raw).toLowerCase();
  const args = argv.slice(1);

  const wrapper = WRAPPERS[head];
  if (wrapper) {
    const parsed = parseOptions(args, wrapper);
    if (!parsed.ok) return deny(parsed.deny);
    if (parsed.rest.length === 0) return wrapper.emptyOk ? EMPTY([...argv]) : deny(UNANALYZABLE);
    return analyze(parsed.rest, depth + 1);
  }
  if (OPAQUE_WRAPPERS.has(head)) return deny(UNANALYZABLE);

  if (head === "bun" && inlineCode(head, args)) return deny(INLINE_CODE);
  if (PACKAGE_MANAGERS.has(head)) return analyzePackageManager(head, argv, args, depth);

  if (head === "find") {
    if (args.includes("-delete")) return deny("find -delete");
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!)) continue;
      const end = args.findIndex((a, j) => j > i && (a === ";" || a === "+"));
      const nested = analyze(args.slice(i + 1, end < 0 ? undefined : end), depth + 1);
      if (nested.destructive) return deny(nested.destructive);
    }
  }

  const destructive = destructiveOf(head, args);
  return { ...EMPTY([...argv]), ...(destructive ? { destructive } : {}) };
}

function analyzePackageManager(
  head: string,
  argv: readonly string[],
  args: readonly string[],
  depth: number,
): CommandAnalysis {
  const deny = (label: string): CommandAnalysis => ({ ...EMPTY([...argv]), destructive: label });
  const globals = parseOptions(args, PM_GLOBALS[head]!);
  if (!globals.ok) return deny(globals.deny);
  const [sub, ...rest] = globals.rest;
  if (sub === undefined) {
    // bare `yarn` installs; bare npm/pnpm/bun print help
    const install = head === "yarn";
    return { ...EMPTY([...argv]), dependencyInstall: install, needsNetwork: install };
  }
  if (PUBLISH.has(sub)) return { ...deny("publish"), needsNetwork: true };
  if (sub === "exec" || sub === "dlx" || (head === "bun" && sub === "x")) {
    const spec = sub === "exec" ? PM_EXEC[head]! : PM_DLX;
    const parsed = parseOptions(rest, spec);
    if (!parsed.ok) return deny(parsed.deny);
    if (parsed.rest.length === 0) return deny(UNANALYZABLE);
    const inner = analyze(parsed.rest, depth + 1);
    return { ...inner, needsNetwork: inner.needsNetwork || sub !== "exec" };
  }
  const yarnNpm = head === "yarn" && sub === "npm" ? rest[0] : undefined;
  const install = INSTALL.has(sub);
  const network = install || NETWORK.has(sub) || yarnNpm === "audit" || yarnNpm === "info";
  return { ...EMPTY([...argv]), dependencyInstall: install, needsNetwork: network };
}

/**
 * Classify an argv array (fail closed). Known wrappers are unwrapped with their
 * exact option grammar; unknown wrappers, unknown wrapper flags, implausible
 * heads, inline interpreter code and shell strings are denied.
 */
export function analyzeCommand(argv: readonly string[]): CommandAnalysis {
  return analyze(argv, 0);
}

/** Convert an argv[0] glob (`*`, `**`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
