/**
 * Credential locations that agents must never read or exfiltrate without approval (audit H1,
 * M2). This module is the shared source of truth: the policy classifier's secret-path list
 * imports `sensitivePathPatterns` / `SENSITIVE_PATH_PATTERNS` and appends them to its own.
 *
 * Pure (no `node:` imports) so it is safe in the browser bundle; callers pass `home` and the
 * configured data dir. Patterns are matched against lower-cased text, like the policy's list.
 */

/** Home-relative entries (a directory covers everything below it). */
export const SENSITIVE_HOME_ENTRIES: readonly string[] = [
  ".mimir", // Mimir data dir: operator token, event store
  ".claude", // Claude Code credentials and settings
  ".claude.json",
  ".config/herdr", // HerdR config
  ".codex",
  ".config/anthropic",
  ".azure",
  "library/keychains",
];

/** Absolute locations that hold credentials on any host. */
const ABSOLUTE_PATTERNS: readonly RegExp[] = [/^\/proc\/(?:self|\d+)\/environ$/];

const escape = (s: string) => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, "") : s);

/** `<prefix>/<entry>` or anything below it. */
const under = (prefix: string, entry: string) => new RegExp(`^${prefix}/${escape(entry)}(?:/|$)`);

export interface SensitivePathOptions {
  /** The operator's home directory (absolute), so `/Users/me/.mimir/...` matches too. */
  home?: string;
  /** A non-default `MIMIR_DATA_DIR`; everything below it is sensitive. */
  dataDir?: string;
}

/** Home-directory spellings matched without knowing the user's home (macOS, Linux, root). */
const GENERIC_HOME_PREFIXES = ["~", "/users/[^/]+", "/home/[^/]+", "/root"];

/** Patterns for `~/…` and common home spellings, the given home, and the data dir. */
export function sensitivePathPatterns(opts: SensitivePathOptions = {}): RegExp[] {
  const prefixes = [...GENERIC_HOME_PREFIXES];
  if (opts.home !== undefined && opts.home.startsWith("/")) {
    prefixes.push(escape(trimSlash(opts.home)));
  }
  const out: RegExp[] = [];
  for (const prefix of prefixes) {
    for (const entry of SENSITIVE_HOME_ENTRIES) out.push(under(prefix, entry));
  }
  if (opts.dataDir !== undefined && opts.dataDir.startsWith("/")) {
    out.push(new RegExp(`^${escape(trimSlash(opts.dataDir))}(?:/|$)`));
  }
  out.push(...ABSOLUTE_PATTERNS);
  return out;
}

/** Static patterns (generic home spellings and `/proc`); `sensitivePathPatterns` adds a data dir. */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = sensitivePathPatterns();

/** True when `text` (a path, `@path`, or `--opt=path`) names a sensitive location. */
export function isSensitivePath(text: string, opts: SensitivePathOptions = {}): boolean {
  const lower = text.toLowerCase();
  const candidates = new Set([lower]);
  if (lower.startsWith("@")) candidates.add(lower.slice(1));
  const eq = lower.lastIndexOf("=");
  if (eq >= 0) candidates.add(lower.slice(eq + 1).replace(/^@/, ""));
  const patterns = sensitivePathPatterns(opts);
  for (const c of candidates) {
    const t = trimSlash(c);
    if (patterns.some((re) => re.test(t))) return true;
  }
  return false;
}
