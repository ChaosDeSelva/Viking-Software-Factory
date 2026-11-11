// Pure conversion between Sindri's execution profile and the form that edits it. Sindri validates
// the saved profile; the checks here only report the same problems before the request is sent.
import { sameRepo } from "./workflowState.ts";
type R = Record<string, any>;

export type CheckRow = {
  id: string;
  title: string;
  command: string;
  cwd: string;
  timeoutSeconds: string;
  required: boolean;
};
export type ProfileForm = {
  checks: CheckRow[];
  network: "deny" | "allow";
  env: { name: string; value: string }[];
  pathPrepend: string;
  writableRoots: string;
  networkAccess: boolean;
  /** Whether the stored profile states networkAccess at all; an unchecked box then saves `false`. */
  networkAccessStated: boolean;
  verificationMinutes: string;
};

export const emptyCheck = (): CheckRow => ({
  id: "",
  title: "",
  command: "",
  cwd: "",
  timeoutSeconds: "",
  required: true,
});

/**
 * Splits a command line into its argv on whitespace. Single quotes keep everything literal; in
 * double quotes `\"` and `\\` are the only escapes. Nothing else is special: no variables,
 * globs, pipes or redirects, because the command is run directly and not by a shell.
 */
export function parseArgv(text: string): { argv: string[]; error?: string } {
  const argv: string[] = [];
  let current = "",
    started = false,
    quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (quote === '"' && c === "\\" && ['"', "\\"].includes(text[i + 1]))
        current += text[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (quote)
    return { argv, error: `The command has an unclosed ${quote} quote.` };
  if (started) argv.push(current);
  return { argv };
}

/** The command line that `parseArgv` reads back as exactly this argv. */
export function formatArgv(argv: string[]): string {
  return argv
    .map((arg) =>
      arg !== "" && !/[\s'"]/.test(arg)
        ? arg
        : !arg.includes("'")
          ? `'${arg}'`
          : `"${arg.replace(/[\\"]/g, "\\$&")}"`,
    )
    .join(" ");
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function profileToForm(profile: R | null | undefined): ProfileForm {
  const p = profile ?? {};
  return {
    checks: (p.checks ?? []).map((c: R) => ({
      id: c.id ?? "",
      title: c.title ?? "",
      command: formatArgv(c.command ?? []),
      cwd: c.cwd ?? "",
      timeoutSeconds: c.timeoutSeconds != null ? String(c.timeoutSeconds) : "",
      required: c.required !== false,
    })),
    network: p.network === "allow" ? "allow" : "deny",
    env: Object.entries(p.env ?? {}).map(([name, value]) => ({
      name,
      value: String(value),
    })),
    pathPrepend: (p.pathPrepend ?? []).join("\n"),
    writableRoots: (p.codexSandbox?.writableRoots ?? []).join("\n"),
    networkAccess: p.codexSandbox?.networkAccess === true,
    networkAccessStated: p.codexSandbox?.networkAccess !== undefined,
    verificationMinutes:
      p.verificationTimeoutMs != null
        ? String(p.verificationTimeoutMs / 60000)
        : "",
  };
}

const FORBIDDEN_ENV =
  /^(PATH|HOME|MIMIR_.*|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|GIT_.*|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/;

function directories(text: string, what: string, errors: string[]): string[] {
  const list = lines(text);
  for (const dir of list)
    if (
      !dir.startsWith("/") ||
      dir === "/" ||
      dir.includes(":") ||
      dir.split("/").includes("..")
    )
      errors.push(
        `${what}: "${dir}" must be an absolute directory other than /, without ':' or '..'.`,
      );
  if (list.length > 16) errors.push(`${what}: at most 16 directories.`);
  return list;
}

function staysInside(cwd: string): boolean {
  if (
    cwd.startsWith("/") ||
    cwd.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cwd)
  )
    return false;
  let depth = 0;
  for (const part of cwd.split("/")) {
    if (part === "..") depth--;
    else if (part && part !== ".") depth++;
    if (depth < 0) return false;
  }
  return true;
}

/**
 * The profile to save, holding only what the form sets (an untouched form gives `{}`), and what
 * Sindri would refuse about it. Defaults are left out: network `deny`, a required check.
 */
export function formToProfile(form: ProfileForm): {
  profile: R;
  errors: string[];
} {
  const errors: string[] = [];
  const profile: R = {};
  const seen = new Set<string>();
  const checks = form.checks.map((row, i) => {
    const name = row.id.trim() ? `Check "${row.id.trim()}"` : `Check ${i + 1}`;
    const id = row.id.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
      errors.push(
        `${name}: the ID needs lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`,
      );
    else if (seen.has(id))
      errors.push(`${name}: this ID is used by another check.`);
    seen.add(id);
    const { argv, error } = parseArgv(row.command);
    if (error) errors.push(`${name}: ${error}`);
    else if (!argv.length) errors.push(`${name}: enter the command to run.`);
    else if (argv.length > 64)
      errors.push(`${name}: a command has at most 64 parts.`);
    else if (argv.includes(""))
      errors.push(`${name}: the command has an empty quoted part.`);
    const cwd = row.cwd.trim();
    if (cwd && !staysInside(cwd))
      errors.push(
        `${name}: the working directory must be relative and stay inside the repository.`,
      );
    const timeout = row.timeoutSeconds.trim();
    if (
      timeout &&
      !(
        /^\d+$/.test(timeout) &&
        Number(timeout) >= 1 &&
        Number(timeout) <= 86400
      )
    )
      errors.push(
        `${name}: the timeout must be a whole number of seconds from 1 to 86400.`,
      );
    return {
      id,
      ...(row.title.trim() ? { title: row.title.trim() } : {}),
      command: argv,
      ...(cwd ? { cwd } : {}),
      ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
      ...(row.required ? {} : { required: false }),
    };
  });
  if (checks.length) {
    profile.checks = checks;
    if (checks.length > 20) errors.push("At most 20 checks.");
    if (!form.checks.some((row) => row.required))
      errors.push("At least one check must be required.");
  }
  if (form.network === "allow") profile.network = "allow";

  const env: Record<string, string> = {};
  for (const row of form.env) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
      errors.push(
        `Environment variable "${name}": names use letters, digits and '_' and do not start with a digit.`,
      );
    else if (FORBIDDEN_ENV.test(name))
      errors.push(`Environment variable ${name} cannot be set from a profile.`);
    else if (Object.hasOwn(env, name))
      errors.push(`Environment variable ${name} is listed twice.`);
    // Heimdall shows values that look like credentials as this text; saving it would store it.
    if (row.value.includes("[redacted]"))
      errors.push(
        `Environment variable ${name}: the value was hidden for display. Enter the real value again.`,
      );
    env[name] = row.value;
  }
  if (Object.keys(env).length) profile.env = env;
  if (Object.keys(env).length > 64)
    errors.push("At most 64 environment variables.");

  const pathPrepend = directories(form.pathPrepend, "PATH additions", errors);
  if (pathPrepend.length) profile.pathPrepend = pathPrepend;
  const writableRoots = directories(
    form.writableRoots,
    "Agent writable directories",
    errors,
  );
  const codexSandbox: R = {
    ...(writableRoots.length ? { writableRoots } : {}),
    ...(form.networkAccess || form.networkAccessStated
      ? { networkAccess: form.networkAccess }
      : {}),
  };
  if (Object.keys(codexSandbox).length) profile.codexSandbox = codexSandbox;

  const minutes = form.verificationMinutes.trim();
  if (minutes) {
    const ms = Math.round(Number(minutes) * 60000);
    if (!Number.isFinite(ms) || ms < 1000 || ms > 86_400_000)
      errors.push(
        "The verification timeout must be between 1 second (0.017 minutes) and 1440 minutes.",
      );
    else profile.verificationTimeoutMs = ms;
  }
  // Heimdall replaces anything that looks like a credential with this text before it reaches the
  // form, in any field. Saving would store the placeholder in place of the real command or path.
  if (
    JSON.stringify(profile).includes("[redacted]") &&
    !errors.some((e) => e.includes("hidden for display"))
  )
    errors.push(
      "Part of this profile was hidden for display and shows as [redacted]. Enter the real text again before saving.",
    );
  return { profile, errors };
}

/** The Sindri record of a project listed from either source, matched by ID or repository path. */
export function sindriProjectOf(project: R, sindri: R[]): R | undefined {
  return (
    sindri.find((sp) => sp.id === project.id) ??
    sindri.find((sp) => sameRepo(sp.repoPath, project.repoPath))
  );
}

/** Execution statuses after which Sindri does nothing more; a cancel is refused for these. */
export const FINAL_EXECUTION_STATUSES = [
  "verified_pending_review",
  "cancelled",
  "failed",
];
export const isFinalExecution = (status: unknown): boolean =>
  FINAL_EXECUTION_STATUSES.includes(String(status)) ||
  String(status).startsWith("delivered");

/**
 * The tasks of a Sindri execution view that still wait for an operator's escalation decision. A
 * finished run keeps the record on its tasks, but Sindri refuses to resolve it.
 */
export function openEscalations(view: R): R[] {
  if (isFinalExecution(view.execution?.status)) return [];
  return (view.tasks ?? []).filter((t: R) => t.escalation);
}

/** Why an escalation shown in the inspector cannot be resolved now; empty when it can. */
export function escalationBlock(
  view: R | undefined,
  planTaskId: string,
): string {
  // A run missing from the snapshot is left to Sindri to judge.
  if (!view) return "";
  const status = view.execution?.status;
  if (isFinalExecution(status))
    return `This run has ended (status is ${status}); its escalations can no longer be resolved.`;
  if (!openEscalations(view).some((t) => t.planTaskId === planTaskId))
    return "This escalation is no longer open.";
  return "";
}
