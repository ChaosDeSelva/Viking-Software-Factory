import { constants, existsSync, realpathSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CheckDefinition, CheckReason } from "@brokkr/core";
import { CLASSIFIED_HEADS, analyzeCommand } from "@brokkr/policy";
import { resolveWorkingDirectory } from "./executor.js";

export const HARNESS_DIR_PLACEHOLDER = "{{harnessDir}}";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Substitute `{{harnessDir}}` with the resolved harness directory. The result
 * must stay inside that directory (lexically and after resolving symlinks);
 * any other `{{...}}` placeholder is rejected.
 */
export function expandCommand(
  command: readonly string[],
  harnessDir: string | undefined,
): { ok: true; command: string[] } | { ok: false; message: string } {
  const out: string[] = [];
  for (const arg of command) {
    if (!arg.includes("{{")) {
      out.push(arg);
      continue;
    }
    const unknown = [...arg.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].find((m) => m[1] !== "harnessDir");
    if (unknown) return { ok: false, message: `unknown placeholder '${unknown[0]}' in '${arg}'` };
    if (harnessDir === undefined)
      return {
        ok: false,
        message: `'${arg}' uses ${HARNESS_DIR_PLACEHOLDER} but no harness directory is known`,
      };
    const root = realpathSync(harnessDir);
    const expanded = arg.split(HARNESS_DIR_PLACEHOLDER).join(root);
    // Only path-like arguments that start with the placeholder are confined; e.g. `--config={{harnessDir}}/x`.
    const pathPart = expanded.slice(expanded.indexOf(root));
    const resolved = resolve(pathPart);
    let real = resolved;
    try {
      real = realpathSync(resolved);
    } catch {
      // not existing yet: the lexical check below still applies
    }
    if (!inside(root, resolved) || !inside(root, real))
      return { ok: false, message: `'${arg}' resolves outside the harness directory` };
    out.push(expanded.slice(0, expanded.indexOf(root)) + resolved);
  }
  return { ok: true, command: out };
}

type WhenCheck = Pick<CheckDefinition, "id" | "command"> & {
  cwd?: string | undefined;
  when?: CheckDefinition["when"];
};

export interface PreflightContext {
  /** Absolute workspace root. */
  workspace: string;
  /** PATH used to resolve executables (the filtered check PATH). */
  path: string;
  /** Directory of the harness that declared the check (for `{{harnessDir}}`). */
  harnessDir?: string;
}

export type PreflightResult =
  | { ok: true; command: string[]; cwdDir: string }
  | { ok: false; reason: CheckReason; message: string; command: string[] };

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_SHORTHANDS = new Set(["test", "start"]);

