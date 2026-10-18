import {
  type Ctx,
  type Result,
  EXTERNAL_WRITE,
  PACKAGE_INSTALL,
  PACKAGE_INSTALL_GLOBAL,
  SECRET_READ,
  UNCLASSIFIED,
} from "./context.js";
import { getopt, has, opts, valueOf, type Parsed } from "./getopt.js";
import { dirInside } from "./paths.js";
import type { ShellWord } from "./shell.js";

/** One option table for npm, pnpm, yarn and bun. Exec-capable config options are marked `!`. */
const PM = opts(
  "g|global?,location=,F|filter=,r|recursive,w|workspace=,workspaces,ws,if-present,s|silent," +
    "loglevel=,reporter=,parallel,stream,frozen-lockfile,prefer-offline,offline,D|save-dev," +
    "P|save-prod,O|save-optional,E|save-exact,S|save,save-peer,ignore-scripts,optional," +
    "production,prod,dev,legacy-peer-deps,force,dry-run,json,depth=,long,a|all," +
    "include-workspace-root,workspace-root,y|yes,registry=,omit=,include=,C|dir=,prefix=," +
    "cwd=,shamefully-hoist,lockfile-only,fix,audit-level=,q|quiet,v|version,h|help,color?," +
    "aggregate-output,report-summary,changed-files-ignore-pattern=,test-pattern=," +
    "resume-from=,fail-if-no-match,sort,bail,workspace-concurrency=,no-color,no-bail," +
    "no-sort,no-optional,no-frozen-lockfile,script-shell=!,node-options=!,userconfig=!," +
    "globalconfig=!,init-module=!,shell=!,editor=!,c|call=!,foreground-scripts,timing",
  { permute: true },
);

const INSTALL = new Set([
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "install",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "install-clean",
  "install-test",
  "it",
  "remove",
  "rm",
  "r",
  "un",
  "uninstall",
  "unlink",
  "update",
  "up",
  "upgrade",
  "dedupe",
  "ddp",
  "prune",
  "rebuild",
  "rb",
  "import",
  "sync",
]);
const RUNNERS = new Set(["exec", "x", "dlx", "create", "innit", "init"]);
const READ_ONLY = new Set([
  "ls",
  "list",
  "ll",
  "la",
  "outdated",
  "why",
  "explain",
  "view",
  "info",
  "show",
  "v",
  "help",
  "whoami",
  "root",
  "bin",
  "licenses",
]);
/** Scripts that may run, directly or via `run`. */
export const PM_SCRIPTS = new Set([
  "test",
  "t",
  "tst",
  "lint",
  "typecheck",
  "build",
  "check",
  "format",
  "format:check",
  "dev",
  "start",
]);

function directories(parsed: Parsed, ctx: Ctx): boolean {
  for (const key of ["dir", "prefix", "cwd"]) {
    const v = valueOf(parsed, key);
    if (v && dirInside(v, ctx) === null) return false;
  }
  return true;
}

function isGlobal(parsed: Parsed): boolean {
  if (valueOf(parsed, "location")?.text === "global") return true;
  return parsed.opts.some(
    (o) => o.def.key === "global" && !o.negated && o.values[0]?.text !== "false",
  );
}

/** Script runs: no extra options may be forwarded to the script; operands must be resolved. */
function scriptRun(extra: readonly ShellWord[], dashDash: boolean): Result {
  if (dashDash) return UNCLASSIFIED;
  if (extra.some((w) => w.unresolved || w.text.startsWith("-"))) return UNCLASSIFIED;
  return null;
}

