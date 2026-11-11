import { detectInjection, normalizeUntrusted, redactInjections } from "@sindri/director";
import { redactSecrets } from "@sindri/knowledge";
import type { FgLesson } from "./types.js";

export const MAX_TITLE_CHARS = 200;
export const MAX_RULE_CHARS = 2000;
export const MAX_APPLIES_WHEN_CHARS = 1000;
export const MAX_PATHS = 50;
export const MAX_PATH_CHARS = 300;
/** At most this many lessons are kept from one response, whatever it holds. */
export const MAX_LESSONS = 200;

/** Lesson ids become citation ids (`fg:<id>`) and prompt attributes: a conservative charset. */
const LESSON_ID = /^[\w.:@-]{1,200}$/;

// eslint-disable-next-line no-control-regex -- strips control characters except tab and newline
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Feedback Graph text is untrusted prompt input, like ticket text: invisible and control
 * characters removed, secrets and injection attempts redacted, length capped.
 */
function clean(text: string, max: number): { text: string; injection: boolean } {
  const plain = normalizeUntrusted(text).replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  const noSecrets = redactSecrets(plain).text;
  const injection = detectInjection(noSecrets).detected;
  return { text: cut(injection ? redactInjections(noSecrets) : noSecrets, max), injection };
}

/**
 * One lesson from `GET /api/lessons`, or null when it has no usable id or rule. Its own
 * `title`/`rule`/`appliesWhen`/`paths` win; `proposedAs` (the post-mortem's wording) fills gaps.
 */
export function normalizeLesson(raw: unknown): FgLesson | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const p =
    r["proposedAs"] && typeof r["proposedAs"] === "object" && !Array.isArray(r["proposedAs"])
      ? (r["proposedAs"] as Record<string, unknown>)
      : {};
  const id = str(r["id"])?.trim();
  if (!id || !LESSON_ID.test(id)) return null;
  const pick = (k: string) => (str(r[k])?.trim() || str(p[k])?.trim()) ?? "";
  const rule = clean(pick("rule"), MAX_RULE_CHARS);
  if (!rule.text) return null;
  const titleRaw = pick("title");
  const title = clean(titleRaw || rule.text.split("\n")[0]!, MAX_TITLE_CHARS);
  const when = clean(pick("appliesWhen"), MAX_APPLIES_WHEN_CHARS);
  const rawPaths = Array.isArray(r["paths"]) ? r["paths"] : Array.isArray(p["paths"]) ? p["paths"] : [];
  let pathInjection = false;
  const paths = rawPaths
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .slice(0, MAX_PATHS)
    .map((x) => {
      const c = clean(x, MAX_PATH_CHARS);
      pathInjection ||= c.injection;
      return c.text;
    })
    .filter(Boolean);
  // The request asked for approved lessons only: a lesson without a status is taken as one.
  const status = (str(r["status"])?.trim() || "approved").slice(0, 40);
  return {
    id,
    title: title.text || cut(rule.text, MAX_TITLE_CHARS),
    rule: rule.text,
    appliesWhen: when.text || null,
    paths,
    status,
    injectionDetected: rule.injection || title.injection || when.injection || pathInjection,
  };
}

/**
 * The approved lessons of a `GET /api/lessons` body (a JSON array), newest decision first;
 * null when the body is not an array. Malformed entries are skipped, duplicates dropped.
 */
export function normalizeLessons(body: unknown): FgLesson[] | null {
  if (!Array.isArray(body)) return null;
  const decided = (x: unknown) => {
    const v = x && typeof x === "object" ? (x as Record<string, unknown>)["decidedAt"] : null;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = body
    .map((x, i) => ({ x, i, t: decided(x) }))
    .sort((a, b) => b.t - a.t || a.i - b.i);
  const out: FgLesson[] = [];
  const seen = new Set<string>();
  for (const { x } of ordered) {
    const l = normalizeLesson(x);
    if (!l || l.status !== "approved" || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}