async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string, path: string): Promise<string | undefined> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function findLocalBin(name: string, from: string, root: string): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (await isExecutable(candidate)) return candidate;
    if (dir === root || !inside(root, dir)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function packageScripts(cwdDir: string): Promise<Record<string, unknown> | undefined> {
  const file = join(cwdDir, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    const pkg = JSON.parse(await readFile(file, "utf8")) as { scripts?: Record<string, unknown> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** Which package script an argv runs, if any (`pnpm run x`, `npm test`, `npm run-script x`). */
function scriptFor(argv: readonly string[]): string | undefined {
  const [pm, sub, name] = argv;
  if (pm === undefined || !PACKAGE_MANAGERS.has(pm.split("/").pop() ?? "")) return undefined;
  if ((sub === "run" || sub === "run-script") && name !== undefined && !name.startsWith("-"))
    return name;
  if (sub !== undefined && SCRIPT_SHORTHANDS.has(sub)) return sub;
  return undefined;
}

/** Which binary `pnpm exec x`, `npx x`, `yarn exec x`, `bunx x` would run. */
function execBinFor(argv: readonly string[]): string | undefined {
  const head = argv[0]?.split("/").pop() ?? "";
  let rest: readonly string[] | undefined;
  if (head === "npx" || head === "bunx") rest = argv.slice(1);
  else if (PACKAGE_MANAGERS.has(head) && argv[1] === "exec") rest = argv.slice(2);
  return rest?.find((a) => !a.startsWith("-"));
}

/**
 * Validate a check template against the repository before running it (spec
 * §5.2): placeholders, working directory, `when` conditions (all keys AND),
 * executable on PATH, package scripts and locally installed binaries. A
 * failure becomes an explicit skipped/errored result, never a pass.
 */
export async function preflightCheck(
  check: WhenCheck,
  ctx: PreflightContext,
): Promise<PreflightResult> {
  const expanded = expandCommand(check.command, ctx.harnessDir);
  if (!expanded.ok)
    return {
      ok: false,
      reason: "invalid_command",
      message: expanded.message,
      command: [...check.command],
    };
  const command = expanded.command;
  const fail = (reason: CheckReason, message: string): PreflightResult => ({
    ok: false,
    reason,
    message,
    command,
  });

  const cwd = await resolveWorkingDirectory(ctx.workspace, check.cwd ?? ".");
  if (!cwd.ok) return fail("cwd_rejected", cwd.error);
  const root = realpathSync(ctx.workspace);
  const cwdDir = cwd.dir;

  const when = check.when;
  for (const file of when?.fileExists ?? []) {
    if (!existsSync(join(cwdDir, file)))
      return fail("not_applicable", `when.fileExists: '${file}' not found`);
  }
  if (when?.anyFileExists && !when.anyFileExists.some((f) => existsSync(join(cwdDir, f))))
    return fail(
      "not_applicable",
      `when.anyFileExists: none of ${when.anyFileExists.join(", ")} found`,
    );
  if (when?.scriptExists) {
    const scripts = await packageScripts(cwdDir);
    for (const name of when.scriptExists) {
      if (!scripts || !(name in scripts))
        return fail("not_applicable", `when.scriptExists: package.json has no '${name}' script`);
    }
  }

  const exe = command[0]!;
  if (exe.includes("/")) {
    const abs = isAbsolute(exe) ? exe : resolve(cwdDir, exe);
    if (!(await isExecutable(abs)))
      return fail("missing_tool", `executable '${exe}' not found or not executable`);
  } else if (!(await findOnPath(exe, ctx.path))) {
    return fail("missing_tool", `executable '${exe}' not found on PATH`);
  }

  // The name in the manifest may be an alias (case variant, symlink, hard link) of a
  // command the classifier denies: classify the binary it actually resolves to.
  const identity = await identifyExecutable(
    exe.includes("/") && !isAbsolute(exe) ? resolve(cwdDir, exe) : exe,
    ctx.path,
  );
  if (identity && identity !== basename(exe).toLowerCase()) {
    const analysis = analyzeCommand([identity, ...command.slice(1)]);
    if (analysis.destructive)
      return fail(
        "policy_denied",
        `'${exe}' resolves to '${identity}': denied as ${analysis.destructive} (destructive-commands)`,
      );
  }

  const script = scriptFor(command);
  if (script !== undefined) {
    const scripts = await packageScripts(cwdDir);
    if (!scripts)
      return fail(
        "missing_script",
        `'${command.join(" ")}' needs a '${script}' script but there is no package.json in ${check.cwd ?? "."}`,
      );
    if (!(script in scripts))
      return fail("missing_script", `package.json has no '${script}' script`);
  }

  const bin = execBinFor(command);
  if (
    bin !== undefined &&
    !(await findLocalBin(bin, cwdDir, root)) &&
    !(await findOnPath(bin, ctx.path))
  ) {
    return fail(
      "missing_tool",
      `'${bin}' is not installed: not found in node_modules/.bin (from ${check.cwd ?? "."} up to the workspace root) or on PATH; install the project's dependencies (e.g. \`pnpm install\`) and retry`,
    );
  }
  return { ok: true, command, cwdDir };
}

/**
 * A package-script run (`pnpm test`, `npm run x`...) in a package that declares
 * dependencies but has no node_modules (up to the workspace root): the package
 * manager would install first, which needs the install-dependencies approval.
 * Returns a diagnostic, or undefined when nothing would be installed.
 */
export async function dependencyInstallNeeded(
  command: readonly string[],
  cwdDir: string,
  workspace: string,
): Promise<string | undefined> {
  let declared = 0;
  try {
    const pkg = JSON.parse(await readFile(join(cwdDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // `pnpm|yarn|bun <name>` runs the package script <name> when one exists.
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const pm = basename(command[0] ?? "").toLowerCase();
    const shorthand =
      ["pnpm", "yarn", "bun"].includes(pm) && command[1] !== undefined && command[1] in scripts;
    if (scriptFor(command) === undefined && !shorthand) return undefined;
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = pkg[key];
      if (deps && typeof deps === "object") declared += Object.keys(deps).length;
    }
  } catch {
    return undefined;
  }
  if (declared === 0) return undefined;
  const root = realpathSync(workspace);
  let dir = cwdDir;
  for (;;) {
    if (existsSync(join(dir, "node_modules"))) return undefined;
    if (dir === root || !inside(root, dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return `'${command.join(" ")}' would install dependencies first: package.json declares ${declared} but node_modules is missing; install-dependencies requires approval (install them before verifying)`;
}

/**
 * Identify the binary a command name runs: the lower-cased basename of its
 * realpath, or, when that is not a name the classifier knows, the known name
 * whose PATH entry has the same device and inode (hard links, case aliases).
 */
export async function identifyExecutable(exe: string, path: string): Promise<string | undefined> {
  const abs = exe.includes("/") ? exe : await findOnPath(exe, path);
  if (!abs || !(await isExecutable(abs))) return undefined;
  const real = await realpath(abs);
  const name = basename(real).toLowerCase();
  if (CLASSIFIED_HEADS.includes(name)) return name;
  const st = await stat(real);
  for (const head of CLASSIFIED_HEADS) {
    const candidate = await findOnPath(head, path);
    if (!candidate) continue;
    const other = await stat(candidate).catch(() => undefined);
    if (other && other.dev === st.dev && other.ino === st.ino) return head;
  }
  return name;
}
