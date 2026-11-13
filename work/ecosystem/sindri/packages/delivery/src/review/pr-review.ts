import { PR_REVIEW_JSON, PR_REVIEW_MARKDOWN } from "@sindri/mimir-client";
import { createHash } from "node:crypto";
import { containsSecret, SECRET_CONTENT_PATTERNS } from "@sindri/knowledge";
import { z } from "zod";
import type { GateFailure } from "../gates/brokkr-report.js";
import { readVerifiedArtifact, type RecordedArtifact } from "../gates/evidence.js";
import type { ArtifactContentReader, MimirActions } from "../gates/ports.js";

/** Files a PR review task writes to `.mimir/artifacts/` (see `@sindri/mimir-client`). */
export const PR_REVIEW_JSON_FILE = PR_REVIEW_JSON;
export const PR_REVIEW_MARKDOWN_FILE = PR_REVIEW_MARKDOWN;

export const PR_REVIEW_GATES = {
  schema: "pr-review-schema",
  markdown: "pr-review-markdown",
} as const;

export const PR_REVIEW_VERDICTS = ["comment", "approve", "request_changes"] as const;
export type PrReviewVerdict = (typeof PR_REVIEW_VERDICTS)[number];
export const PR_REVIEW_SEVERITIES = ["critical", "major", "minor", "nit", "info"] as const;
export type PrReviewSeverity = (typeof PR_REVIEW_SEVERITIES)[number];

/** A repository-relative path: no absolute paths, no `..`, no control characters. */
const RepoPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    // eslint-disable-next-line no-control-regex
    (p) => !p.startsWith("/") && !p.split("/").includes("..") && !/[\0-\x1f]/.test(p),
    "must be a path relative to the repository root",
  );

export const PrReviewFindingSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,40}$/)
      .optional(),
    // Code-review files use `blocking`; it reads as critical.
    severity: z
      .preprocess((v) => (v === "blocking" ? "critical" : v), z.enum(PR_REVIEW_SEVERITIES))
      .default("info"),
    category: z.string().trim().min(1).max(60).optional(),
    file: RepoPath.optional(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    side: z.enum(["RIGHT", "LEFT"]).optional(),
    message: z.string().trim().min(1).max(2000),
    suggestion: z.string().max(4000).optional(),
  })
  .refine((f) => f.endLine === undefined || (f.line !== undefined && f.endLine >= f.line), {
    message: "endLine needs line and must not be before it",
  });

/**
 * `review.json` of a PR review: the code-review file (verdict, findings, acceptance, decisions)
 * plus `summary`, the `comment` verdict and located findings. A plain code-review file still
 * parses (its verdicts are a subset; `blocking` reads as critical).
 */
export const PrReviewFileSchema = z.object({
  verdict: z.enum(PR_REVIEW_VERDICTS),
  summary: z.string().trim().max(8000).default(""),
  findings: z.array(PrReviewFindingSchema).max(200),
  acceptance: z
    .array(
      z.object({ criterionId: z.string(), satisfied: z.boolean(), note: z.string().optional() }),
    )
    .default([]),
  decisions: z.array(z.unknown()).default([]),
});
export type PrReviewFile = z.infer<typeof PrReviewFileSchema>;

export interface PrReviewArtifacts {
  json: { text: string; artifactId: string } | null;
  markdown: { text: string; artifactId: string } | null;
  unreadable: GateFailure[];
}

/** The latest trusted review.json and review.md of a task lineage, hash-checked through Mimir. */
export async function readPrReviewArtifacts(
  mimir: Pick<MimirActions, "getArtifact">,
  content: ArtifactContentReader,
  artifacts: readonly RecordedArtifact[],
): Promise<PrReviewArtifacts> {
  const unreadable: GateFailure[] = [];
  const read = async (pick: RecordedArtifact | undefined, gateId: string) => {
    if (!pick) return null;
    const r = await readVerifiedArtifact(mimir, content, pick.artifactId, {
      taskId: pick.taskId,
      kind: pick.kind,
    });
    if (!r.ok) {
      unreadable.push({ gateId, reason: r.reason, evidenceRef: pick.artifactId });
      return null;
    }
    return { text: r.text, artifactId: pick.artifactId };
  };
  const json = artifacts
    .filter((a) => a.name === PR_REVIEW_JSON_FILE || (a.name === null && a.kind === "review"))
    .at(-1);
  const md = artifacts
    .filter((a) => a.name === PR_REVIEW_MARKDOWN_FILE || (a.name === null && a.kind === "report"))
    .at(-1);
  return {
    json: await read(json, PR_REVIEW_GATES.schema),
    markdown: await read(md, PR_REVIEW_GATES.markdown),
    unreadable,
  };
}

