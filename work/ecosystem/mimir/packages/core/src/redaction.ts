export interface RedactionResult {
  text: string;
  redacted: boolean;
  hits: number;
}

/** Transforms an event payload before it is persisted. */
export type PayloadRedactor = (payload: unknown) => unknown;

const MARKER_PREFIX = "[REDACTED:";
const marker = (kind: string) => `${MARKER_PREFIX}${kind}]`;

/**
 * Applied to a key name normalised by `normaliseKey` (camelCase split to snake_case, lower-case).
 * The credential word must be the *last* part of the name, so `access_token`, `client_secret`,
 * `AWS_SECRET_ACCESS_KEY` and `X-Auth` match while `max_tokens`, `cookie_domain`, `secret_name`,
 * `author` and `session_id` do not.
 */
export const SENSITIVE_KEY_PATTERN =
  /(?:^|[_.\- ])(?:password|passwd|passphrase|secrets?|token|pwd|pass|dsn|auth|authorization|cookies?|credentials?|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|secret[_-]?key|auth[_-]?key)$/;

/** `accessToken` → `access_token`, `X-Auth` → `x-auth`. */
export function normaliseKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Whether string values under this object key are masked wholesale (`[REDACTED:key]`).
 * Numbers and booleans are kept, so usage counts such as `tokens: 1234` survive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(normaliseKey(key));
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** A literal every match must contain; skip costly scans when it is absent. */
  requiredLiteral?: string;
  /**
   * Builds the replacement from the match and its capture groups, or returns `undefined` to
   * leave the match alone (e.g. it is already a marker).
   */
  replace: (match: string, groups: string[]) => string | undefined;
}

const whole =
  (kind: string) =>
  (match: string): string | undefined =>
    match.startsWith(MARKER_PREFIX) ? undefined : marker(kind);