export function classifyPackageManager(name: string, args: readonly ShellWord[], ctx: Ctx): Result {
  // Split at the first operand: options before it are the manager's; after it may be the script's.
  const firstOperand = args.findIndex((w) => !w.text.startsWith("-") || w.text === "-");
  const parsed = getopt(PM, args);
  if (!parsed.ok) return UNCLASSIFIED;
  if (!directories(parsed, ctx)) return UNCLASSIFIED;
  const ops = parsed.operands;
  if (ops.some((w, i) => i === 0 && w.unresolved)) return UNCLASSIFIED;
  const sub = ops[0]?.text;
  const global = isGlobal(parsed);

  if (name === "yarn") {
    if (sub === undefined) return PACKAGE_INSTALL;
    if (sub === "global") return ops[1]?.text === "add" ? PACKAGE_INSTALL_GLOBAL : UNCLASSIFIED;
  }
  if (sub === undefined) {
    return parsed.opts.length > 0 &&
      parsed.opts.every((o) => ["version", "help"].includes(o.def.key))
      ? null
      : UNCLASSIFIED;
  }
  if (INSTALL.has(sub) && !(name === "bun" && sub === "x")) {
    return global ? PACKAGE_INSTALL_GLOBAL : PACKAGE_INSTALL;
  }
  if (RUNNERS.has(sub)) {
    if (sub === "init" && ops.length === 1) return UNCLASSIFIED; // writes package.json unchecked
    if (sub === "exec" && name === "pnpm") return UNCLASSIFIED; // runs a local binary
    return PACKAGE_INSTALL;
  }
  if (sub === "publish") return EXTERNAL_WRITE;
  if (sub === "audit") return ops[1]?.text === "fix" ? PACKAGE_INSTALL : null;
  if (sub === "config") {
    // N7: config reads print registry auth tokens (`//host/:_authToken`, `npmAuthToken`).
    return ["get", "list", "ls"].includes(ops[1]?.text ?? "") ? SECRET_READ : UNCLASSIFIED;
  }
  if (READ_ONLY.has(sub)) return null;

  const dashDash = parsed.dashDashAt >= 0;
  const optsAfterScript = args.slice(firstOperand + 1).some((w) => w.text.startsWith("-"));
  if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") {
    const script = ops[1];
    if (!script || script.unresolved || !PM_SCRIPTS.has(script.text)) return UNCLASSIFIED;
    if (optsAfterScript && !onlyManagerOpts(args, firstOperand)) return UNCLASSIFIED;
    return scriptRun(ops.slice(2), dashDash);
  }
  const direct = name === "npm" ? ["test", "t", "tst", "start"] : [...PM_SCRIPTS];
  if (direct.includes(sub)) {
    if (optsAfterScript && !onlyManagerOpts(args, firstOperand)) return UNCLASSIFIED;
    return scriptRun(ops.slice(1), dashDash);
  }
  if (name === "bun" && (sub === "test" || sub === "build"))
    return scriptRun(ops.slice(1), dashDash);
  return UNCLASSIFIED;
}

/** Options after the script name that the manager itself consumes (e.g. `--if-present`). */
const MANAGER_ONLY = new Set([
  "--if-present",
  "--silent",
  "-s",
  "--parallel",
  "--stream",
  "-r",
  "--recursive",
]);
function onlyManagerOpts(args: readonly ShellWord[], firstOperand: number): boolean {
  return args
    .slice(firstOperand + 1)
    .filter((w) => w.text.startsWith("-"))
    .every((w) => MANAGER_ONLY.has(w.text));
}

const PIP = opts(
  "U|upgrade,user,e|editable=,r|requirement=<,q|quiet,v|verbose,no-deps,pre,force-reinstall," +
    "no-cache-dir,i|index-url=,extra-index-url=,c|constraint=<,t|target=!,prefix=!,root=!," +
    "break-system-packages,isolated,disable-pip-version-check,y|yes,outdated,uptodate," +
    "format=,local,V|version,h|help,dry-run,require-virtualenv",
);

export function classifyPip(args: readonly ShellWord[]): Result {
  const parsed = getopt(PIP, args);
  if (!parsed.ok) return UNCLASSIFIED;
  const sub = parsed.operands[0]?.text;
  if (sub === undefined) return has(parsed, "version", "help") ? null : UNCLASSIFIED;
  if (["install", "uninstall", "download", "wheel"].includes(sub)) {
    return has(parsed, "user") ? PACKAGE_INSTALL_GLOBAL : PACKAGE_INSTALL;
  }
  if (["list", "show", "freeze", "check", "help"].includes(sub)) {
    return parsed.operands.some((w) => w.unresolved) ? UNCLASSIFIED : null;
  }
  return UNCLASSIFIED;
}

/** System package tools: installs are global. */
export function classifySystemInstaller(name: string, args: readonly ShellWord[]): Result {
  const sub = args.find((w) => !w.text.startsWith("-"))?.text;
  const installs: Record<string, readonly string[]> = {
    brew: ["install", "reinstall", "upgrade", "tap"],
    cargo: ["install"],
    gem: ["install", "update"],
    go: ["install", "get"],
    pipx: ["install", "inject", "upgrade", "run"],
    "apt-get": ["install", "upgrade", "dist-upgrade"],
    apt: ["install", "upgrade"],
  };
  if (sub && installs[name]?.includes(sub)) return PACKAGE_INSTALL_GLOBAL;
  return UNCLASSIFIED;
}
