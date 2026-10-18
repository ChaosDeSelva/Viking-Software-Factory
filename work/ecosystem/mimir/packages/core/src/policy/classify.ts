import type { PrivilegedAction } from "./actions.js";
import {
  type Ctx,
  type Result,
  DESTRUCTIVE,
  SECRET_READ,
  UNCLASSIFIED,
  combine,
  isSpecific,
} from "./context.js";
import { classifyGit } from "./git.js";
import { getopt, has, opts, valueOf, type OptTable, type Parsed } from "./getopt.js";
import { classifyCurl, classifyWget } from "./http.js";
import { classifyPackageManager, classifyPip, classifySystemInstaller } from "./packages.js";
import {
  type AllowlistEntry,
  DEFAULT_POLICY_MODE,
  defaultAllowlist,
  matchesAllowlist,
  type PolicyMode,
} from "./allowlist.js";
import { deleteVerdict, isSecretPath, locate, writeAllowed } from "./paths.js";
import {
  parseScript,
  SUBSTITUTION_PLACEHOLDER,
  type Redirect,
  type ShellWord,
  type SimpleCommand,
} from "./shell.js";

export {
  parseScript,
  parseShell,
  parseShellWords,
  SUBSTITUTION_PLACEHOLDER,
  type Redirect,
  type Script,
  type ShellWord,
  type SimpleCommand,
} from "./shell.js";
export { isSafeGitConfigKey, SAFE_GIT_CONFIG } from "./git.js";
export {
  type AllowlistArgs,
  type AllowlistEntry,
  type AllowlistShape,
  DEFAULT_POLICY_MODE,
  defaultAllowlist,
  matchesAllowlist,
  type PolicyMode,
} from "./allowlist.js";
export { foldPath, SENSITIVE_HOME_PATHS } from "./paths.js";

export interface ClassifyOptions {
  /**
   * Branch checked out where the command runs. When unknown, `git merge` is treated as a merge
   * into a protected branch and `git pull` as unclassified.
   */
  currentBranch?: string;
  /** Exact names, or prefixes ending in `*` (e.g. `release/*`). */
  protectedBranches?: readonly string[];
  /**
   * Absolute path of the worktree root. Absolute paths under it count as inside the worktree;
   * without it every absolute path counts as outside.
   */
  worktree?: string;
  /** Absolute working directory; defaults to the worktree root. */
  cwd?: string;
  /** Defaults to `exact-allowlist` (ADR-014). */
  mode?: PolicyMode;
  /**
   * Project-configured allowlist for `exact-allowlist` mode; defaults to `defaultAllowlist()`.
   * Ignored in `heuristic` mode.
   */
  allowlist?: readonly AllowlistEntry[];
}

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  "main",
  "master",
  "trunk",
  "develop",
  "production",
  "release/*",
]);

/** Nesting depth (shell -c, eval, wrappers) beyond which a command is treated as destructive. */
const MAX_DEPTH = 8;

/**
 * Classify a command line (as an argv array) into the privileged action it performs, or `null`.
 * Pure and **fail-closed** (see docs/security/threat-model.md, "Shell escalation", and ADR-014).
 *
 * In the default `exact-allowlist` mode the result is `null` only when `argv` matches an entry of
 * `options.allowlist` (default `defaultAllowlist()`) and the heuristic below raises nothing about
 * it: a specific action always wins, and `shell.unclassified` from the heuristic is kept for any
 * program the heuristic models. Programs the heuristic does not model can only become `null`
 * through a project entry. Everything else is `shell.unclassified`. The heuristic is defence in
 * depth and will never be complete; the exact allowlist is the gate.
 *
 * The heuristic (`mode: "heuristic"`):
 *
 * - `null` only for programs on an explicit allowlist, each with a table of permitted options
 *   (resolved by unambiguous prefix, as getopt_long does) and operand rules, and only when every
 *   word that matters is resolved and every write target stays inside the worktree, away from
 *   `.git/` and config/exec files.
 * - A specific action when one is recognised (`git.push`, `shell.destructive`, `secret.read`,
 *   `package.install`, ...), also through wrappers, `sh -c`, `eval` and substitutions. In
 *   compound commands the first specific action wins.
 * - `shell.unclassified` for everything else, including any line the parser cannot fully model.
 *
 * Elements of `argv` are taken literally (as passed to exec); a command name that looks dynamic
 * is unclassified.
 */
export function classifyCommand(
  argv: readonly string[],
  options: ClassifyOptions = {},
): PrivilegedAction | null {
  const ctx: Ctx = {
    branches: new Set([options.currentBranch]),
    protectedBranches: options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
    worktree: options.worktree,
    cwd: [],
  };
  if (options.cwd !== undefined) {
    const loc = locate(options.cwd, { worktree: options.worktree, cwd: [] });
    ctx.cwd = loc.kind === "inside" ? loc.rel : null;
  }
  const words = argv.map((text) => ({ text, unresolved: false }));
  const pathCtx = { worktree: ctx.worktree, cwd: ctx.cwd };
  const heuristic = classifySimple({ words, redirects: [] }, ctx, 0);
  if ((options.mode ?? DEFAULT_POLICY_MODE) === "heuristic") return heuristic;
  if (isSpecific(heuristic)) return heuristic;
  if (!matchesAllowlist(argv, options.allowlist ?? defaultAllowlist(), pathCtx)) {
    return UNCLASSIFIED;
  }
  if (heuristic === null) return null;
  // The heuristic's `unclassified` means "risky" only for programs it models.
  return modelled(argv[0] as string) ? UNCLASSIFIED : null;
}

/** True when the heuristic has a table or handler for `argv0` (a bare program name). */
function modelled(argv0: string): boolean {
  if (argv0.includes("/") || looksDynamic(argv0)) return true;
  return (
    argv0 in HANDLERS ||
    argv0 in BENIGN ||
    /^python[\d.]*$/.test(argv0) ||
    /^mkfs(?:\..+)?$/.test(argv0)
  );
}

function classifyString(src: string, ctx: Ctx, depth: number): Result {
  if (depth > MAX_DEPTH) return DESTRUCTIVE;
  const script = parseScript(src);
  if (script.opaque !== undefined) return UNCLASSIFIED;
  const results: Result[] = [];
  for (const cmd of script.commands) {
    const r = classifySimple(cmd, ctx, depth);
    if (isSpecific(r)) return r;
    results.push(r);
  }
  return combine(results);
}

// ---------------------------------------------------------------------------------------------
// Environment

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
/** Variables that may prefix a command (`CI=1 pnpm test`). Everything else is unclassified. */
const SAFE_ENV =
  /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TERM|COLUMNS|LINES|LANG|LANGUAGE|LC_[A-Z]+|TZ|DEBUG|LOG_LEVEL|RUST_LOG|RUST_BACKTRACE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|NODE_NO_WARNINGS|GIT_AUTHOR_(?:NAME|EMAIL|DATE)|GIT_COMMITTER_(?:NAME|EMAIL|DATE)|GIT_TERMINAL_PROMPT|TMPDIR)$/;