/** Parses review.json; `error` names the first problem. */
export function parsePrReview(
  text: string,
): { ok: true; review: PrReviewFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not_json" };
  }
  const parsed = PrReviewFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `schema:${issue?.path.join(".") || "root"}` };
  }
  return { ok: true, review: parsed.data };
}

/** The PR review gates over one task's recorded artifacts. */
export function checkPrReview(artifacts: PrReviewArtifacts): GateFailure[] {
  const failures: GateFailure[] = [...artifacts.unreadable];
  const fail = (gateId: string, reason: string, evidenceRef?: string) =>
    failures.push({ gateId, reason, ...(evidenceRef ? { evidenceRef } : {}) });
  if (!artifacts.json && !artifacts.unreadable.some((u) => u.gateId === PR_REVIEW_GATES.schema))
    fail(PR_REVIEW_GATES.schema, "review_missing");
  if (artifacts.json) {
    const p = parsePrReview(artifacts.json.text);
    if (!p.ok) fail(PR_REVIEW_GATES.schema, p.error, artifacts.json.artifactId);
    else {
      if (!p.review.summary)
        fail(PR_REVIEW_GATES.schema, "summary_missing", artifacts.json.artifactId);
      const ids = p.review.findings.map((f) => f.id).filter((i): i is string => !!i);
      if (new Set(ids).size !== ids.length)
        fail(PR_REVIEW_GATES.schema, "finding_ids_not_unique", artifacts.json.artifactId);
    }
  }
  if (
    !artifacts.markdown &&
    !artifacts.unreadable.some((u) => u.gateId === PR_REVIEW_GATES.markdown)
  )
    fail(PR_REVIEW_GATES.markdown, "markdown_missing");
  else if (artifacts.markdown && !artifacts.markdown.text.trim())
    fail(PR_REVIEW_GATES.markdown, "markdown_empty", artifacts.markdown.artifactId);
  return failures;
}

// ---------------------------------------------------------------------------- Hunk mapping

export interface LineRange {
  start: number;
  end: number;
}

/** Changed line ranges per path: `right` in the head file, `left` in the base file. */
export interface ChangedHunks {
  right: Map<string, LineRange[]>;
  left: Map<string, LineRange[]>;
  /** Every path the diff touches (old and new names). */
  paths: Set<string>;
}

/** Undoes git's C-style quoting of an unusual path (`"a\\tb"`). */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else
      bytes.push(
        ({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 } as Record<string, number>)[n] ?? n.charCodeAt(0),
      );
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripPrefix = (p: string, prefix: "a/" | "b/") => {
  const u = unquote(p.replace(/\t$/, ""));
  return u === "/dev/null" ? null : u.startsWith(prefix) ? u.slice(2) : u;
};

/** Parses `git diff --unified=0 base head` into the changed line ranges of each side. */
export function parseChangedHunks(diff: string): ChangedHunks {
  const right = new Map<string, LineRange[]>();
  const left = new Map<string, LineRange[]>();
  const paths = new Set<string>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  // `---`, `+++` and `rename to` are file headers only between `diff --git` and the file's first
  // hunk; inside a hunk a removed `-- x` or added `++ x` line is content.
  let inHeader = false;
  const add = (m: Map<string, LineRange[]>, path: string, start: number, count: number) => {
    if (count <= 0) return;
    const list = m.get(path) ?? [];
    list.push({ start, end: start + count - 1 });
    m.set(path, list);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = newPath = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith("--- ")) {
      oldPath = stripPrefix(line.slice(4), "a/");
      if (oldPath) paths.add(oldPath);
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      newPath = stripPrefix(line.slice(4), "b/");
      if (newPath) paths.add(newPath);
      continue;
    }
    if (inHeader && line.startsWith("rename to ")) paths.add(unquote(line.slice(10)));
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!h) continue;
    inHeader = false;
    if (oldPath) add(left, oldPath, Number(h[1]), h[2] === undefined ? 1 : Number(h[2]));
    if (newPath) add(right, newPath, Number(h[3]), h[4] === undefined ? 1 : Number(h[4]));
  }
  return { right, left, paths };
}

