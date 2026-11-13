// Work kinds (change, research, PR review): labels, form validation and request bodies, and the
// lenient readers for research and PR review reports. Pure, so node --test covers it.
type R = Record<string, any>;

/** The work kinds this UI labels; checked against @factory/docs in a test. */
export const WORK_KINDS = ["change", "research", "pr_review"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
/** Decisions a research document can carry; checked against @factory/docs in a test. */
export const RESEARCH_DECISIONS = ["accepted", "rejected"] as const;
/** The PR review post states shown as a status (an unposted review reads "Not posted"). */
export const REVIEW_POST_STATES = ["posted"] as const;
export type BadgeTone =
  "neutral" | "accent" | "forest" | "info" | "warning" | "danger";

const LABELS: Record<
  WorkKind,
  { text: string; tone: BadgeTone; hint: string }
> = {
  change: {
    text: "Change",
    tone: "neutral",
    hint: "A code change delivered as a patch",
  },
  research: {
    text: "Research",
    tone: "info",
    hint: "A research document with cited sources",
  },
  pr_review: {
    text: "PR review",
    tone: "forest",
    hint: "A local review of a GitHub pull request",
  },
};

export const isWorkKind = (k: unknown): k is WorkKind =>
  typeof k === "string" && Object.hasOwn(LABELS, k);

/** Absent means a record from before work kinds (a change); an unknown kind reads "Other". */
export function kindBadge(kind: unknown): {
  text: string;
  tone: BadgeTone;
  hint: string;
} {
  const k = kind ?? "change";
  return isWorkKind(k)
    ? LABELS[k]
    : {
        text: "Other",
        tone: "neutral",
        hint: `A kind of work this version does not know (${String(k)})`,
      };
}

/**
 * An intake names its kind; a run or delivery takes it from its plan (`plan.work.kind`), found on
 * the execution view or by `planId` among the plans. Undefined when nothing says.
 */
export function kindOf(
  row: R | null | undefined,
  plans: R[] = [],
  executions: R[] = [],
): unknown {
  if (!row) return undefined;
  if (row.workKind != null) return row.workKind;
  if (row.work?.kind != null) return row.work.kind;
  if (row.plan?.work?.kind != null) return row.plan.work.kind;
  const id = row.executionId ?? row.execution?.id ?? row.id;
  const view = executions.find((e) => e.execution?.id === id);
  if (view?.plan?.work?.kind != null) return view.plan.work.kind;
  const planId = row.planId ?? row.execution?.planId ?? view?.execution?.planId;
  return plans.find((p) => p.id === planId)?.work?.kind;
}

/** Request notes limit in UTF-8 bytes (Sindri's MAX_REQUEST_NOTES_BYTES). */
export const REQUEST_NOTES_MAX_BYTES = 8 * 1024;
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
/** Sindri's limits on an intake: the trimmed title, and skills per request (MAX_REQUEST_SKILLS). */
export const QUESTION_MAX_CHARS = 500;
export const REQUEST_SKILLS_MAX = 20;
const tooManySkills = (ids: string[]) =>
  ids.length > REQUEST_SKILLS_MAX
    ? `Choose at most ${REQUEST_SKILLS_MAX} skills (${ids.length} selected).`
    : "";

/** `https://github.com/<owner>/<repo>/pull/<n>`, optionally with a trailing path, query or hash. */
export const PR_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:\/[\w/-]*)?(?:[?#]\S*)?$/;

/** Whether the project's lessons link is set (Sindri's `GET /v1/projects/:id/feedback-graph`). */
export const lessonsLinked = (fg: R | null | undefined): boolean =>
  !!fg?.link && fg.link.source !== "none" && !!fg.link.projectKey;

export interface ResearchInput {
  projectId: string;
  question: string;
  background: string;
  code: boolean;
  lessons: boolean;
  lessonsAvailable: boolean;
  web: boolean;
  /** Sindri's local-only mode: the Web source is unavailable and never sent. */
  localOnly?: boolean;
  factCheck: boolean;
  notes: string;
  skillIds: string[];
}

/** Why the Web source cannot be ticked; "" when it can. */
export const webSourceBlock = (localOnly: boolean | undefined): string =>
  localOnly
    ? "Local-only mode is on: web research is unavailable. Turn it off in Sindri's Settings."
    : "";

/** Whether Sindri's GitHub status (`GET /v1/github/status`) says local-only mode is on. */
export const localOnlyOf = (status: R | null | undefined): boolean =>
  status?.localOnly === true;

const webOf = (f: ResearchInput) => f.web && !f.localOnly;

/** Why the research form cannot be sent yet; "" when it can. */
export function researchBlock(f: ResearchInput): string {
  if (!f.projectId) return "Choose a project first.";
  if (!f.question.trim()) return "Ask a question first.";
  if (f.question.trim().length > QUESTION_MAX_CHARS)
    return `Keep the question to ${QUESTION_MAX_CHARS} characters (it has ${f.question.trim().length}); put the rest in Background.`;
  if (!f.code && !(f.lessons && f.lessonsAvailable) && !webOf(f))
    return "Pick at least one source.";
  if (utf8Bytes(f.notes) > REQUEST_NOTES_MAX_BYTES)
    return "Notes are too long.";
  return tooManySkills(f.skillIds);
}

const guidance = (notes: string, skillIds: string[]) => ({
  ...(notes.trim() ? { notes } : {}),
  ...(skillIds.length ? { skillIds } : {}),
});

/** The `POST /v1/intakes` body for a research question. */
export function researchBody(f: ResearchInput): R {
  return {
    projectId: f.projectId,
    title: f.question.trim(),
    body: f.background,
    workKind: "research",
    research: {
      sources: {
        code: f.code,
        feedbackGraph: f.lessons && f.lessonsAvailable,
        web: webOf(f),
      },
      factCheck: f.factCheck,
    },
    ...guidance(f.notes, f.skillIds),
  };
}

export interface PrReviewInput {
  url: string;
  notes: string;
  skillIds: string[];
  /** Set once Sindri answered `project_required`: the operator's choice among its candidates. */
  candidates: { id: string; name: string }[] | null;
  pick: string;
}

/** Why the PR review form cannot be sent yet; "" when it can. */
export function prReviewBlock(f: PrReviewInput): string {
  const url = f.url.trim();
  if (!url) return "Paste a pull request URL first.";
  if (!PR_URL.test(url)) return "Use a github.com pull request URL.";
  if (f.candidates && !f.pick) return "Choose the project first.";
  if (utf8Bytes(f.notes) > REQUEST_NOTES_MAX_BYTES)
    return "Notes are too long.";
  return tooManySkills(f.skillIds);
}

/**
 * The `POST /v1/intakes/import` body. Sindri matches the repository to a project; once it asked
 * (`project_required`), the project the operator chose is sent.
 */
export function prReviewBody(f: PrReviewInput): R {
  return {
    url: f.url.trim(),
    workKind: "pr_review",
    ...(f.pick ? { projectId: f.pick } : {}),
    ...guidance(f.notes, f.skillIds),
  };
}

/** `project_required` details: the candidates, flat or under `candidates` / `projects`. */
export function projectCandidates(
  details: unknown,
  fallback: R[],
): { id: string; name: string }[] {
  const d = details as R | R[] | undefined;
  const list = Array.isArray(d) ? d : (d?.candidates ?? d?.projects);
  const rows: R[] = Array.isArray(list) && list.length ? list : fallback;
  return rows
    .filter((c) => typeof c?.id === "string")
    .map((c) => ({ id: c.id, name: String(c.name ?? c.id) }));
}

export interface DocSource {
  id: string;
  kind: "file" | "url" | "lesson";
  ref: string;
  title?: string;
  private?: boolean;
}

/**
 * Sources for ResearchDoc: an unknown kind is listed as plain text, and numeric ids leave no gap
 * (a missing number gets a placeholder) so each `[n]` lands on source n.
 */
export function docSources(sources: unknown): DocSource[] {
  const rows: R[] = Array.isArray(sources) ? sources : [];
  const known: DocSource[] = rows.map((s) => ({
    id: String(s.id),
    kind: s.kind === "file" ? "file" : s.kind === "lesson" ? "lesson" : "url",
    ref: String(s.ref ?? ""),
    ...(s.title ? { title: String(s.title) } : {}),
    ...(s.private === true || s.kind === "lesson" ? { private: true } : {}),
  }));
  const nums = rows.map((s) =>
    /^\d{1,4}$/.test(String(s.id)) ? Number(s.id) : NaN,
  );
  if (nums.some((n) => !Number.isInteger(n) || n < 1)) return known;
  const out: DocSource[] = [];
  for (let n = 1; n <= Math.max(0, ...nums); n++)
    out.push(
      known[nums.indexOf(n)] ?? {
        id: `missing-${n}`,
        kind: "url",
        ref: `Source ${n} is not listed`,
      },
    );
  return out;
}

export interface TableFinding {
  id: string;
  severity: string;
  message: string;
  category?: string;
  file?: string;
  line?: number;
  endLine?: number;
  suggestion?: string;
  included?: boolean;
  placement?: "inline" | "general";
}

/** Wire findings for FindingsTable; ids are made up when the source sent none. */
export function tableFindings(findings: unknown, prefix = "f"): TableFinding[] {
  const rows: R[] = Array.isArray(findings) ? findings : [];
  return rows.map((f, i) => ({
    id: String(f.id ?? `${prefix}-${i}`),
    severity: String(f.severity ?? "info"),
    message: String(f.message ?? ""),
    ...(f.category ? { category: String(f.category) } : {}),
    ...(f.file ? { file: String(f.file) } : {}),
    ...(typeof f.line === "number" ? { line: f.line } : {}),
    ...(typeof f.endLine === "number" ? { endLine: f.endLine } : {}),
    ...(f.suggestion ? { suggestion: String(f.suggestion) } : {}),
    ...(typeof f.included === "boolean" ? { included: f.included } : {}),
    ...(f.placement === "inline" || f.placement === "general"
      ? { placement: f.placement }
      : {}),
  }));
}

/** The PR review the operator would post: their draft when there is one, else the agent's. */
export function reviewDraft(review: R | null | undefined): {
  verdict: string | null;
  summary: string;
  findings: TableFinding[];
} {
  const d = review?.draft ?? review ?? {};
  return {
    verdict: typeof d.verdict === "string" ? d.verdict : null,
    summary: String(d.summary ?? ""),
    findings: tableFindings(d.findings, "rf"),
  };
}

export const VERDICT_LABEL: Record<string, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};
export const verdictLabel = (v: unknown) =>
  typeof v === "string"
    ? (VERDICT_LABEL[v] ?? v.replace(/_/g, " "))
    : "Not given";

/** The posted review's URL wherever the source reports it; null when not posted. */
export function postedUrl(
  review: R | null | undefined,
  preview?: R | null,
): string | null {
  const p = review?.posted ?? preview?.posted ?? null;
  const flat = review?.postedUrl ?? preview?.postedUrl;
  if (!p && !flat) return null;
  return p?.htmlUrl ?? p?.url ?? flat ?? "";
}

/**
 * The leak check from `GET …/review/preview`: flat `{ok, rule, findingId}` or `{ok, blocked:{…}}`,
 * at the top or under `preview` / `payload`. Absent reads as unknown (null), not as passed.
 */
export function leakCheckOf(
  raw: unknown,
): { ok: boolean; rule?: string; findingId?: string } | null {
  const top = (raw && typeof raw === "object" ? raw : {}) as R;
  const leak: R | undefined =
    top.leakCheck ??
    top.preview?.leakCheck ??
    top.payload?.leakCheck ??
    top.leak;
  if (!leak || typeof leak !== "object") return null;
  if (leak.ok !== false) return { ok: true };
  const b =
    leak.blocked && typeof leak.blocked === "object" ? leak.blocked : leak;
  return {
    ok: false,
    rule: typeof b.rule === "string" ? b.rule : "unknown",
    ...(typeof b.findingId === "string" ? { findingId: b.findingId } : {}),
  };
}

/** A one-line summary of a research or PR review delivery, carried on Heimdall's delivery rows. */
export interface WorkSummary {
  kind: string;
  title: string | null;
  decision?: string | null;
  posted?: boolean;
  verdict?: string | null;
  gatePassed?: boolean;
}

/** Sindri accepts a document only when every gate reported passed; a missing result has not. */
export const researchChecksPassed = (research: R | null | undefined): boolean =>
  research?.gate?.passed === true &&
  (research.factCheck == null || research.factCheck.gatePassed === true);

/** Research documents waiting on accept/reject and PR reviews not yet posted. */
export function pendingDocuments(deliveries: R[]): R[] {
  return deliveries.filter((d) => {
    const w: WorkSummary | undefined = d.work;
    if (w?.kind === "research") return !w.decision;
    if (w?.kind === "pr_review") return !w.posted;
    return false;
  });
}

/** What a listed document or review waits for; failed checks leave only reject or a follow-up. */
export function documentWaiting(work: WorkSummary | null | undefined): string {
  if (work?.kind === "research")
    return work.gatePassed === true
      ? "Accept or reject"
      : "Reject or ask a follow-up (checks failed)";
  return `Posting in Sindri · ${verdictLabel(work?.verdict)}`;
}

const shortSha = (v: unknown) =>
  typeof v === "string" ? v.slice(0, 7) : "unknown";

/** The dialog's text for a refused command; Sindri's refusals with details get a plain account. */
export function commandErrorText(e: {
  message: string;
  code?: string;
  details?: any;
}): string {
  const d = e.details ?? {};
  if (e.code === "already_decided") {
    const decision =
      typeof d.decision === "string" ? d.decision : d.decision?.decision;
    return `This document was already ${decision ?? "decided"}${d.decision?.actor ? ` by ${d.decision.actor}` : ""}. The current decision is shown; nothing was changed.`;
  }
  if (e.code === "pr_changed_since_plan")
    return `The pull request changed since this review was planned (planned at ${shortSha(d.planHead)}, now at ${shortSha(d.currentHead)}). Import the pull request again to review the new commits.`;
  return e.message;
}