/** Variables that change what runs or where config comes from; never set by builtins/bare. */
const DANGEROUS_ENV =
  /^(?:PATH|IFS|ENV|BASH_ENV|BASH_[A-Z_]+|CDPATH|HOME|SHELL|SHELLOPTS|BASHOPTS|GLOBIGNORE|PROMPT_COMMAND|PS[0-4]|LESS(?:OPEN|CLOSE|KEY|EDIT)?|PAGER|MANPAGER|EDITOR|VISUAL|BROWSER|CURL_HOME|WGETRC|XDG_[A-Z_]+|TERMINFO|HISTFILE|GIT_[A-Z_]+|NPM_CONFIG_[A-Za-z_]+|npm_config_[A-Za-z_]+|YARN_[A-Z_]+|PNPM_[A-Z_]+|NODE_[A-Z_]+|PYTHON[A-Z_]*|PERL[A-Z0-9_]*|RUBY[A-Z_]*|GEM_[A-Z_]+|LD_[A-Z_]+|DYLD_[A-Z_]+|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|SSH_[A-Z_]+|GNUPGHOME|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|RIPGREP_CONFIG_PATH|PYTEST_[A-Z_]+|ESLINT_[A-Z_]+|PRETTIER_[A-Z_]+|VITEST[A-Z_]*|TZDIR|LOCPATH|NLSPATH|GCONV_PATH|MAIL[A-Z]*)$/;

/** Variable names that hold credentials by convention (N7). */
const SECRET_VAR =
  /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE|_KEY$|^KEY$|DSN$/i;
/** Programs whose purpose is to print their operands. */
const PRINTERS = new Set(["echo", "printf", "print"]);

/**
 * N7: a word that expands a credential variable (`$TOKEN`, `${AWS_SECRET_ACCESS_KEY}`) anywhere,
 * or any DANGEROUS_ENV variable (`$PATH`, `$NPM_CONFIG_USERCONFIG`) in a printer or here-string.
 */
function exposesVariable(cmd: SimpleCommand, printer: boolean): boolean {
  const refs = (w: ShellWord) =>
    w.unresolved
      ? [...w.text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] as string)
      : [];
  const dangerous = (n: string) => DANGEROUS_ENV.test(n) && !SAFE_ENV.test(n);
  for (const w of cmd.words) {
    for (const n of refs(w)) if (SECRET_VAR.test(n) || (printer && dangerous(n))) return true;
  }
  for (const r of cmd.redirects) {
    for (const n of refs(r.target)) {
      if (SECRET_VAR.test(n) || (r.op === "<<<" && dangerous(n))) return true;
    }
  }
  return false;
}

function nameOk(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && (SAFE_ENV.test(name) || !DANGEROUS_ENV.test(name))
  );
}

/** `NAME` or `NAME=value` operand of export/declare/...: safe name, no code in the value. */
function declOperandOk(w: ShellWord): boolean {
  if (w.unresolved && !ASSIGNMENT.test(w.text)) return false;
  const m = ASSIGNMENT.exec(w.text);
  const name = m ? (m[1] as string) : w.text;
  if (!nameOk(name)) return false;
  const value = m ? w.text.slice(w.text.indexOf("=") + 1) : "";
  return !storedPayload(value);
}

/**
 * A value that a later evaluator (arithmetic subscripts, `unset 'x[y]'`, `declare -a x='(...)'`,
 * `${x@P}`, `eval`) could execute: command substitution, backticks, subscripts or array syntax.
 * Assigning one is unclassified even when nothing evaluates it yet (store-then-execute).
 */
function storedPayload(value: string): boolean {
  return (
    /\$\(|`|\[/.test(value) || value.includes(SUBSTITUTION_PLACEHOLDER) || value.startsWith("(")
  );
}

// ---------------------------------------------------------------------------------------------
// Simple commands

const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const LOOP_HEADERS = new Set(["for", "select", "case"]);

function looksDynamic(text: string): boolean {
  return (
    /[$`*?]/.test(text) ||
    text.includes(SUBSTITUTION_PLACEHOLDER) ||
    /\[[^\]]*\]/.test(text) ||
    /\{[^}]*(?:,|\.\.)[^}]*\}/.test(text)
  );
}

function basename(cmd: string): string {
  return cmd.slice(cmd.lastIndexOf("/") + 1);
}

const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

function checkRedirects(redirects: readonly Redirect[], ctx: Ctx): Result {
  let secret = false;
  for (const r of redirects) {
    if (WRITE_OPS.has(r.op) && !writeAllowed(r.target, ctx)) return UNCLASSIFIED;
    if ((r.op === "<" || r.op === "<>") && (r.target.unresolved || isSecretPath(r.target.text))) {
      if (r.target.unresolved) return UNCLASSIFIED;
      secret = true;
    }
  }
  return secret ? SECRET_READ : null;
}

/** Programs whose operands are data, not paths read: no secret-path scan. */
const NO_SECRET_SCAN = new Set([
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "test",
  "[",
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "read",
  "set",
  "unset",
  "cd",
  "type",
  "command",
  "sleep",
]);