export type Placement = "inline" | "general";

export interface PlacedFinding {
  id: string;
  /** The plan task whose review holds the finding. */
  planTaskId: string;
  severity: PrReviewSeverity;
  category?: string;
  file?: string;
  line?: number;
  endLine?: number;
  side: "RIGHT" | "LEFT";
  message: string;
  suggestion?: string;
  placement: Placement;
  /** Why a located finding is a general comment. */
  placementNote?: string;
  included: boolean;
}

/**
 * Places a finding: inline when its file and whole line range fall inside one changed hunk on
 * its side, otherwise a general comment with the reason. A finding is never dropped.
 */
export function placeFinding(
  f: Pick<PlacedFinding, "file" | "line" | "endLine" | "side">,
  hunks: ChangedHunks | null,
  prFiles: ReadonlySet<string>,
): { placement: Placement; placementNote?: string } {
  if (!f.file) return { placement: "general" };
  if (!hunks)
    return { placement: "general", placementNote: "the pull request's diff could not be read" };
  if (!prFiles.has(f.file) && !hunks.paths.has(f.file))
    return { placement: "general", placementNote: "the file is not part of this pull request" };
  if (f.line === undefined) return { placement: "general", placementNote: "no line given" };
  const end = f.endLine ?? f.line;
  const ranges = (f.side === "LEFT" ? hunks.left : hunks.right).get(f.file) ?? [];
  return ranges.some((r) => r.start <= f.line! && end <= r.end)
    ? { placement: "inline" }
    : {
        placement: "general",
        placementNote: "the line is outside the pull request's changed lines",
      };
}

/**
 * The id of a finding the agent gave none: a hash of what it says and where, so it does not
 * change when findings are reordered and draft edits stay attached to it.
 */
export function stableFindingId(
  planTaskId: string,
  f: {
    file?: string | undefined;
    line?: number | undefined;
    side?: string | undefined;
    message: string;
  },
): string {
  const key = JSON.stringify([
    planTaskId,
    f.file ?? null,
    f.line ?? null,
    f.side ?? "RIGHT",
    f.message,
  ]);
  return `f-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

/** Findings of every review task, with unique ids (later tasks' ids get a task prefix). */
export function placeFindings(
  reviews: { planTaskId: string; review: PrReviewFile }[],
  hunks: ChangedHunks | null,
  prFiles: ReadonlySet<string>,
): PlacedFinding[] {
  const out: PlacedFinding[] = [];
  const used = new Set<string>();
  reviews.forEach(({ planTaskId, review }, taskIndex) => {
    review.findings.forEach((f) => {
      const base = f.id ?? stableFindingId(planTaskId, f);
      const scoped = taskIndex === 0 ? base : `${planTaskId}.${base}`;
      let id = scoped;
      for (let n = 2; used.has(id); n++) id = `${scoped}-${n}`;
      used.add(id);
      const located = {
        ...(f.file ? { file: f.file } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
        side: f.side ?? ("RIGHT" as const),
      };
      out.push({
        id,
        planTaskId,
        severity: f.severity,
        ...(f.category ? { category: f.category } : {}),
        ...located,
        message: f.message,
        ...(f.suggestion ? { suggestion: f.suggestion } : {}),
        ...placeFinding(located, hunks, prFiles),
        included: true,
      });
    });
  });
  return out;
}

// --------------------------------------------------------------------------------- Payload

/** The review as the operator edited it; this is what gets posted. */
export interface ReviewDraft {
  version: number;
  verdict: PrReviewVerdict;
  summary: string;
  findings: PlacedFinding[];
  editedBy: string | null;
  editedAt: string | null;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
  body: string;
}

/** The body of `POST /repos/{o}/{r}/pulls/{n}/reviews`. */
export interface GitHubReviewPayload {
  commit_id: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: GitHubReviewComment[];
}

const EVENTS: Record<PrReviewVerdict, GitHubReviewPayload["event"]> = {
  comment: "COMMENT",
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
};

const label = (f: PlacedFinding) => `**${f.severity}**${f.category ? ` (${f.category})` : ""}`;

const findingText = (f: PlacedFinding) =>
  `${label(f)}: ${f.message}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ""}`;

const locationOf = (f: PlacedFinding) =>
  f.file
    ? ` \`${f.file}${f.line !== undefined ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}\``
    : "";