/** Values that are clearly not secrets: numbers, booleans, null, bare punctuation. */
const NOT_A_SECRET =
  /^["']?(?:-?\d+(?:\.\d+)?|true|false|null|undefined|none|[^A-Za-z0-9]*)["']?[,;]?$/i;

/** `key<sep>value` replacement keeping quotes; `undefined` for markers and non-secret values. */
const assignment =
  (kind: string) =>
  (_m: string, [key = "", sep = "", value = ""]: string[]): string | undefined => {
    if (value.includes(MARKER_PREFIX) || NOT_A_SECRET.test(value)) return undefined;
    const q = value[0];
    const quoted = (q === '"' || q === "'") && value.length >= 2 && value.endsWith(q);
    return key + sep + (quoted ? `${q}${marker(kind)}${q}` : marker(kind));
  };

/** A value after `=`/`:`: a quoted string, or a run of non-space characters. */
const VALUE = `("[^"]*"|'[^']*'|\\S+)`;
const SEP = `(["']?\\s*[:=]\\s*)`;

// Order matters: specific shapes first so the generic key=value rules see markers, not secrets.
const BUILTIN_RULES: readonly Rule[] = [
  {
    // PEM / OpenSSH / PGP private keys. A capture cut off before its END line (truncated
    // terminal output) is masked to the end of the text.
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole("private_key"),
  },
  {
    // Credentials in URL userinfo (`scheme://user:pass@host`): keep the shape, mask the password.
    kind: "url_credentials",
    requiredLiteral: "://",
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{0,256}:)([^/\s@]{1,512})(@)/gi,
    replace: (_m, [prefix = "", secret = "", at = ""]) =>
      secret.startsWith(MARKER_PREFIX) ? undefined : prefix + marker("url_credentials") + at,
  },
  {
    // Percent-encoded colon in userinfo (`https://user%3Apass@host`): mask the whole userinfo.
    kind: "url_credentials",
    requiredLiteral: "://",
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s:@]{0,256}%3[aA][^/\s@]{1,512})(@)/gi,
    replace: (_m, [prefix = "", secret = "", at = ""]) =>
      secret.startsWith(MARKER_PREFIX) ? undefined : prefix + marker("url_credentials") + at,
  },
  {
    // Scheme-less userinfo with an encoded colon (`user%3Apass@host`).
    kind: "url_credentials",
    requiredLiteral: "%3",
    pattern:
      /(?<=^|[\s"'=(<,;])([^\s/?#@:"'=(<,;%]{0,256}%3[aA][^\s/?#@"']{1,512})(@)(?=[A-Za-z0-9[])/g,
    replace: (_m, [secret = "", at = ""]) =>
      secret.startsWith(MARKER_PREFIX) ? undefined : marker("url_credentials") + at,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: whole("jwt"),
  },
  {
    // `Bearer <token>`. Inside an `Authorization:` header any token is masked; elsewhere only a
    // token-like continuation (20+ non-space chars with a digit), so "Deploy Bearer Service"
    // and "the Bearer of bad news" stay readable.
    kind: "bearer",
    pattern: /(\bauthorization["']?\s*[:=]\s*["']?)?\b(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi,
    replace: (_m, [header = "", prefix = "", secret = ""]) => {
      if (secret.startsWith(MARKER_PREFIX)) return undefined;
      const tokenLike = secret.length >= 20 && /\d/.test(secret);
      return header !== "" || tokenLike ? header + prefix + marker("bearer") : undefined;
    },
  },
  {
    // AWS access key ids: long-term (AKIA), temporary (ASIA) and other principal prefixes.
    kind: "aws_key",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
    replace: whole("aws_key"),
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: whole("github_token"),
  },
  { kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: whole("gitlab_token") },
  {
    kind: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: whole("slack_token"),
  },
  {
    kind: "google_key",
    pattern: /\b(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})/g,
    replace: whole("google_key"),
  },
  { kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: whole("npm_token") },
  {
    kind: "stripe_key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g,
    replace: whole("stripe_key"),
  },
  { kind: "hf_token", pattern: /\bhf_[A-Za-z0-9]{30,}/g, replace: whole("hf_token") },
  {
    // OpenAI/Anthropic-style keys: a vendor shape (`sk-ant-…`, `sk-proj-…`, `sk-svcacct-…`,
    // `sk-admin-…`) or `sk-` plus 20+ unbroken alphanumerics with a digit. Not `sk-learn-…`.
    kind: "api_key",
    pattern:
      /\bsk-(?:(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{16,}|(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{20,})/g,
    replace: whole("api_key"),
  },
  {
    // Header-style `Authorization: <scheme> <credentials>` (Basic, Digest, ...): mask to end of line.
    kind: "authorization",
    pattern: /\b(authorization["']?\s*[:=]\s*["']?)([^"'\r\n]+)/gi,
    replace: (_m, [prefix = "", value = ""]) =>
      value.includes(MARKER_PREFIX) ? undefined : prefix + marker("authorization"),
  },
  {
    // `Cookie:` / `Set-Cookie:` headers carry session credentials: mask to end of line.
    kind: "cookie",
    pattern: /\b((?:set-)?cookie["']?\s*:\s*["']?)([^"'\r\n]+)/gi,
    replace: (_m, [prefix = "", value = ""]) =>
      value.includes(MARKER_PREFIX) ? undefined : prefix + marker("cookie"),
  },
  {
    // A key name *ending* in a credential word, so env dumps such as `AWS_SECRET_ACCESS_KEY=`,
    // `client_secret:`, `db_password=`, `AccountKey=` match (the prefix is left in place).
    // Tolerates JSON quoting. Numeric/boolean values are kept (`max_tokens=4096`).
    kind: "secret",
    pattern: new RegExp(
      `(password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|credentials?)${SEP}${VALUE}`,
      "gi",
    ),
    replace: assignment("secret"),
  },
  {
    // Upper-case env names ending in a credential suffix (`OPENAI_KEY`, `DB_PASS`, `SENTRY_DSN`).
    // Only values that look generated (8+ chars with a digit, or 16+ chars) to spare `SORT_KEY=name`.
    kind: "secret",
    pattern: new RegExp(
      `\\b([A-Z][A-Z0-9_]{0,63}_(?:KEY|PASS|PWD|DSN|AUTH|CREDENTIALS?))${SEP}${VALUE}`,
      "g",
    ),
    replace: (m, groups) => {
      const value = (groups[2] ?? "").replace(/^["']|["']$/g, "");
      const generated = (value.length >= 8 && /\d/.test(value)) || value.length >= 16;
      return generated ? assignment("secret")(m, groups) : undefined;
    },
  },
];

function applyRule(text: string, rule: Rule): { text: string; hits: number } {
  if (rule.requiredLiteral !== undefined && !text.includes(rule.requiredLiteral)) {
    return { text, hits: 0 };
  }
  let hits = 0;
  rule.pattern.lastIndex = 0;
  const out = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
    // `rest` is [...captures, offset, input, groups?]; captures end at the numeric offset.
    const offsetIndex = rest.findIndex((g) => typeof g === "number");
    const captures = rest.slice(0, offsetIndex).map((g) => (typeof g === "string" ? g : ""));
    const replacement = rule.replace(match, captures);
    if (replacement === undefined) return match;
    hits++;
    return replacement;
  });
  return { text: out, hits };
}

function toGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/** Masks well-known secret shapes in `text` with `[REDACTED:<kind>]`. Extra patterns use kind `custom`. */
export function redact(text: string, extraPatterns: RegExp[] = []): RedactionResult {
  const rules: Rule[] = [
    ...BUILTIN_RULES,
    ...extraPatterns.map((p) => ({
      kind: "custom",
      pattern: toGlobal(p),
      replace: whole("custom"),
    })),
  ];
  let current = text;
  let hits = 0;
  for (const rule of rules) {
    const r = applyRule(current, rule);
    current = r.text;
    hits += r.hits;
  }
  return { text: current, redacted: hits > 0, hits };
}

function walk(value: unknown, extra: RegExp[], underSensitiveKey: boolean): unknown {
  if (typeof value === "string") {
    return underSensitiveKey ? marker("key") : redact(value, extra).text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, extra, underSensitiveKey));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      let key = redact(k, extra).text;
      if (key !== k && key in out) {
        let n = 2;
        while (`${key}#${n}` in out) n++;
        key = `${key}#${n}`;
      }
      out[key] = walk(v, extra, underSensitiveKey || isSensitiveKey(k));
    }
    return out;
  }
  return value;
}

