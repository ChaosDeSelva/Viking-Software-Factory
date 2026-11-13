import type { DeliveryDetail } from "../api/delivery-types.js";
import type {
  PrReviewDraft,
  PrReviewFinding,
  PrReviewReport,
  ReviewPost,
  ResearchReport,
  ReviewPreview,
  SkillSummary,
} from "../api/work-types.js";
import { delivery } from "./delivery-fixtures.js";

export const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "sk1",
  name: "code-review",
  description: "Review code for bugs",
  sourcePath: "/Users/me/.claude/skills/code-review/SKILL.md",
  digest: "a1b2c3d4e5f6a7b8c9d0",
  bytes: 120,
  importedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  changedOnDisk: false,
  missingOnDisk: false,
  ...over,
});

export const guidanceUsed = {
  skills: [{ id: "sk1", name: "code-review", digest: "abcdef0123456789abcdef" }],
  omitted: [],
  projectNotes: "Always check auth.",
  requestNotes: "",
  projectNotesDigest: "feedface00112233",
  requestNotesDigest: null,
};

export const researchReport = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  question: "How are invoices totalled?",
  sourcesAllowed: { code: true, feedbackGraph: true, web: false },
  planTaskId: "research",
  document: {
    markdown:
      "## Answer\n\nTotals are summed in the service [1] and rounded per a past lesson [2].\n\n## Findings\n\nSee [1, 2].\n\n## Open questions\n\nNone.\n\n## Sources\n\n1. src/totals.ts\n",
    artifactId: "art_doc",
  },
  sources: [
    { id: "2", kind: "lesson", ref: "lesson:42", title: "Round half up", private: true },
    { id: "1", kind: "file", ref: "src/totals.ts:10-20" },
  ],
  sourcesArtifactId: "art_src",
  containsPrivateSources: true,
  gate: { passed: true, failures: [] },
  factCheck: {
    planTaskId: "fact-check",
    verdict: "approve",
    findings: [
      {
        severity: "minor",
        message: "Claim 2 is loosely supported",
        file: "src/totals.ts",
        line: 12,
      },
    ],
    reviewArtifactId: "art_rev",
    gatePassed: true,
  },
  decision: null,
  ...over,
});

export const researchDelivery = (over: Partial<ResearchReport> = {}): DeliveryDetail => {
  const base = delivery();
  return {
    ...base,
    report: {
      ...base.report,
      workKind: "research",
      guidance: guidanceUsed,
      research: researchReport(over),
    },
  };
};

const prFindings = (): PrReviewFinding[] => [
  {
    id: "f1",
    planTaskId: "pr-review",
    severity: "major",
    file: "src/export.ts",
    line: 4,
    side: "RIGHT",
    message: "Unescaped commas break the CSV",
    placement: "inline",
    included: true,
  },
  {
    id: "f2",
    planTaskId: "pr-review",
    severity: "nit",
    file: "CHANGELOG.md",
    line: 1,
    side: "RIGHT",
    message: "Consider a changelog entry",
    placement: "general",
    placementNote: "file not in the PR",
    included: true,
  },
];

export const prReview = (
  over: Partial<PrReviewReport> = {},
  draft: Partial<PrReviewDraft> = {},
): PrReviewReport => ({
  pr: {
    owner: "acme",
    repo: "shop",
    number: 7,
    url: "https://github.com/acme/shop/pull/7",
    title: "Add CSV export",
    baseSha: "1111111111111111111111",
    headSha: "2222222222222222222222",
  },
  planTaskId: "pr-review",
  verdict: "approve",
  summary: "Looks mostly fine.",
  markdown: "## Review",
  reviewArtifactId: "art_r",
  markdownArtifactId: "art_m",
  findings: prFindings(),
  reviews: [
    {
      planTaskId: "pr-review",
      role: "reviewer",
      verdict: "approve",
      summary: "Looks mostly fine.",
      markdown: "## Review\n\nFine overall.",
      gatePassed: true,
    },
    {
      planTaskId: "security-review",
      role: "security",
      verdict: "request_changes",
      summary: "Token is logged.",
      markdown: null,
      gatePassed: true,
    },
  ],
  gatePassed: true,
  gateFailures: [],
  hunksAvailable: true,
  draft: {
    version: 0,
    verdict: "comment",
    summary: "Looks mostly fine.",
    findings: prFindings(),
    editedBy: null,
    editedAt: null,
    ...draft,
  },
  posted: null,
  ...over,
});

export const prDelivery = (
  over: Partial<PrReviewReport> = {},
  draft: Partial<PrReviewDraft> = {},
): DeliveryDetail => {
  const base = delivery();
  return {
    ...base,
    report: {
      ...base.report,
      workKind: "pr_review",
      guidance: guidanceUsed,
      review: prReview(over, draft),
    },
  };
};

export const preview = (over: Partial<ReviewPreview> = {}): ReviewPreview => ({
  draftVersion: 0,
  pr: prReview().pr,
  payload: {
    commit_id: "2222222222222222222222",
    event: "COMMENT",
    body: "Looks mostly fine.\n\n- Consider a changelog entry",
    comments: [
      { path: "src/export.ts", line: 4, side: "RIGHT", body: "Unescaped commas break the CSV" },
    ],
  },
  leakCheck: { ok: true },
  gatesPassed: true,
  posted: null,
  canPost: true,
  blockers: [],
  ...over,
});

export const reviewPost = (htmlUrl: string): ReviewPost => ({
  reviewId: 9,
  htmlUrl,
  draftVersion: 1,
  commitId: "2222222222222222222222",
  payloadSha256: "abc",
  actor: "local:me",
  postedAt: "2026-01-03T00:00:00Z",
});

export const deliverySummary = {
  id: "e1",
  planId: "pl1",
  planVersion: 1,
  projectId: "p1",
  status: "verified_pending_review",
  mimirMissionId: "msn_1",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
};
