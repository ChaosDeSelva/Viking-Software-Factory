import { readFile } from "node:fs/promises";

export interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * Credential formats Brokkr refuses to let into evidence or generated bundles
 * (spec §16.4). Detection is heuristic; redaction is a safety net, not a
 * guarantee against a malicious command (ADR-006).
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private-key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "github-token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  { name: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { name: "slack-token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", regex: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: "generic-secret",
    regex:
      /\b(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token|access[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{16,}/gi,
  },
];

export interface SecretFinding {
  pattern: string;
  index: number;
}

function knownValuePatterns(values: readonly string[]): SecretPattern[] {
  return values
    .filter((v) => v.length >= 8)
    .map((v) => ({
      name: "env-value",
      regex: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    }));
}

/**
 * Find secrets in `text`. `knownValues` are literal secret values (e.g. from the
 * caller's env). Patterns are applied in order on progressively redacted text,
 * so overlapping formats are counted once.
 */
export function scanText(text: string, knownValues: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let current = text;
  for (const { name, regex } of [...SECRET_PATTERNS, ...knownValuePatterns(knownValues)]) {
    current = current.replace(new RegExp(regex.source, regex.flags), (...args: unknown[]) => {
      findings.push({ pattern: name, index: args[args.length - 2] as number });
      return `[REDACTED:${name}]`;
    });
  }
  return findings;
}

/** Replace every secret with `[REDACTED:<pattern>]`. */
export function redactText(
  text: string,
  knownValues: readonly string[] = [],
): { text: string; findings: number } {
  let findings = 0;
  let out = text;
  for (const { name, regex } of [...SECRET_PATTERNS, ...knownValuePatterns(knownValues)]) {
    out = out.replace(new RegExp(regex.source, regex.flags), () => {
      findings++;
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, findings };
}

export interface LineRedactor {
  /** Feed a chunk; returns the redacted text of every completed line. */
  write(chunk: string): string;
  /** Redact and return whatever is still buffered. */
  flush(): string;
  /** Number of secrets redacted so far. */
  readonly findings: number;
}

/**
 * Streaming redactor that works line by line so a secret split across output
 * chunks is still caught. Lines longer than `maxLineBytes` are flushed in
 * pieces to keep memory bounded.
 */
export function createLineRedactor(
  options: { knownValues?: readonly string[]; maxLineBytes?: number } = {},
): LineRedactor {
  const known = options.knownValues ?? [];
  const max = options.maxLineBytes ?? 64 * 1024;
  let buffer = "";
  let findings = 0;
  const redact = (s: string): string => {
    const r = redactText(s, known);
    findings += r.findings;
    return r.text;
  };
  return {
    write(chunk: string): string {
      buffer += chunk;
      let out = "";
      const nl = buffer.lastIndexOf("\n");
      if (nl >= 0) {
        out += redact(buffer.slice(0, nl + 1));
        buffer = buffer.slice(nl + 1);
      }
      while (buffer.length > max) {
        out += redact(buffer.slice(0, max));
        buffer = buffer.slice(max);
      }
      return out;
    },
    flush(): string {
      const out = buffer.length > 0 ? redact(buffer) : "";
      buffer = "";
      return out;
    },
    get findings() {
      return findings;
    },
  };
}

/** Scan files (e.g. a generated instruction bundle); unreadable files are skipped. */
export async function scanFiles(
  files: readonly string[],
): Promise<Array<{ file: string; findings: number }>> {
  const result: Array<{ file: string; findings: number }> = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const findings = scanText(text).length;
    if (findings > 0) result.push({ file, findings });
  }
  return result;
}