function classifySimple(cmd: SimpleCommand, ctx: Ctx, depth: number): Result {
  if (depth > MAX_DEPTH) return DESTRUCTIVE;
  const words = cmd.words;
  let i = 0;
  while (i < words.length && KEYWORDS.has((words[i] as ShellWord).text)) i += 1;
  const rest = words.slice(i);
  const redirect = checkRedirects(cmd.redirects, ctx);

  // Assignment prefix.
  let j = 0;
  let unsafeEnv = false;
  let payload = false;
  while (j < rest.length && ASSIGNMENT.test((rest[j] as ShellWord).text)) {
    const w = rest[j] as ShellWord;
    const name = (ASSIGNMENT.exec(w.text) as RegExpExecArray)[1] as string;
    if (!SAFE_ENV.test(name)) unsafeEnv = true;
    if (storedPayload(w.text.slice(w.text.indexOf("=") + 1))) payload = true;
    j += 1;
  }
  const args = rest.slice(j);
  const head = args[0];

  let result: Result;
  if (head === undefined) {
    // Bare assignments: only dangerous names matter (they persist for later commands).
    const dangerous = rest.some(
      (w) => !nameOk((ASSIGNMENT.exec(w.text) as RegExpExecArray)[1] as string),
    );
    result = dangerous || payload ? UNCLASSIFIED : null;
    unsafeEnv = false;
  } else if (CLOSERS.has(head.text) && args.length === 1) {
    result = null;
  } else if (LOOP_HEADERS.has(head.text)) {
    result = null;
  } else if (head.unresolved || looksDynamic(head.text) || head.text === "") {
    result = head.text === "" && !head.unresolved ? null : UNCLASSIFIED;
  } else {
    const name = basename(head.text);
    result = classifyProgram(name, args.slice(1), ctx, depth);
    // E1: only bare names resolve through the allowlist; `./ls` or `sub/cat` may be any file.
    if (head.text.includes("/") && !isSpecific(result)) result = UNCLASSIFIED;
    if (!isSpecific(result) && !NO_SECRET_SCAN.has(name)) {
      if (args.slice(1).some((w) => isSecretPath(w.text))) result = SECRET_READ;
    }
  }
  if (!isSpecific(result)) {
    const printer = head !== undefined && PRINTERS.has(basename(head.text));
    if (exposesVariable(cmd, printer)) result = SECRET_READ;
  }
  if (isSpecific(redirect) && !isSpecific(result)) result = redirect;
  if (redirect === UNCLASSIFIED && !isSpecific(result)) result = UNCLASSIFIED;
  if ((unsafeEnv || payload) && !isSpecific(result)) result = UNCLASSIFIED;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Program dispatch

type Handler = (args: readonly ShellWord[], ctx: Ctx, depth: number) => Result;

function classifyProgram(
  name: string,
  args: readonly ShellWord[],
  ctx: Ctx,
  depth: number,
): Result {
  const handler = HANDLERS[name];
  if (handler) return handler(args, ctx, depth);
  const spec = BENIGN[name];
  if (spec) return classifyBenign(spec, args, ctx);
  if (/^python[\d.]*$/.test(name)) return classifyPython(args, ctx);
  if (/^mkfs(?:\..+)?$/.test(name)) return DESTRUCTIVE;
  return UNCLASSIFIED;
}

const words = (ws: readonly ShellWord[]) => ws.map((w) => w.text);

/** Inner command of a wrapper: specific result passes through; otherwise `fallback`. */
function inner(
  argv: readonly ShellWord[],
  ctx: Ctx,
  depth: number,
  fallback: Result | "same",
): Result {
  const r = argv.length
    ? classifySimple({ words: [...argv], redirects: [] }, ctx, depth + 1)
    : null;
  if (fallback === "same" || isSpecific(r)) return r;
  return fallback;
}

const SHELL_O = ["pipefail", "errexit", "nounset", "noglob", "noclobber", "posix"];
const SHELL = opts(
  "c,e,u,l|login,o=,norc,noprofile,posix,noediting,f,C,B,h,a,b,m,H,P,T,E,v,verbose," +
    "r|restricted,x!,xtrace!,i!,s!,rcfile=!,init-file=!,debugger!,O=!",
  { permute: false, values: { o: SHELL_O } },
);

function classifyShell(args: readonly ShellWord[], ctx: Ctx, depth: number): Result {
  const parsed = getopt(SHELL, args);
  if (!parsed.ok || !has(parsed, "c")) return UNCLASSIFIED;
  const script = parsed.operands[0];
  if (!script || script.unresolved) return UNCLASSIFIED;
  return classifyString(script.text, ctx, depth + 1);
}

function parsedOr(table: OptTable, args: readonly ShellWord[]): Parsed | null {
  const p = getopt(table, args);
  return p.ok ? p : null;
}

const SUDO = opts(
  "u|user=,g|group=,h|host=,p|prompt=,C|close-from=,D|chdir=,r|role=,t|type=," +
    "T|command-timeout=,U|other-user=,E|preserve-env?,H|set-home,i|login,s|shell," +
    "n|non-interactive,S|stdin,k|reset-timestamp,K|remove-timestamp,b|background,A|askpass," +
    "B|bell,P|preserve-groups,l|list,v|validate,V|version,e|edit",
  { permute: false },
);
const DOAS = opts("u=,C=,n,s,L", { permute: false });
const PKEXEC = opts("user=,disable-internal-agent,keep-cwd", { permute: false });
const SU = opts(
  "c|command=,l|login,m|p|preserve-environment,s|shell=,g|group=,G|supp-group=,P|pty," +
    "w|whitelist-environment=,session-command=",
);

function escalate(table: OptTable): Handler {
  return (args, ctx, depth) => {
    const p = parsedOr(table, args);
    if (!p) return DESTRUCTIVE;
    const r = inner(p.operands, ctx, depth, DESTRUCTIVE);
    return isSpecific(r) ? r : DESTRUCTIVE;
  };
}

const XARGS = opts(
  "0|null,a|arg-file=<,d|delimiter=,E=,e|eof*,I=,i|replace*,L|max-lines=,l*,n|max-args=," +
    "P|max-procs=,p|interactive,o|open-tty,r|no-run-if-empty,s|max-chars=,t|verbose,x|exit," +
    "show-limits,process-slot-var=",
  { permute: false },
);
const WATCH = opts(
  "n|interval=,d|differences?,t|no-title,b|beep,e|errexit,g|chgexit,c|color,x|exec,p|precise," +
    "q|equexit=,w|no-wrap",
  { permute: false },
);
const PARALLEL = opts(
  "j|jobs=,k|keep-order,q|quote,v,dry-run,halt=,joblog=>,a|arg-file=<,0|null,X,m," +
    "u|ungroup,line-buffer,tag,progress,eta,bar,N|max-args=,n=",
  { permute: false },
);

const TIME = opts("p,f|format=,o|output=>,a|append,v|verbose,q|quiet", { permute: false });
const NICE = opts("n|adjustment=", { permute: false, numeric: true });
const STDBUF = opts("i|input=,o|output=,e|error=", { permute: false });
const TIMEOUT = opts("s|signal=,k|kill-after=,preserve-status,foreground,v|verbose", {
  permute: false,
});
const COMMAND = opts("p,v,V", { permute: false });
const EXEC = opts("a=,c,l", { permute: false });
const NONE = opts("", { permute: false });
const ENV = opts(
  "i|ignore-environment,0|null,u|unset=,C|chdir=!,S|split-string=!,P=!,v|debug," +
    "ignore-signal?,default-signal?,block-signal?,list-signal-handling",
  { permute: false },
);

function transparent(table: OptTable, skipOperands = 0): Handler {
  return (args, ctx, depth) => {
    const p = parsedOr(table, args);
    if (!p) return UNCLASSIFIED;
    if (p.opts.some((o) => o.def.write && o.values.some((v) => !writeAllowed(v, ctx)))) {
      return UNCLASSIFIED;
    }
    return inner(p.operands.slice(skipOperands), ctx, depth, "same");
  };
}

function classifyEnv(args: readonly ShellWord[], ctx: Ctx, depth: number): Result {
  const p = parsedOr(ENV, args);
  if (!p) return UNCLASSIFIED;
  let k = 0;
  let unsafe = false;
  while (k < p.operands.length && ASSIGNMENT.test((p.operands[k] as ShellWord).text)) {
    const name = (ASSIGNMENT.exec((p.operands[k] as ShellWord).text) as RegExpExecArray)[1];
    if (!SAFE_ENV.test(name as string)) unsafe = true;
    k += 1;
  }
  const cmd = p.operands.slice(k);
  if (cmd.length === 0) return SECRET_READ; // prints the environment (N7)
  const r = inner(cmd, ctx, depth, "same");
  return unsafe && !isSpecific(r) ? UNCLASSIFIED : r;
}

// Interpreters --------------------------------------------------------------------------------

const VERSION_ONLY = new Set(["--version", "-v", "-V", "--help", "-h", "version", "help"]);

/** Interpreters run only `--version`/`--help`; scripts, inline code and preloads need approval. */
function versionOnly(args: readonly ShellWord[]): Result {
  return args.length > 0 && args.every((w) => VERSION_ONLY.has(w.text)) ? null : UNCLASSIFIED;
}

const PYTEST = opts(
  "q|quiet,v|verbose,x|exitfirst,k=,s,tb=,m=,lf|last-failed,ff|failed-first,maxfail=,r=," +
    "no-header,collect-only,co,durations=,disable-warnings,W|pythonwarnings=,capture=," +
    "showlocals,l,color=,import-mode=,strict-markers,runxfail,sw|stepwise",
);
const UNITTEST = opts(
  "v|verbose,q|quiet,f|failfast,c|catch,b|buffer,k=,s|start-directory=,p|pattern=," +
    "t|top-level-directory=,locals,durations=",
);
const JSON_TOOL = opts("sort-keys,indent=,compact,json-lines,no-ensure-ascii,tab");
const PY_FLAGS = new Set(["-u", "-B", "-I", "-E", "-s", "-q", "-O", "-OO"]);

function classifyPython(args: readonly ShellWord[], ctx: Ctx): Result {
  let k = 0;
  while (k < args.length && PY_FLAGS.has((args[k] as ShellWord).text)) k += 1;
  const a = args[k];
  if (!a) return UNCLASSIFIED;
  let module: string | undefined;
  let after: readonly ShellWord[];
  if (a.text === "-m") {
    module = args[k + 1]?.text;
    after = args.slice(k + 2);
  } else if (a.text.startsWith("-m") && !a.unresolved) {
    module = a.text.slice(2);
    after = args.slice(k + 1);
  } else {
    return versionOnly(args.slice(k));
  }
  if (args[k + 1]?.unresolved) return UNCLASSIFIED;
  switch (module) {
    case "pytest":
      return checkedOperands(PYTEST, after, ctx);
    case "unittest":
      return checkedOperands(UNITTEST, after, ctx);
    case "json.tool":
      return classifyBenign({ table: JSON_TOOL, operands: "second-write" }, after, ctx);
    case "pip":
      return classifyPip(after);
    default:
      return UNCLASSIFIED;
  }
}

function checkedOperands(table: OptTable, args: readonly ShellWord[], ctx: Ctx): Result {
  return classifyBenign({ table, operands: "read" }, args, ctx);
}

const AWK = opts("F|field-separator=,v|assign=", { permute: false });

function classifyAwk(args: readonly ShellWord[]): Result {
  const p = parsedOr(AWK, args);
  if (!p) return versionOnly(args);
  const program = p.operands[0];
  if (!program || program.unresolved) return UNCLASSIFIED;
  // Any `>` or `|` may be an output redirection or pipe (string literals can hide `;`/`}`).
  if (/[>|]|system|getline|@|ENVIRON|PROCINFO|close\s*\(|fflush/.test(program.text)) {
    return UNCLASSIFIED;
  }
  if (p.opts.some((o) => o.values.some((v) => v.unresolved))) return UNCLASSIFIED;
  return p.operands.slice(1).some((w) => w.unresolved) ? UNCLASSIFIED : null;
}

// find / fd / rm --------------------------------------------------------------------------------

const FIND_ARITY: Record<string, number> = Object.fromEntries([
  ...[
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-wholename",
    "-iwholename",
    "-regex",
    "-iregex",
    "-type",
    "-xtype",
    "-maxdepth",
    "-mindepth",
    "-mtime",
    "-mmin",
    "-atime",
    "-amin",
    "-ctime",
    "-cmin",
    "-size",
    "-newer",
    "-perm",
    "-user",
    "-group",
    "-uid",
    "-gid",
    "-links",
    "-inum",
    "-samefile",
    "-printf",
    "-regextype",
    "-newermt",
    "-lname",
    "-ilname",
    "-used",
  ].map((k) => [k, 1]),
  ...[
    "-print",
    "-print0",
    "-ls",
    "-prune",
    "-quit",
    "-empty",
    "-readable",
    "-writable",
    "-executable",
    "-true",
    "-false",
    "-not",
    "-a",
    "-and",
    "-o",
    "-or",
    "!",
    "(",
    ")",
    ",",
    "-depth",
    "-d",
    "-xdev",
    "-mount",
    "-follow",
    "-noleaf",
    "-nouser",
    "-nogroup",
    "-daystart",
  ].map((k) => [k, 0]),
]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function classifyFind(args: readonly ShellWord[], ctx: Ctx, depth: number): Result {
  let k = 0;
  while (k < args.length && ["-L", "-H", "-P"].includes((args[k] as ShellWord).text)) k += 1;
  while (k < args.length) {
    const t0 = (args[k] as ShellWord).text;
    if (t0.startsWith("-") || t0 === "(" || t0 === "!") break;
    if ((args[k] as ShellWord).unresolved) return UNCLASSIFIED;
    k += 1;
  }
  const results: Result[] = [];
  while (k < args.length) {
    const w = args[k] as ShellWord;
    if (w.unresolved) return UNCLASSIFIED;
    if (FIND_EXEC.has(w.text)) {
      let end = k + 1;
      while (end < args.length && args[end]?.text !== ";" && args[end]?.text !== "+") end += 1;
      const r = inner(args.slice(k + 1, end), ctx, depth, UNCLASSIFIED);
      results.push(isSpecific(r) ? r : UNCLASSIFIED);
      k = end + 1;
      continue;
    }
    const arity = FIND_ARITY[w.text];
    if (arity === undefined) return combine([...results, UNCLASSIFIED]);
    for (let n = 1; n <= arity; n++) if (args[k + n]?.unresolved) return UNCLASSIFIED;
    k += 1 + arity;
  }
  return combine(results);
}

const RM = opts(
  "r|R|recursive,f|force,i,I,interactive?,d|dir,v|verbose,one-file-system,no-preserve-root," +
    "preserve-root?",
);

function classifyRm(args: readonly ShellWord[], ctx: Ctx): Result {
  const p = parsedOr(RM, args);
  if (!p) return UNCLASSIFIED;
  if (has(p, "recursive") && has(p, "force")) return DESTRUCTIVE;
  let unclassified = false;
  for (const w of p.operands) {
    const v = deleteVerdict(w, ctx);
    if (v === "outside") return "fs.delete_outside_worktree";
    if (v === "unclassified") unclassified = true;
  }
  return unclassified ? UNCLASSIFIED : null;
}

// Builtins ------------------------------------------------------------------------------------

const ARITH_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);

function classifyTest(bracket: boolean): Handler {
  return (args) => {
    let ops = args;
    if (bracket) {
      if (ops[ops.length - 1]?.text !== "]") return UNCLASSIFIED;
      ops = ops.slice(0, -1);
    }
    for (const w of ops) {
      if (w.unresolved || /[[`]|\$\(/.test(w.text)) return UNCLASSIFIED;
    }
    if (ops.some((w) => ARITH_OPS.has(w.text))) {
      const values = ops.filter(
        (w) => !ARITH_OPS.has(w.text) && !["!", "-a", "-o"].includes(w.text),
      );
      if (!values.every((w) => /^-?\d+$/.test(w.text))) return UNCLASSIFIED;
    }
    return null;
  };
}

const PRINTF = opts("v=", { permute: false });
const READ = opts("r,a=,d=,n=,N=,p=,s,t=,u=,e,i=");
const EXPORT = opts("n,p,f");
const DECLARE = opts("a,A,f,F,g,l,p,r,t,u,x");
const UNSET = opts("f,v,n");
const CD = opts("L,P,e,@");
const TYPE = opts("a,f,p,P,t");
// No `k` (keyword: assignment operands enter the environment) and no `a` (allexport).
const SET_LETTERS = /^[-+][eufCBbvhmnpPH]+$/;

function codeIn(w: ShellWord): boolean {
  return /\$\(|`/.test(w.text);
}

const BUILTINS: Record<string, Handler> = {
  echo: () => null,
  true: () => null,
  false: () => null,
  ":": () => null,
  sleep: () => null,
  wait: () => null,
  pwd: (args) => (args.every((w) => w.text === "-L" || w.text === "-P") ? null : UNCLASSIFIED),
  exit: (args) => (args.every((w) => /^\d+$/.test(w.text)) ? null : UNCLASSIFIED),
  return: (args) => (args.every((w) => /^\d+$/.test(w.text)) ? null : UNCLASSIFIED),
  shift: (args) => (args.every((w) => /^\d+$/.test(w.text)) ? null : UNCLASSIFIED),
  test: classifyTest(false),
  "[": classifyTest(true),
  printf: (args) => {
    const p = parsedOr(PRINTF, args);
    if (!p) return UNCLASSIFIED;
    const v = valueOf(p, "v");
    if (v && (v.unresolved || !nameOk(v.text))) return UNCLASSIFIED;
    return p.operands.some((w) => w.unresolved || codeIn(w)) ? UNCLASSIFIED : null;
  },
  read: (args) => {
    const p = parsedOr(READ, args);
    if (!p) return UNCLASSIFIED;
    const a = valueOf(p, "a");
    const names = [...p.operands, ...(a ? [a] : [])];
    return names.every((w) => !w.unresolved && nameOk(w.text)) ? null : UNCLASSIFIED;
  },
  export: declaration(EXPORT),
  declare: declaration(DECLARE),
  typeset: declaration(DECLARE),
  local: declaration(DECLARE),
  readonly: declaration(DECLARE),
  unset: (args) => {
    const p = parsedOr(UNSET, args);
    // `unset 'x[y]'` evaluates the subscript arithmetically and runs `$(...)` stored in y.
    return p && p.operands.every((w) => !w.unresolved && !/[[`]|\$\(/.test(w.text))
      ? null
      : UNCLASSIFIED;
  },
  type: (args) => (parsedOr(TYPE, args) ? null : UNCLASSIFIED),
  set: (args) => {
    if (args.length === 0) return SECRET_READ; // prints every variable (N7)
    for (let k = 0; k < args.length; k++) {
      const t0 = (args[k] as ShellWord).text;
      if (t0 === "--" || t0 === "-") return null;
      if (/^[-+]o$/.test(t0)) {
        if (!SHELL_O.includes(args[k + 1]?.text ?? "")) return UNCLASSIFIED;
        k += 1;
        continue;
      }
      if (/^[-+][A-Za-z]*o$/.test(t0)) {
        if (!SET_LETTERS.test(t0.slice(0, -1)) || !SHELL_O.includes(args[k + 1]?.text ?? "")) {
          return UNCLASSIFIED;
        }
        k += 1;
        continue;
      }
      if (!SET_LETTERS.test(t0)) return UNCLASSIFIED;
    }
    return null;
  },
  cd: (args, ctx) => {
    const p = parsedOr(CD, args);
    if (!p) return UNCLASSIFIED;
    // A `cd` may fail, run in a subshell or be skipped by `||`, so after any `cd` other than
    // `cd .` the working directory is unknown and every relative path counts as outside.
    const target = p.operands[0];
    if (target && !target.unresolved && target.text === "." && p.operands.length === 1) return null;
    ctx.cwd = null;
    ctx.branches.add(undefined);
    return null;
  },
};

function declaration(table: OptTable): Handler {
  return (args) => {
    const p = parsedOr(table, args);
    if (!p) return UNCLASSIFIED;
    // N7: listing (`declare`, `export -p`) and `-p NAME` print values.
    if (p.operands.length === 0 || has(p, "p")) return SECRET_READ;
    return p.operands.every(declOperandOk) ? null : UNCLASSIFIED;
  };
}

// Secrets -------------------------------------------------------------------------------------

function subcommandIs(args: readonly ShellWord[], table: Record<string, readonly string[] | true>) {
  const positional = args.filter((w) => !w.text.startsWith("-")).map((w) => w.text);
  for (const [first, seconds] of Object.entries(table)) {
    if (positional[0] !== first) continue;
    if (seconds === true) return true;
    if (seconds.includes(positional[1] ?? "")) return true;
  }
  return false;
}

const SECRET_TOOLS: Record<string, Handler> = {
  security: (args) =>
    subcommandIs(args, {
      "find-generic-password": true,
      "find-internet-password": true,
      "find-certificate": true,
      "find-identity": true,
      "dump-keychain": true,
      export: true,
    })
      ? SECRET_READ
      : UNCLASSIFIED,
  "secret-tool": (args) =>
    subcommandIs(args, { lookup: true, search: true }) ? SECRET_READ : UNCLASSIFIED,
  pass: () => SECRET_READ,
  op: (args) =>
    subcommandIs(args, { read: true, inject: true, run: true, item: ["get"] })
      ? SECRET_READ
      : UNCLASSIFIED,
  gh: (args) => {
    if (subcommandIs(args, { auth: ["token"] })) return SECRET_READ;
    if (
      subcommandIs(args, { auth: ["status"] }) &&
      args.some((w) => ["-t", "--show-token"].includes(w.text))
    ) {
      return SECRET_READ;
    }
    if (subcommandIs(args, { pr: ["create"] })) return "pr.create";
    if (subcommandIs(args, { pr: ["merge"] })) return "git.merge_protected";
    return UNCLASSIFIED;
  },
  aws: (args) =>
    subcommandIs(args, {
      configure: ["get", "export-credentials"],
      sts: ["get-session-token", "assume-role"],
      secretsmanager: ["get-secret-value"],
      ssm: ["get-parameter", "get-parameters", "get-parameters-by-path"],
    })
      ? SECRET_READ
      : UNCLASSIFIED,
  gcloud: (args) =>
    subcommandIs(args, { auth: ["print-access-token", "print-identity-token"] })
      ? SECRET_READ
      : UNCLASSIFIED,
};

// Benign programs -----------------------------------------------------------------------------

type OperandRule = "read" | "write-all" | "dest-last" | "move" | "second-write" | "none" | "date";

interface BenignSpec {
  table: OptTable;
  operands: OperandRule;
  /** Option keys that make every operand a write target (`prettier --write`, `eslint --fix`). */
  writeWhen?: readonly string[];
}

const b = (dsl: string, operands: OperandRule = "read", numeric = false): BenignSpec => ({
  table: opts(dsl, { numeric }),
  operands,
});

const GREP =
  "i|ignore-case,y,v|invert-match,n|line-number,r|recursive,R|dereference-recursive," +
  "l|files-with-matches,L|files-without-match,c|count,o|only-matching,q|quiet|silent," +
  "s|no-messages,w|word-regexp,x|line-regexp,E|extended-regexp,F|fixed-strings," +
  "P|perl-regexp,G|basic-regexp,e|regexp=,f|file=<,h|no-filename,H|with-filename," +
  "A|after-context=,B|before-context=,C|context=,m|max-count=,include=,exclude=," +
  "exclude-dir=,exclude-from=<,color?,colour?,a|text,I,z|null-data,Z|null,b|byte-offset," +
  "T|initial-tab,label=,line-buffered,U|binary,binary-files=,d|directories=,D|devices=";
const CHECKSUM =
  "c|check,b|binary,t|text,a|algorithm=,q|quiet,s|status,w|warn,strict,tag,z|zero,ignore-missing,r,l|length=";

const BENIGN: Record<string, BenignSpec> = {
  ls: b(
    "a|all,A|almost-all,l,h|human-readable,R|recursive,r|reverse,t,S,d|directory,1," +
      "F|classify?,G,i|inode,k|kibibytes,n|numeric-uid-gid,o,p,s|size,u,U,c,C,x,m,T,@,e," +
      "color?,group-directories-first,full-time,time-style=,sort=,ignore=,I=,hide=," +
      "B|ignore-backups,L|dereference,H,Q|quote-name,N|literal,b|escape,g,q,v,w|width=,X,Z|context",
  ),
  cat: b(
    "n|number,b|number-nonblank,s|squeeze-blank,v|show-nonprinting,e,E|show-ends,t,T|show-tabs,A|show-all,u",
  ),
  head: b("n|lines=,c|bytes=,q|quiet|silent,v|verbose,z|zero-terminated", "read", true),
  tail: b(
    "n|lines=,c|bytes=,q|quiet|silent,v|verbose,z|zero-terminated,f|follow?,F,s|sleep-interval=,pid=,retry",
    "read",
    true,
  ),
  wc: b("l|lines,w|words,c|bytes,m|chars,L|max-line-length,files0-from=<,total="),
  sort: b(
    "r|reverse,n|numeric-sort,u|unique,k|key=,t|field-separator=,f|ignore-case," +
      "h|human-numeric-sort,V|version-sort,s|stable,b|ignore-leading-blanks,d|dictionary-order," +
      "g|general-numeric-sort,M|month-sort,R|random-sort,c|check?,C,z|zero-terminated," +
      "o|output=>,S|buffer-size=,T|temporary-directory=>,parallel=,compress-program=!," +
      "random-source=<,files0-from=<,debug",
  ),
  uniq: b(
    "c|count,d|repeated,D,u|unique,i|ignore-case,f|skip-fields=,s|skip-chars=,w|check-chars=,z|zero-terminated",
    "second-write",
  ),
  cut: b(
    "d|delimiter=,f|fields=,c|characters=,b|bytes=,s|only-delimited,complement,output-delimiter=,z|zero-terminated,n",
  ),
  tr: b("d|delete,s|squeeze-repeats,c|C|complement,t|truncate-set1"),
  nl: b(
    "b|body-numbering=,n|number-format=,w|number-width=,s|number-separator=,v|starting-line-number=,i|line-increment=",
  ),
  grep: b(GREP, "read", true),
  egrep: b(GREP, "read", true),
  fgrep: b(GREP, "read", true),
  rg: b(
    "i|ignore-case,S|smart-case,s|case-sensitive,v|invert-match,n|line-number,N|no-line-number," +
      "l|files-with-matches,files-without-match,c|count,count-matches,o|only-matching,q|quiet," +
      "w|word-regexp,x|line-regexp,F|fixed-strings,P|pcre2,e|regexp=,f|file=<,g|glob=,iglob=," +
      "t|type=,T|type-not=,A|after-context=,B|before-context=,C|context=,m|max-count=," +
      "u|unrestricted,hidden,no-ignore,L|follow,j|threads=,color=,colors=,json,vimgrep," +
      "heading,no-heading,H|with-filename,I|no-filename,files,type-list,max-depth=,d=," +
      "max-filesize=,sort=,sortr=,z|search-zip,0|null,trim,M|max-columns=,r|replace=," +
      "U|multiline,multiline-dotall,p|pretty,stats,a|text,pre=!,pre-glob=!,engine=,no-config," +
      "ignore-file=<,null-data,passthru,column,b|byte-offset,E|encoding=,glob-case-insensitive",
  ),
  diff: b(
    "u,U|unified=,c,C|context=,q|brief,r|recursive,N|new-file,y|side-by-side," +
      "w|ignore-all-space,b|ignore-space-change,B|ignore-blank-lines,i|ignore-case," +
      "s|report-identical-files,color?,x|exclude=,X|exclude-from=<,a|text,p|show-c-function," +
      "W|width=,label=,strip-trailing-cr,no-dereference,from-file=<,to-file=<,t|expand-tabs," +
      "ignore-trailing-space,Z,E,suppress-common-lines,normal",
  ),
  cmp: b("l|verbose,s|quiet|silent,b|print-bytes,i|ignore-initial=,n|bytes="),
  comm: b("1,2,3,check-order,nocheck-order,output-delimiter=,z|zero-terminated,total"),
  which: b("a,s"),
  whoami: b(""),
  id: b("u|user,g|group,G|groups,n|name,r|real"),
  uname: b(
    "a|all,s|kernel-name,n|nodename,r|kernel-release,v|kernel-version,m|machine,p|processor,o|operating-system",
  ),
  hostname: b("s|short,f|fqdn,i|ip-address", "none"),
  date: b("u|utc|universal,I|iso-8601?,R|rfc-email,d|date=,r|reference=<,j,f=,v=", "date"),
  basename: b("a|multiple,s|suffix=,z|zero"),
  dirname: b("z|zero"),
  realpath: b(
    "e|canonicalize-existing,m|canonicalize-missing,s|strip|no-symlinks,q|quiet,relative-to=,relative-base=,L|logical,P|physical,z|zero",
  ),
  readlink: b(
    "f|canonicalize,e|canonicalize-existing,m|canonicalize-missing,n|no-newline,q|quiet,s|silent,v|verbose,z|zero",
  ),
  stat: b("L|dereference,f|file-system,c|format=,printf=,t|terse,x,s,l"),
  du: b(
    "s|summarize,h|human-readable,a|all,c|total,d|max-depth=,k,m,b|bytes,x|one-file-system,L|dereference,exclude=,apparent-size,t|threshold=,0|null,time?",
  ),
  df: b(
    "h|human-readable,H|si,k,T|print-type,t|type=,x|exclude-type=,l|local,i|inodes,P|portability,a|all",
  ),
  tree: b(
    "a,d,f,i,l,L=,I=,P=,s,h,D,C,n,J,F,noreport,dirsfirst,charset=,gitignore,du,prune,matchdirs,v,t,r,u,g,p,Q,N,x,o=>",
  ),
  jq: b(
    "r|raw-output,j|join-output,a|ascii-output,c|compact-output,n|null-input,s|slurp," +
      "e|exit-status,S|sort-keys,C|color-output,M|monochrome-output,tab,indent=,arg==," +
      "argjson==,slurpfile==,rawfile==,f|from-file=<,R|raw-input,raw-output0,seq,stream",
  ),
  seq: b("s|separator=,w|equal-width,f|format="),
  od: b(
    "A|address-radix=,t|format=,N|read-bytes=,j|skip-bytes=,v|output-duplicates,w|width?,c,x,d,o,b,a",
  ),
  xxd: b("l=,s=,c=,g=,p,i,u,b,e,o=,C,a,E", "second-write"),
  cksum: b(CHECKSUM),
  sha1sum: b(CHECKSUM),
  sha256sum: b(CHECKSUM),
  sha512sum: b(CHECKSUM),
  md5sum: b(CHECKSUM),
  b2sum: b(CHECKSUM),
  shasum: b(CHECKSUM),
  md5: b("q,r,s=,p"),
  mkdir: b("p|parents,v|verbose,m|mode=", "write-all"),
  touch: b("a,m,c|no-create,d|date=,t=,r|reference=<,h|no-dereference", "write-all"),
  tee: b("a|append,i|ignore-interrupts,p,output-error?", "write-all"),
  cp: b(
    // Link-making and recursive forms (`-l -s -a -P -d -r`, `--parents`) are unclassifiable:
    // links and copied trees defeat lexical path checks.
    "r|R|recursive!,f|force,i|interactive,n|no-clobber,p,a|archive!,v|verbose,u|update?," +
      "L|dereference,P|no-dereference!,d!,H,l|link!,s|symbolic-link!,t|target-directory=>," +
      "T|no-target-directory,preserve?,no-preserve=,parents!,backup?,b,S|suffix=," +
      "x|one-file-system,attributes-only,sparse=,reflink?,c",
    "dest-last",
  ),
  mv: b(
    "f|force,i|interactive,n|no-clobber,v|verbose,u|update?,t|target-directory=>," +
      "T|no-target-directory,backup?,b,S|suffix=",
    "move",
  ),
  eslint: {
    table: opts(
      "max-warnings=,fix,fix-dry-run,fix-type=,f|format=,o|output-file=>,cache,cache-location=>," +
        "cache-strategy=,quiet,ext=,no-ignore,ignore-pattern=,color,no-color," +
        "report-unused-disable-directives,report-unused-disable-directives-severity=," +
        "no-warn-ignored,debug,print-config=<,stdin,stdin-filename=,no-error-on-unmatched-pattern," +
        "pass-on-no-patterns,v|version,h|help,c|config=!,plugin=!,rulesdir=!," +
        "resolve-plugins-relative-to=!,parser=!,parser-options=!,rule=!,env=,global=," +
        "no-eslintrc,no-config-lookup,flag=!,inspect-config!,init!,mcp!",
      {
        values: {
          format: [
            "stylish",
            "json",
            "json-with-metadata",
            "compact",
            "unix",
            "visualstudio",
            "html",
            "checkstyle",
            "junit",
            "tap",
          ],
        },
      },
    ),
    operands: "read",
    writeWhen: ["fix"],
  },
  prettier: {
    table: opts(
      "w|write,c|check,l|list-different,u|ignore-unknown,ignore-path=<,log-level=,loglevel=," +
        "cache,cache-location=>,cache-strategy=,no-config,no-editorconfig,with-node-modules," +
        "no-error-on-unmatched-pattern,stdin-filepath=,single-quote,no-semi,print-width=," +
        "tab-width=,use-tabs,trailing-comma=,end-of-line=,v|version,h|help,parser=,plugin=!," +
        "config=!,find-config-path=<,file-info=<,support-info",
      {
        values: {
          parser: [
            "babel",
            "typescript",
            "flow",
            "espree",
            "meriyah",
            "acorn",
            "css",
            "less",
            "scss",
            "json",
            "json5",
            "jsonc",
            "graphql",
            "markdown",
            "mdx",
            "vue",
            "yaml",
            "html",
            "angular",
            "lwc",
            "glimmer",
          ],
        },
      },
    ),
    operands: "read",
    writeWhen: ["write"],
  },
  vitest: {
    table: opts(
      "run,watch,w,reporter=,coverage,t|testNamePattern=,project=,globals,passWithNoTests," +
        "bail=,allowOnly,silent?,changed?,u|update,isolate,no-isolate,pool=,shard=,retry=," +
        "typecheck,environment=,dom,clearCache,v|version,h|help,no-color,hideSkippedTests," +
        "expandSnapshotDiff,testTimeout=,hookTimeout=,maxWorkers=,minWorkers=," +
        "no-file-parallelism,logHeapUsage,standalone,outputFile=>,dir=,mode=," +
        "ui!,api!,c|config=!,r|root=!,inspect!,inspect-brk!,browser!,workspace=!,setupFiles=!," +
        "globalSetup=!",
      {
        values: {
          reporter: [
            "default",
            "verbose",
            "dot",
            "basic",
            "json",
            "junit",
            "tap",
            "tap-flat",
            "hanging-process",
            "github-actions",
            "tree",
          ],
          environment: ["node", "jsdom", "happy-dom", "edge-runtime"],
          pool: ["forks", "threads", "vmThreads", "vmForks"],
        },
      },
    ),
    operands: "read",
  },
};

function classifyBenign(spec: BenignSpec, args: readonly ShellWord[], ctx: Ctx): Result {
  const p = getopt(spec.table, args);
  if (!p.ok) return UNCLASSIFIED;
  for (const o of p.opts) {
    if (o.values.some((v) => v.unresolved)) return UNCLASSIFIED;
    if (o.def.write && o.values.some((v) => !writeAllowed(v, ctx))) return UNCLASSIFIED;
  }
  const ops = p.operands;
  if (ops.some((w) => w.unresolved)) return UNCLASSIFIED;
  const target = valueOf(p, "target-directory");
  if (spec.writeWhen && has(p, ...spec.writeWhen) && !ops.every((w) => writeAllowed(w, ctx))) {
    return UNCLASSIFIED; // minor 4: rewrites operands in place
  }
  switch (spec.operands) {
    case "none":
      return ops.length ? UNCLASSIFIED : null;
    case "date":
      return ops.every((w) => w.text.startsWith("+")) ? null : UNCLASSIFIED;
    case "write-all":
      return ops.every((w) => writeAllowed(w, ctx)) ? null : UNCLASSIFIED;
    case "second-write":
      return !ops[1] || writeAllowed(ops[1], ctx) ? null : UNCLASSIFIED;
    case "dest-last":
    case "move": {
      const dest = target ?? ops[ops.length - 1];
      const sources = target ? ops : ops.slice(0, -1);
      if (!dest || !writeAllowed(dest, ctx)) return UNCLASSIFIED;
      // E6: the destination may be a directory, so each source lands at dest/basename(source).
      for (const src of sources) {
        const base = src.text.replace(/\/+$/, "").split("/").pop() ?? "";
        if (base === "" || base === "." || base === "..") return UNCLASSIFIED;
        const into = { text: `${dest.text.replace(/\/+$/, "")}/${base}`, unresolved: false };
        if (!writeAllowed(into, ctx)) return UNCLASSIFIED;
      }
      if (spec.operands === "move") {
        for (const src of sources) {
          const v = deleteVerdict(src, ctx);
          if (v === "outside") return "fs.delete_outside_worktree";
          if (v === "unclassified") return UNCLASSIFIED;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// Handler table -------------------------------------------------------------------------------

const DESTROY: Handler = () => DESTRUCTIVE;
const UNKNOWN: Handler = () => UNCLASSIFIED;

const HANDLERS: Record<string, Handler> = {
  ...BUILTINS,
  ...SECRET_TOOLS,
  sh: classifyShell,
  bash: classifyShell,
  zsh: classifyShell,
  dash: classifyShell,
  ksh: classifyShell,
  mksh: classifyShell,
  ash: classifyShell,
  eval: (args, ctx, depth) => {
    const r = classifyString(words(args).join(" "), ctx, depth + 1);
    if (isSpecific(r)) return r;
    return args.some((w) => w.unresolved) ? UNCLASSIFIED : r;
  },
  source: UNKNOWN,
  ".": UNKNOWN,
  sudo: escalate(SUDO),
  doas: escalate(DOAS),
  pkexec: escalate(PKEXEC),
  su: (args, ctx, depth) => {
    const p = parsedOr(SU, args);
    const c = p ? valueOf(p, "command") : undefined;
    const r = c && !c.unresolved ? classifyString(c.text, ctx, depth + 1) : null;
    return isSpecific(r) ? r : DESTRUCTIVE;
  },
  xargs: (args, ctx, depth) => {
    const p = parsedOr(XARGS, args);
    return p ? inner(p.operands, ctx, depth, UNCLASSIFIED) : UNCLASSIFIED;
  },
  watch: (args, ctx, depth) => {
    const p = parsedOr(WATCH, args);
    if (!p) return UNCLASSIFIED;
    const r = classifyString(words(p.operands).join(" "), ctx, depth + 1);
    return isSpecific(r) ? r : UNCLASSIFIED;
  },
  parallel: (args, ctx, depth) => {
    const p = parsedOr(PARALLEL, args);
    if (!p) return UNCLASSIFIED;
    const sep = p.operands.findIndex((w) => w.text.startsWith(":::"));
    const cmd = sep >= 0 ? p.operands.slice(0, sep) : p.operands;
    const r = classifyString(words(cmd).join(" "), ctx, depth + 1);
    return isSpecific(r) ? r : UNCLASSIFIED;
  },
  busybox: (args, ctx, depth) => inner(args, ctx, depth, UNCLASSIFIED),
  nohup: transparent(NONE),
  builtin: transparent(NONE),
  time: transparent(TIME),
  nice: transparent(NICE),
  stdbuf: transparent(STDBUF),
  timeout: transparent(TIMEOUT, 1),
  exec: transparent(EXEC),
  command: (args, ctx, depth) => {
    const p = parsedOr(COMMAND, args);
    if (!p) return UNCLASSIFIED;
    if (has(p, "v", "V")) return null;
    return inner(p.operands, ctx, depth, "same");
  },
  env: classifyEnv,
  printenv: () => SECRET_READ,
  // N2: tsc takes output paths (outDir, declarationDir, tsBuildInfoFile) from tsconfig files the
  // agent may have written; only version probes are benign.
  tsc: versionOnly,
  node: versionOnly,
  nodejs: versionOnly,
  tsx: versionOnly,
  "ts-node": versionOnly,
  deno: versionOnly,
  perl: versionOnly,
  ruby: versionOnly,
  php: versionOnly,
  lua: versionOnly,
  Rscript: versionOnly,
  osascript: versionOnly,
  awk: classifyAwk,
  gawk: classifyAwk,
  mawk: classifyAwk,
  nawk: classifyAwk,
  pytest: (args, ctx) => checkedOperands(PYTEST, args, ctx),
  find: classifyFind,
  jq: (args, ctx) => {
    // N7: programs from files (`-f`, `include`, `import`) are unseen and may read `env`.
    const p = getopt(BENIGN.jq?.table as OptTable, args);
    if (p.ok && has(p, "from-file")) return SECRET_READ;
    if (args.some((w) => /\b(?:include|import)\b|(?<![.\w$])env\b|\$ENV/.test(w.text))) {
      return SECRET_READ;
    }
    const r = classifyBenign(BENIGN.jq as BenignSpec, args, ctx);
    if (r !== null) return r;
    // `$__loc__`/`input_filename` expose file names.
    return args.some((w) => /\$__loc__|input_filename|\$__prog/.test(w.text)) ? UNCLASSIFIED : null;
  },
  fd: (args, ctx) => classifyBenign(b(FD_OPTS), args, ctx),
  fdfind: (args, ctx) => classifyBenign(b(FD_OPTS), args, ctx),
  rm: classifyRm,
  dd: DESTROY,
  mkfs: DESTROY,
  shutdown: DESTROY,
  reboot: DESTROY,
  halt: DESTROY,
  poweroff: DESTROY,
  git: (args, ctx) => classifyGit(args, ctx),
  curl: (args, ctx) => classifyCurl(args, ctx),
  wget: (args, ctx) => classifyWget(args, ctx),
  npm: (args, ctx) => classifyPackageManager("npm", args, ctx),
  pnpm: (args, ctx) => classifyPackageManager("pnpm", args, ctx),
  yarn: (args, ctx) => classifyPackageManager("yarn", args, ctx),
  bun: (args, ctx) => classifyPackageManager("bun", args, ctx),
  npx: () => "package.install",
  pnpx: () => "package.install",
  bunx: () => "package.install",
  pip: (args) => classifyPip(args),
  pip3: (args) => classifyPip(args),
  brew: (args) => classifySystemInstaller("brew", args),
  cargo: (args) => classifySystemInstaller("cargo", args),
  gem: (args) => classifySystemInstaller("gem", args),
  go: (args) => classifySystemInstaller("go", args),
  pipx: (args) => classifySystemInstaller("pipx", args),
  "apt-get": (args) => classifySystemInstaller("apt-get", args),
  apt: (args) => classifySystemInstaller("apt", args),
};

const FD_OPTS =
  "H|hidden,I|no-ignore,u|unrestricted,no-ignore-vcs,t|type=,e|extension=,E|exclude=," +
  "d|max-depth=,min-depth=,exact-depth=,a|absolute-path,l|list-details,g|glob,F|fixed-strings," +
  "s|case-sensitive,i|ignore-case,L|follow,0|print0,p|full-path,max-results=,1,c|color=," +
  "j|threads=,S|size=,changed-within=,changed-before=,o|owner=,prune,base-directory=," +
  "strip-cwd-prefix?,path-separator=,search-path=,format=,x|exec=!,X|exec-batch=!";
