/**
 * High-confidence secret detection for indexed text (audit M7). Every pattern is anchored on a
 * literal prefix and uses only bounded quantifiers, so a full scan of each line is linear in its
 * length. Lines are never truncated (review Ssec I2: a key after 16K characters on a minified
 * line was missed). Prefixes are guarded with `(?<![A-Za-z0-9])` rather than `\b`, so tokens
 * glued to `_` (`MY_AWS_KEY_AKIA...`) are still found (review m2).
 */

export interface SecretPattern {
  id: string;
  pattern: RegExp;
}

const NB = "(?<![A-Za-z0-9])";
const re = (src: string, flags = "") => new RegExp(src, flags);

export const SECRET_CONTENT_PATTERNS: readonly SecretPattern[] = [
  { id: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{16}/ },
  { id: "openai", pattern: re(`${NB}sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20}`) },
  { id: "stripe", pattern: re(`${NB}[rs]k_live_[A-Za-z0-9]{10}`) },
  { id: "aws-access-key", pattern: re(`${NB}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`) },
  { id: "github-token", pattern: re(`${NB}gh[pousr]_[A-Za-z0-9]{30}`) },
  { id: "github-pat", pattern: re(`${NB}github_pat_[A-Za-z0-9_]{22}`) },
  { id: "slack", pattern: re(`${NB}xox[abprs]-[A-Za-z0-9-]{10}`) },
  { id: "linear", pattern: re(`${NB}lin_api_[A-Za-z0-9]{20}`) },
  { id: "atlassian", pattern: re(`${NB}ATATT[A-Za-z0-9_=-]{20}`) },
  { id: "google-api-key", pattern: re(`${NB}AIza[0-9A-Za-z_-]{35}`) },
  {
    id: "credential-url",
    pattern: /[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,256}:[^\s@]{8,256}@/i,
  },
  { id: "private-key", pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/ },
  {
    id: "jwt",
    pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8}/,
  },
];

/** `secret = "value"` style assignments; the value must mix letters and digits. */
const GENERIC_ASSIGNMENT =
  /(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]{0,24}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?([A-Za-z0-9_+/=-]{16,256})/gi;

function genericMatch(line: string): boolean {
  GENERIC_ASSIGNMENT.lastIndex = 0;
  for (const m of line.matchAll(GENERIC_ASSIGNMENT)) {
    const v = m[1] ?? "";
    if (/[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true;
  }
  return false;
}

function lineHasSecret(line: string): boolean {
  for (const p of SECRET_CONTENT_PATTERNS) if (p.pattern.test(line)) return true;
  return genericMatch(line);
}

/** True if any line of `text` looks like it contains a credential. */
export function containsSecret(text: string): boolean {
  for (const line of text.split("\n")) if (lineHasSecret(line)) return true;
  return false;
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY/;

/**
 * 1-based inclusive line ranges of `text` that hold secrets. A PEM private-key block counts
 * from its BEGIN line through its END line (or the end of the text when unterminated), so the
 * base64 body is covered even when it falls in a different chunk from the header.
 */
export function secretLineRanges(text: string): { start: number; end: number }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: { start: number; end: number }[] = [];
  let pemStart = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (pemStart) {
      if (PEM_END.test(line)) {
        out.push({ start: pemStart, end: n });
        pemStart = 0;
      }
      return;
    }
    if (PEM_BEGIN.test(line)) {
      // Review m3: a PEM that also ends on this line (escaped "\n" in JSON) covers only it.
      if (PEM_END.test(line)) out.push({ start: n, end: n });
      else pemStart = n;
      return;
    }
    if (lineHasSecret(line)) out.push({ start: n, end: n });
  });
  if (pemStart) out.push({ start: pemStart, end: lines.length });
  return out;
}

/** What a redacted secret is replaced with. */
export const SECRET_REDACTED = "[secret redacted]";

/** Characters that continue a token after a pattern's fixed-length prefix. */
const TOKEN_TAIL = "[A-Za-z0-9_+/=.-]*";
const REDACT_PATTERNS: readonly RegExp[] = SECRET_CONTENT_PATTERNS.filter(
  (p) => p.id !== "private-key",
).map((p) => new RegExp(p.pattern.source + TOKEN_TAIL, "gi"));
/** `Authorization: Bearer <token>` (redaction only; review m5). */
const BEARER = /(?<![A-Za-z0-9])bearer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/gi;
/** Invisible and format characters that can split a token (zero-width, bidi, tags). */
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const GENERIC_REDACT = new RegExp(`${GENERIC_ASSIGNMENT.source}(${TOKEN_TAIL})`, "gi");

function redactLine(line: string): { text: string; count: number } {
  let count = 0;
  let text = line;
  for (const re of [...REDACT_PATTERNS, BEARER]) {
    text = text.replace(re, () => {
      count++;
      return SECRET_REDACTED;
    });
  }
  text = text.replace(GENERIC_REDACT, (m: string, value: string, tail: string) => {
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return m;
    count++;
    return m.slice(0, m.length - value.length - tail.length) + SECRET_REDACTED;
  });
  return { text, count };
}

/**
 * Replace secret material in `text` with {@link SECRET_REDACTED} (same patterns as
 * {@link containsSecret}). A whole token is replaced, not only the matched prefix; a PEM
 * private-key block (BEGIN through END, or to the end of the text) becomes one marker line.
 * `count` is the number of replacements. Used for ticket text before it enters a prompt.
 *
 * Matching runs on an NFKC-normalized copy without invisible characters, and is
 * case-insensitive, so fullwidth, zero-width-split and upper-cased tokens are caught too
 * (review m5). When something is redacted, the normalized text is returned; otherwise the input
 * is returned unchanged. Tokens split across lines, URL- or base64-encoded tokens are not caught.
 */
export function redactSecrets(input: string): { text: string; count: number } {
  const text = input.normalize("NFKC").replace(INVISIBLE, "");
  const lines = text.split("\n");
  const out: string[] = [];
  let count = 0;
  let inPem = false;
  for (const line of lines) {
    if (inPem) {
      if (PEM_END.test(line)) inPem = false;
      continue;
    }
    if (PEM_BEGIN.test(line)) {
      count++;
      out.push(SECRET_REDACTED);
      inPem = !PEM_END.test(line);
      continue;
    }
    const r = redactLine(line);
    count += r.count;
    out.push(r.text);
  }
  return { text: count === 0 ? input : out.join("\n"), count };
}