/** One text that will be posted, and the finding it comes from (null for the summary). */
export interface PostedText {
  findingId: string | null;
  field: "summary" | "body" | "comment";
  text: string;
}

/** Builds the GitHub review from a draft: included findings only, inline where placed. */
export function buildReviewPayload(
  draft: Pick<ReviewDraft, "verdict" | "summary" | "findings">,
  headSha: string,
): { payload: GitHubReviewPayload; texts: PostedText[] } {
  const included = draft.findings.filter((f) => f.included);
  const general = included.filter((f) => f.placement === "general");
  const inline = included.filter((f) => f.placement === "inline");
  const texts: PostedText[] = [{ findingId: null, field: "summary", text: draft.summary }];
  const generalLines = general.map((f) => {
    const text = `-${locationOf(f)} ${findingText(f).replace(/\n/g, "\n  ")}`;
    texts.push({ findingId: f.id, field: "body", text });
    return text;
  });
  const body = [draft.summary.trim(), generalLines.length ? generalLines.join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  const comments = inline.map((f): GitHubReviewComment => {
    const text = findingText(f);
    texts.push({ findingId: f.id, field: "comment", text });
    const multi = f.endLine !== undefined && f.endLine > (f.line as number);
    return {
      path: f.file as string,
      line: multi ? (f.endLine as number) : (f.line as number),
      side: f.side,
      ...(multi ? { start_line: f.line as number, start_side: f.side } : {}),
      body: text,
    };
  });
  return { payload: { commit_id: headSha, event: EVENTS[draft.verdict], body, comments }, texts };
}

/** The start of the hidden marker a posted review body carries for one execution. */
export const reviewMarkerPrefix = (executionId: string) => `<!-- viking-review:${executionId}:`;

/**
 * Appends the hidden marker `<!-- viking-review:<executionId>:<sha256 first 16> -->` to the body,
 * so a review GitHub created before a timeout can be found and recorded instead of posted again.
 * `payloadSha256` is the hash of the payload without the marker. The marker is not part of the
 * leak check's input.
 */
export function markReviewPayload(
  payload: GitHubReviewPayload,
  executionId: string,
): { payload: GitHubReviewPayload; payloadSha256: string; marker: string } {
  const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const marker = `${reviewMarkerPrefix(executionId)}${payloadSha256.slice(0, 16)} -->`;
  return {
    payload: { ...payload, body: payload.body ? `${payload.body}\n\n${marker}` : marker },
    payloadSha256,
    marker,
  };
}

/** The payload-hash prefix in this execution's marker in `body`, or null. */
export function markerHashOf(body: string, executionId: string): string | null {
  const at = body.indexOf(reviewMarkerPrefix(executionId));
  if (at < 0) return null;
  const m = /^([0-9a-f]{16}) -->/.exec(body.slice(at + reviewMarkerPrefix(executionId).length));
  return m ? m[1]! : null;
}

/** The review of a PR that carries this execution's marker, if any. */
export function findMarkedReview<T extends { body?: string | null }>(
  reviews: readonly T[],
  executionId: string,
): T | undefined {
  const prefix = reviewMarkerPrefix(executionId);
  return reviews.find((r) => typeof r.body === "string" && r.body.includes(prefix));
}

// ------------------------------------------------------------------------------ Leak check

/** Private local tooling that must never reach a posted review. */
export const PRIVATE_TOOLING =
  /feedback[\s-]?graph|\bfg__|check_before_done|report_feedback|localhost:8787|127\.0\.0\.1:8787/i;
/** A citation of an operator lesson (`lesson:<id>`). */
export const LESSON_REFERENCE = /\blesson:[A-Za-z0-9_.-]{2,}/i;

export type LeakCheck =
  { ok: true } | { ok: false; rule: string; findingId: string | null; field: PostedText["field"] };

/**
 * Refuses text that must stay local: private tooling names and URLs, lesson citations, and
 * anything the secret scanners match. Pure; the first match wins.
 */
export function leakCheck(texts: readonly PostedText[]): LeakCheck {
  for (const t of texts) {
    const hit = (rule: string): LeakCheck => ({
      ok: false,
      rule,
      findingId: t.findingId,
      field: t.field,
    });
    if (PRIVATE_TOOLING.test(t.text)) return hit("private_tooling");
    if (LESSON_REFERENCE.test(t.text)) return hit("lesson_reference");
    for (const line of t.text.split("\n"))
      for (const p of SECRET_CONTENT_PATTERNS)
        if (p.pattern.test(line)) return hit(`secret:${p.id}`);
    if (containsSecret(t.text)) return hit("secret:generic");
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------- Drafts

/** One finding's operator edit. `suggestion: null` clears the suggestion. */
export interface FindingEdit {
  id: string;
  included: boolean;
  message?: string | undefined;
  suggestion?: string | null | undefined;
}

export interface DraftEdit {
  verdict?: PrReviewVerdict | undefined;
  summary?: string | undefined;
  findings?: FindingEdit[] | undefined;
}

/** What a stored draft version keeps: the verdict, summary and per-finding edits. */
export interface StoredDraft {
  version: number;
  verdict: PrReviewVerdict;
  summary: string;
  findings: FindingEdit[];
  actor: string;
  createdAt: string;
}

/**
 * The draft as it stands: the agent's findings with the latest stored edits applied. Without a
 * stored draft it is version 0, the agent's summary and findings, and the verdict `comment` (the
 * operator chooses to approve or request changes).
 */
export function currentDraft(
  agent: { summary: string; findings: readonly PlacedFinding[] },
  stored: StoredDraft | null,
): ReviewDraft {
  if (!stored)
    return {
      version: 0,
      verdict: "comment",
      summary: agent.summary,
      findings: agent.findings.map((f) => ({ ...f })),
      editedBy: null,
      editedAt: null,
    };
  const edits = new Map(stored.findings.map((e) => [e.id, e]));
  return {
    version: stored.version,
    verdict: stored.verdict,
    summary: stored.summary,
    findings: agent.findings.map((f) => applyFindingEdit(f, edits.get(f.id))),
    editedBy: stored.actor,
    editedAt: stored.createdAt,
  };
}

function applyFindingEdit(f: PlacedFinding, e: FindingEdit | undefined): PlacedFinding {
  if (!e) return { ...f };
  const rest: PlacedFinding = { ...f };
  delete rest.suggestion;
  const suggestion = e.suggestion === undefined ? f.suggestion : (e.suggestion ?? undefined);
  return {
    ...rest,
    included: e.included,
    message: e.message ?? f.message,
    ...(suggestion ? { suggestion } : {}),
  };
}

/** Applies an edit to the current draft; unknown finding ids are refused. */
export function editDraft(
  current: ReviewDraft,
  edit: DraftEdit,
):
  | { ok: true; next: Omit<StoredDraft, "version" | "actor" | "createdAt"> }
  | { ok: false; unknown: string[] } {
  const known = new Set(current.findings.map((f) => f.id));
  const unknown = (edit.findings ?? []).map((e) => e.id).filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, unknown };
  const edits = new Map((edit.findings ?? []).map((e) => [e.id, e]));
  return {
    ok: true,
    next: {
      verdict: edit.verdict ?? current.verdict,
      summary: edit.summary ?? current.summary,
      findings: current.findings.map((f) => {
        const e = edits.get(f.id);
        return {
          id: f.id,
          included: e?.included ?? f.included,
          message: e?.message ?? f.message,
          suggestion: e?.suggestion === undefined ? (f.suggestion ?? null) : e.suggestion,
        };
      }),
    },
  };
}
