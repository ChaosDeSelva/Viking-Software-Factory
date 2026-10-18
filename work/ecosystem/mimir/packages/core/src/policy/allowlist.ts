import { type PathContext, readAllowed } from "./paths.js";

/**
 * How `classifyCommand` decides that a command is benign (see docs/adrs/ADR-014).
 *
 * - `exact-allowlist` (default): `null` only when argv matches an entry of the allowlist and the
 *   heuristic classifier raises nothing about it. Everything else needs approval.
 * - `heuristic`: the option-table classifier alone decides (the pre-round-4 behaviour). Kept for
 *   tests and for operators who opt in; it is defence in depth and will never be complete.
 */
export type PolicyMode = "exact-allowlist" | "heuristic";

export const DEFAULT_POLICY_MODE: PolicyMode = "exact-allowlist";

/** Arguments allowed after a fixed `prefix`, by shape rather than by exact value. */
export interface AllowlistShape {
  /** Words that must follow argv0 exactly (for example `["status"]` for `git status`). */
  prefix?: readonly string[];
  /** Most words allowed after the prefix. */
  maxArgs: number;
  /**
   * When set, every flag (a word starting with `-`, before `--`) must be listed. An entry
   * ending in `=` or `*` matches by prefix (`--format=`, `-n*`).
   */
  allowFlags?: readonly string[];
  /** Accept `-<digits>` flags (`git log -5`, `head -20`). */
  numericFlags?: boolean;
  /** Flags that never match, exactly or as `--flag=value`. */
  forbidFlags?: readonly string[];
  /** Characters no word after argv0 may contain. */
  forbidChars?: string;
  /**
   * Non-flag words are paths: they must resolve inside the worktree, outside `.git`, and must
   * not be credential paths (compared after NFKC and case folding).
   */
  pathArgsMustBeInsideWorktreeAndNonSensitive: boolean;
}

export type AllowlistArgs = "none" | { exact: readonly string[] } | { shape: AllowlistShape };

/** One project-configured allowlist entry. `argv0` is compared exactly (no path lookup). */
export interface AllowlistEntry {
  argv0: string;
  args: AllowlistArgs;
}

function scripts(): AllowlistEntry[] {
  const names = ["test", "lint", "typecheck", "build", "check"];
  const out: AllowlistEntry[] = [];
  for (const n of names) {
    out.push({ argv0: "pnpm", args: { exact: [n] } });
    out.push({ argv0: "pnpm", args: { exact: ["run", n] } });
    out.push({ argv0: "npm", args: { exact: ["run", n] } });
    out.push({ argv0: "yarn", args: { exact: ["run", n] } });
  }
  out.push({ argv0: "npm", args: { exact: ["test"] } });
  return out;
}

const GIT_DIFF_FLAGS = [
  "--stat",
  "--shortstat",
  "--numstat",
  "--name-only",
  "--name-status",
  "--summary",
  "-p",
  "--patch",
  "-s",
  "--no-patch",
  "--no-color",
  "--color=never",
  "--no-ext-diff",
  "--no-textconv",
  "-w",
  "--ignore-all-space",
  "-b",
  "--ignore-space-change",
  "-U*",
  "--unified=",
];
const GIT_LOG_FLAGS = [
  ...GIT_DIFF_FLAGS,
  "--oneline",
  "-n",
  "--max-count=",
  "--graph",
  "--decorate",
  "--no-decorate",
  "--all",
  "--reverse",
  "--first-parent",
  "--merges",
  "--no-merges",
  "--since=",
  "--until=",
  "--after=",
  "--before=",
  "--author=",
  "--grep=",
  "--format=",
  "--pretty=",
  "--abbrev-commit",
  "--date=",
  "--follow",
];

function git(sub: string, allowFlags: readonly string[], numericFlags = false): AllowlistEntry {
  return {
    argv0: "git",
    args: {
      shape: {
        prefix: [sub],
        maxArgs: 32,
        allowFlags,
        numericFlags,
        pathArgsMustBeInsideWorktreeAndNonSensitive: true,
      },
    },
  };
}

function reader(argv0: string, allowFlags: readonly string[]): AllowlistEntry {
  return {
    argv0,
    args: {
      shape: {
        maxArgs: 32,
        allowFlags,
        numericFlags: argv0 !== "cat",
        pathArgsMustBeInsideWorktreeAndNonSensitive: true,
      },
    },
  };
}

