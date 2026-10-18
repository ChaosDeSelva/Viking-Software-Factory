/**
 * Variables inherited by every check (explicit list; ADR-004). `NODE_OPTIONS`
 * is deliberately absent: it can inject code into every Node process.
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "CI",
] as const;

const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|AUTH|SESSION|COOKIE|(^|_)PAT$|_KEY$|(^|_)DSN$)/i;

/** Variables that make interpreters or the loader run extra code: never passed to checks. */
const INJECTION_NAME =
  /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|GIT_.*|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/;

/** Names that look like credentials are never passed to checks, even when a harness asks. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Loader/interpreter injection variables (audit M1). */
export function isInjectionEnvName(name: string): boolean {
  return INJECTION_NAME.test(name);
}

/**
 * Build a check environment from the caller's: allowlist plus the harness's
 * requested `env` keys, minus anything that looks like a secret.
 */
export function buildCheckEnv(
  base: Readonly<Record<string, string | undefined>>,
  extraKeys: readonly string[] = [],
): { env: Record<string, string>; refused: string[] } {
  const env: Record<string, string> = {};
  const refused: string[] = [];
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of extraKeys) {
    if (isSecretEnvName(key) || isInjectionEnvName(key)) {
      refused.push(key);
      continue;
    }
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { env, refused };
}

/** Values of secret-looking variables in the caller env, so they can be redacted from output. */
export function secretEnvValues(base: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(base)
    .filter(
      ([k, v]) =>
        v !== undefined &&
        v.length >= 8 &&
        // credential-named variables, and any URL carrying user:password@
        (isSecretEnvName(k) || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)),
    )
    .map(([, v]) => v as string);
}
