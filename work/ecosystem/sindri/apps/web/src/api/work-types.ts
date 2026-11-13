// Wire types for work kinds (research, PR review) and operator guidance (skills, project notes).
// Enums are open (`string & {}`): an unknown value from a newer server must render, never throw.

export type WorkKind = "change" | "research" | "pr_review";
export type AnyWorkKind = WorkKind | (string & {});

export interface ResearchOptions {
  sources?: { code?: boolean; feedbackGraph?: boolean; web?: boolean };
  factCheck?: boolean;
}

/** Fields every new intake may carry besides title/body or url. */
export interface WorkFields {
  workKind?: WorkKind;
  notes?: string;
  skillIds?: string[];
  research?: ResearchOptions;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  digest: string;
  bytes?: number;
  importedAt: string;
  updatedAt: string;
  changedOnDisk?: boolean;
  missingOnDisk?: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface SkillImportResult {
  imported: SkillSummary[];
  skipped: { path: string; reason: string }[];
}

export interface ProjectGuidance {
  projectId: string;
  notes: string;
  defaultSkillIds: string[];
  updatedAt: string | null;
}

/** Notes limits, in UTF-8 bytes (server: MAX_PROJECT_NOTES_BYTES, MAX_REQUEST_NOTES_BYTES). */
export const PROJECT_NOTES_MAX_BYTES = 16 * 1024;
export const REQUEST_NOTES_MAX_BYTES = 8 * 1024;
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Which guidance a delivery's briefs carried: skill names and digests, never skill text. */
export interface GuidanceUsed {
  skills: { id: string; name: string; digest: string }[];
  omitted?: { id: string; name: string; digest: string }[];
  projectNotes?: string;
  requestNotes?: string;
  projectNotesDigest: string | null;
  requestNotesDigest: string | null;
}

export interface ResearchSourceRef {
  id: string;
  kind: "file" | "url" | "lesson" | (string & {});
  ref: string;
  title?: string;
  private?: boolean;
}

export interface ReviewFindingWire {
  id?: string;
  severity: string;
  category?: string;
  message: string;
  file?: string;
  line?: number;
  endLine?: number;
  suggestion?: string;
}

export interface ResearchReport {
  question: string | null;
  sourcesAllowed: { code?: boolean; feedbackGraph?: boolean; web?: boolean };
  planTaskId: string | null;
  document: { markdown: string; artifactId: string } | null;
  sources: ResearchSourceRef[];
  sourcesArtifactId: string | null;
  containsPrivateSources: boolean;
  gate: { passed: boolean; failures: { gateId: string; reason: string }[] } | null;
  factCheck: {
    planTaskId: string;
    verdict: string | null;
    findings: ReviewFindingWire[];
    reviewArtifactId: string | null;
    gatePassed: boolean | null;
  } | null;
  decision: {
    decision: "accepted" | "rejected" | (string & {});
    actor: string;
    reason: string | null;
    decidedAt: string;
  } | null;
}

export type ReviewVerdict = "comment" | "approve" | "request_changes";

export interface PrReviewFinding {
  id: string;
  planTaskId?: string;
  severity: string;
  category?: string;
  file?: string;
  line?: number;
  endLine?: number;
  side?: "RIGHT" | "LEFT" | (string & {});
  message: string;
  suggestion?: string;
  placement: "inline" | "general" | (string & {});
  /** Why a located finding is a general comment (no line, outside the changed lines, …). */
  placementNote?: string;
  included: boolean;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  baseSha: string;
  headSha: string;
}

/** What gets posted. Version 0 is the agent's review with verdict `comment`. */
export interface PrReviewDraft {
  version: number;
  verdict: ReviewVerdict | (string & {});
  summary: string;
  findings: PrReviewFinding[];
  editedBy: string | null;
  editedAt: string | null;
}

export interface ReviewPost {
  reviewId: number;
  htmlUrl: string;
  draftVersion: number;
  commitId: string;
  payloadSha256: string;
  actor: string;
  postedAt: string;
}

/** `GET /v1/executions/:id/review`, and `report.review` of a pr_review delivery. */
export interface PrReviewReport {
  pr: PrRef;
  planTaskId?: string | null;
  /** The agent's own verdict, summary and findings (the draft is what gets posted). */
  verdict: ReviewVerdict | (string & {}) | null;
  summary: string;
  markdown: string | null;
  reviewArtifactId?: string | null;
  markdownArtifactId?: string | null;
  findings: PrReviewFinding[];
  reviews: {
    planTaskId: string;
    role: string;
    verdict: string | null;
    summary: string;
    markdown: string | null;
    gatePassed: boolean | null;
  }[];
  gatePassed: boolean;
  gateFailures: { gateId: string; reason: string }[];
  hunksAvailable: boolean;
  draft: PrReviewDraft;
  posted: ReviewPost | null;
}

export interface ReviewEdit {
  verdict?: ReviewVerdict;
  summary?: string;
  findings?: { id: string; included: boolean; message?: string; suggestion?: string | null }[];
}

export type LeakCheck =
  { ok: true } | { ok: false; rule: string; findingId: string | null; field: string };

/** `GET …/review/preview`. `payload` is not display sanitized: render it as text only. */
export interface ReviewPreview {
  draftVersion: number;
  pr: PrRef;
  payload: {
    commit_id: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | (string & {});
    body: string;
    comments: {
      path: string;
      line: number;
      side: string;
      start_line?: number;
      start_side?: string;
      body: string;
    }[];
  };
  leakCheck: LeakCheck;
  gatesPassed: boolean;
  posted: ReviewPost | null;
  canPost: boolean;
  blockers: string[];
}

export interface GitHubStatus {
  enabled: boolean;
  configured: boolean;
  ghInstalled: boolean;
  localOnly: boolean;
}

export interface PullRequestInfo {
  owner: string;
  repo: string;
  number: number;
  url: string;
  author: string;
  state: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  isCrossRepository: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** `project_required` details: the registered projects the PR could belong to. */
export interface ProjectCandidate {
  id: string;
  name: string;
  repoPath?: string;
}