/**
 * The allowlist used when a project configures none: package scripts the operator wrote
 * (`pnpm test|lint|typecheck|build|check`, also through `run`), read-only git, `ls`, `pwd`,
 * `cat`/`head`/`tail` on worktree files, plain `echo`, and two version probes. Returns a fresh
 * array each call.
 */
export function defaultAllowlist(): AllowlistEntry[] {
  return [
    ...scripts(),
    git("status", [
      "-s",
      "--short",
      "-b",
      "--branch",
      "--porcelain",
      "--porcelain=",
      "--long",
      "-v",
      "--verbose",
      "-u*",
      "--untracked-files=",
      "--ignored",
      "-z",
      "--ahead-behind",
      "--no-ahead-behind",
      "--show-stash",
    ]),
    git("log", GIT_LOG_FLAGS, true),
    git("show", GIT_LOG_FLAGS, true),
    git("diff", [...GIT_DIFF_FLAGS, "--cached", "--staged"]),
    {
      argv0: "ls",
      args: { shape: { maxArgs: 32, pathArgsMustBeInsideWorktreeAndNonSensitive: true } },
    },
    { argv0: "pwd", args: "none" },
    reader("cat", ["-n", "-b", "-s", "-v", "-e", "-E", "-t", "-T", "-A", "-u"]),
    reader("head", ["-n*", "-c*", "--lines=", "--bytes=", "-q", "-v"]),
    reader("tail", ["-n*", "-c*", "--lines=", "--bytes=", "-q", "-v", "-r"]),
    {
      argv0: "echo",
      args: {
        shape: {
          maxArgs: 64,
          forbidChars: "$`><|;&\n\\",
          pathArgsMustBeInsideWorktreeAndNonSensitive: false,
        },
      },
    },
    { argv0: "node", args: { exact: ["--version"] } },
    { argv0: "python3", args: { exact: ["--version"] } },
  ];
}

function flagMatches(word: string, entries: readonly string[]): boolean {
  return entries.some((e) =>
    e.endsWith("=") || e.endsWith("*") ? word.startsWith(e.replace(/\*$/, "")) : word === e,
  );
}

function shapeMatches(shape: AllowlistShape, args: readonly string[], ctx: PathContext): boolean {
  const prefix = shape.prefix ?? [];
  if (args.length < prefix.length) return false;
  if (prefix.some((p, i) => args[i] !== p)) return false;
  const rest = args.slice(prefix.length);
  if (rest.length > shape.maxArgs) return false;
  const forbidChars = shape.forbidChars ?? "";
  let flags = true;
  for (const w of rest) {
    if ([...forbidChars].some((c) => w.includes(c))) return false;
    if (flags && w === "--") {
      flags = false;
      continue;
    }
    if (flags && w.startsWith("-") && w !== "-") {
      if (shape.forbidFlags?.some((f) => w === f || w.startsWith(`${f}=`)) ?? false) {
        return false;
      }
      if (shape.allowFlags) {
        const numeric = shape.numericFlags === true && /^-\d+$/.test(w);
        if (!numeric && !flagMatches(w, shape.allowFlags)) return false;
      }
      continue;
    }
    if (shape.pathArgsMustBeInsideWorktreeAndNonSensitive && !readAllowed(w, ctx)) return false;
  }
  // With no path operands the command reads the cwd, which must be inside the worktree.
  return !shape.pathArgsMustBeInsideWorktreeAndNonSensitive || ctx.cwd !== null;
}

/** True when `argv` matches an entry. A cwd outside the worktree matches nothing. */
export function matchesAllowlist(
  argv: readonly string[],
  allowlist: readonly AllowlistEntry[],
  ctx: PathContext,
): boolean {
  if (ctx.cwd === null) return false;
  const [argv0, ...args] = argv;
  if (argv0 === undefined) return false;
  return allowlist.some((entry) => {
    if (entry.argv0 !== argv0) return false;
    const spec = entry.args;
    if (spec === "none") return args.length === 0;
    if ("exact" in spec) {
      return spec.exact.length === args.length && spec.exact.every((a, i) => args[i] === a);
    }
    return shapeMatches(spec.shape, args, ctx);
  });
}
