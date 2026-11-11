import type { ExecutionProfile, ProfileCheck } from "./types.js";

// The execution profile as the form edits it (text everywhere) and the conversion both ways.

/**
 * Splits a command line into argv on whitespace. Single and double quotes group text and are
 * removed; nothing else is special (no escapes, variables, globs or pipes). `unclosed` is true
 * when a quote is never closed.
 */
export function parseArgv(line: string): { argv: string[]; unclosed: boolean } {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) argv.push(current);
  return { argv, unclosed: quote !== null };
}

/** The command line `parseArgv` reads back as `argv`. */
export function formatArgv(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg !== "" && !/[\s'"]/.test(arg)) return arg;
      if (!arg.includes("'")) return `'${arg}'`;
      if (!arg.includes('"')) return `"${arg}"`;
      return arg
        .split("'")
        .map((part) => `'${part}'`)
        .join(`"'"`);
    })
    .join(" ");
}

export interface CheckRow {
  key: number;
  id: string;
  /** Not editable in the form; kept so that saving does not drop it. */
  title: string | undefined;
  command: string;
  cwd: string;
  timeoutSeconds: string;
  required: boolean;
  /** The stored check stated `required`, so it is sent even when it is the default. */
  requiredStated: boolean;
}
export interface EnvRow {
  key: number;
  name: string;
  value: string;
}
export interface ProfileForm {
  checks: CheckRow[];
  network: "deny" | "allow";
  env: EnvRow[];
  pathPrepend: string;
  writableRoots: string;
  networkAccess: boolean;
  timeoutMinutes: string;
  /** The stored profile stated these, so they are sent even when they are the default. */
  networkStated: boolean;
  networkAccessStated: boolean;
}

let nextKey = 1;
export const newCheckRow = (): CheckRow => ({
  key: nextKey++,
  id: "",
  title: undefined,
  command: "",
  cwd: "",
  timeoutSeconds: "",
  required: true,
  requiredStated: false,
});
export const newEnvRow = (): EnvRow => ({ key: nextKey++, name: "", value: "" });

export function toForm(p: ExecutionProfile): ProfileForm {
  return {
    checks: (p.checks ?? []).map((c) => ({
      key: nextKey++,
      id: c.id,
      title: c.title,
      command: formatArgv(c.command),
      cwd: c.cwd ?? "",
      timeoutSeconds: c.timeoutSeconds === undefined ? "" : String(c.timeoutSeconds),
      required: c.required ?? true,
      requiredStated: c.required !== undefined,
    })),
    network: p.network ?? "deny",
    env: Object.entries(p.env ?? {}).map(([name, value]) => ({ key: nextKey++, name, value })),
    pathPrepend: (p.pathPrepend ?? []).join("\n"),
    writableRoots: (p.codexSandbox?.writableRoots ?? []).join("\n"),
    networkAccess: p.codexSandbox?.networkAccess ?? false,
    timeoutMinutes:
      p.verificationTimeoutMs === undefined ? "" : String(p.verificationTimeoutMs / 60_000),
    networkStated: p.network !== undefined,
    networkAccessStated: p.codexSandbox?.networkAccess !== undefined,
  };
}

export const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/**
 * The profile to send. Parts left empty are omitted; a default (`deny`, required, no network
 * access) is omitted too unless the stored profile stated it.
 */
export function toProfile(f: ProfileForm): ExecutionProfile {
  const checks = f.checks.map((row): ProfileCheck => {
    const cwd = row.cwd.trim();
    const timeout = row.timeoutSeconds.trim();
    return {
      id: row.id.trim(),
      ...(row.title !== undefined ? { title: row.title } : {}),
      command: parseArgv(row.command).argv,
      ...(cwd ? { cwd } : {}),
      ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
      ...(!row.required || row.requiredStated ? { required: row.required } : {}),
    };
  });
  const env = f.env.filter((e) => e.name.trim() !== "");
  const pathPrepend = lines(f.pathPrepend);
  const writableRoots = lines(f.writableRoots);
  const codexSandbox = {
    ...(writableRoots.length > 0 ? { writableRoots } : {}),
    ...(f.networkAccess || f.networkAccessStated ? { networkAccess: f.networkAccess } : {}),
  };
  const minutes = f.timeoutMinutes.trim();
  return {
    ...(checks.length > 0 ? { checks } : {}),
    ...(f.network === "allow" || f.networkStated ? { network: f.network } : {}),
    ...(env.length > 0
      ? { env: Object.fromEntries(env.map((e) => [e.name.trim(), e.value])) }
      : {}),
    ...(pathPrepend.length > 0 ? { pathPrepend } : {}),
    ...(Object.keys(codexSandbox).length > 0 ? { codexSandbox } : {}),
    ...(minutes ? { verificationTimeoutMs: Math.round(Number(minutes) * 60_000) } : {}),
  };
}

export interface ProfileProblems {
  /** By row key. */
  checks: Record<number, { id?: string; command?: string; cwd?: string; timeout?: string }>;
  env: Record<number, string>;
  pathPrepend?: string;
  writableRoots?: string;
  timeoutMinutes?: string;
  count: number;
}

const notAbsolute = (text: string) => lines(text).filter((l) => !l.startsWith("/"));

/** Only the obvious mistakes; the server decides what is valid. */
export function problemsOf(f: ProfileForm): ProfileProblems {
  const out: ProfileProblems = { checks: {}, env: {}, count: 0 };
  for (const row of f.checks) {
    const p: ProfileProblems["checks"][number] = {};
    if (!row.id.trim()) p.id = "Give the check an id.";
    const { argv, unclosed } = parseArgv(row.command);
    if (unclosed) p.command = "A quote is not closed.";
    else if (argv.length === 0) p.command = "Enter the command to run.";
    if (row.cwd.trim().startsWith("/"))
      p.cwd = "Use a path relative to the repository root, not an absolute one.";
    const t = row.timeoutSeconds.trim();
    if (t && !(Number.isInteger(Number(t)) && Number(t) > 0))
      p.timeout = "Enter a whole number of seconds.";
    const n = Object.keys(p).length;
    if (n > 0) {
      out.checks[row.key] = p;
      out.count += n;
    }
  }
  for (const row of f.env)
    if (!row.name.trim() && row.value !== "") {
      out.env[row.key] = "Give the variable a name.";
      out.count += 1;
    }
  const describe = (bad: string[]) => `Not an absolute path: ${bad.join(", ")}`;
  const badPath = notAbsolute(f.pathPrepend);
  if (badPath.length > 0) {
    out.pathPrepend = describe(badPath);
    out.count += 1;
  }
  const badRoots = notAbsolute(f.writableRoots);
  if (badRoots.length > 0) {
    out.writableRoots = describe(badRoots);
    out.count += 1;
  }
  const m = f.timeoutMinutes.trim();
  if (m && !(Number.isFinite(Number(m)) && Number(m) > 0)) {
    out.timeoutMinutes = "Enter a number of minutes greater than zero.";
    out.count += 1;
  }
  return out;
}