/**
 * Returns a redacted deep copy of `value`, normalised through JSON first (so Dates and
 * `toJSON` objects keep their serialised form). Every string leaf goes through `redact`;
 * strings under a key for which `isSensitiveKey` holds become `[REDACTED:key]`; object keys
 * are themselves redacted.
 */
export function redactPayload(value: unknown, extraPatterns: RegExp[] = []): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return walk(JSON.parse(json) as unknown, extraPatterns, false);
}

/** Value shapes that are credentials regardless of the key they sit under. */
export type CredentialShape =
  "private_key" | "jwt" | "bearer" | "aws_key" | "github_token" | "api_key" | "url_userinfo";

// Stricter than the redaction rules on purpose: these reject operator input, so ordinary words
// ("Deploy Bearer Service", "sk-learn-experiments-v2") must not match. No key-name rule.
const CREDENTIAL_SHAPES: readonly [CredentialShape, RegExp][] = [
  ["private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/],
  ["bearer", /\bbearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/i],
  ["aws_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})/],
  // sk- keys are high-entropy: mixed case and digits, at least 20 characters.
  [
    "api_key",
    /\bsk-(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{20,}/,
  ],
  // scheme://[user]:password@host: a password in URL userinfo (a bare `user@` is not a secret;
  // the user may be empty, `redis://:secret@h`). Matched after percent-decoding (see below).
  ["url_userinfo", /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/?#@:]{0,256}:[^\s/?#@]{1,512}@/],
];

/** Scheme-less userinfo whose colon is percent-encoded (`user%3Apass@host`), checked raw. */
const ENCODED_BARE_USERINFO =
  /(?:^|[\s"'=(<,;])[^\s/?#@:"'=(<,;%]{0,256}%3[aA][^\s/?#@"']{1,512}@[A-Za-z0-9[]/;

/** Decodes `%XX` escapes that form valid UTF-8; leaves anything undecodable as is. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/**
 * The credential shapes found in `text` (each kind once, in rule order). Value shapes only:
 * AWS access key ids, GitHub tokens, sk- API keys, JWTs, bearer tokens, private-key blocks and
 * passwords in URL userinfo (`scheme://user:pass@host`).
 * Use it to refuse operator-supplied text that should never hold a secret, rather than
 * rewriting it.
 */
export function findCredentialShapes(text: string): CredentialShape[] {
  const decoded = percentDecode(text);
  return CREDENTIAL_SHAPES.filter(([kind, re]) => {
    if (re.test(text)) return true;
    if (kind !== "url_userinfo") return false;
    return re.test(decoded) || ENCODED_BARE_USERINFO.test(text);
  }).map(([kind]) => kind);
}
