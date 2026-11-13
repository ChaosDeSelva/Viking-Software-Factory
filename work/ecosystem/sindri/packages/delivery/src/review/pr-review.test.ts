import { FakeProvider } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { FakeDeliveryWorld, planTaskView, planView } from "../gates/fakes.js";
import { GateRunner, type GateSpec } from "../gates/gate-runner.js";
import type { ContextReader, PrReviewView } from "../gates/ports.js";
import { DeliveryReports } from "../report/delivery-report.js";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import {
  buildReviewPayload,
  checkPrReview,
  currentDraft,
  editDraft,
  findMarkedReview,
  leakCheck,
  markReviewPayload,
  parseChangedHunks,
  parsePrReview,
  placeFinding,
  placeFindings,
  type PlacedFinding,
} from "./pr-review.js";
import { PrReviewStore } from "./pr-review-store.js";
import { ReviewFileSchema } from "./review-orchestrator.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,3 @@ export function main() {",
  "-old",
  "-old2",
  "+new",
  "+new2",
  "+new3",
  "@@ -40 +41,0 @@",
  "-removed",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,5 @@",
  "+a",
  'diff --git "a/odd\\tname.ts" "b/odd\\tname.ts"',
  '--- "a/odd\\tname.ts"',
  '+++ "b/odd\\tname.ts"',
  "@@ -1 +1 @@",
  "-x",
  "+y",
].join("\n");

describe("review.json", () => {
  it("parses the extended format", () => {
    const p = parsePrReview(
      JSON.stringify({
        verdict: "comment",
        summary: "Looks fine",
        findings: [
          {
            id: "F1",
            severity: "nit",
            category: "style",
            file: "src/app.ts",
            line: 10,
            endLine: 11,
            side: "RIGHT",
            message: "Rename",
            suggestion: "use x",
          },
        ],
        acceptance: [],
        decisions: [],
      }),
    );
    expect(p.ok && p.review.findings[0]).toMatchObject({ id: "F1", severity: "nit", endLine: 11 });
  });

  it("still parses an older code-review file, and the old parser keeps its verdicts", () => {
    const old = {
      verdict: "request_changes",
      findings: [{ severity: "blocking", message: "Broken", file: "a.ts" }],
      acceptance: [{ criterionId: "AC-1", satisfied: false }],
    };
    const p = parsePrReview(JSON.stringify(old));
    expect(p.ok && p.review).toMatchObject({
      verdict: "request_changes",
      summary: "",
      findings: [{ severity: "critical", message: "Broken" }],
    });
    expect(ReviewFileSchema.parse(old).verdict).toBe("request_changes");
    // The code-review parser ignores the new fields and refuses the new verdict.
    expect(
      ReviewFileSchema.parse({ ...old, summary: "s", findings: [{ message: "m", id: "F1" }] })
        .findings[0],
    ).toEqual({ severity: "info", message: "m" });
    expect(ReviewFileSchema.safeParse({ ...old, verdict: "comment" }).success).toBe(false);
  });

  it("refuses unsafe paths and backwards line ranges", () => {
    for (const f of [
      { message: "m", file: "../etc/passwd" },
      { message: "m", file: "/abs" },
      { message: "m", file: "a.ts", line: 5, endLine: 2 },
    ])
      expect(
        parsePrReview(JSON.stringify({ verdict: "comment", summary: "s", findings: [f] })).ok,
      ).toBe(false);
    expect(parsePrReview("{").ok).toBe(false);
  });

  it("gates on schema, summary, unique ids and review.md", () => {
    const json = (v: unknown) => ({ text: JSON.stringify(v), artifactId: "a1" });
    const md = { text: "# Review", artifactId: "a2" };
    expect(
      checkPrReview({
        json: json({ verdict: "approve", summary: "ok", findings: [] }),
        markdown: md,
        unreadable: [],
      }),
    ).toEqual([]);
    const bad = checkPrReview({
      json: json({
        verdict: "comment",
        findings: [
          { id: "F1", message: "a" },
          { id: "F1", message: "b" },
        ],
      }),
      markdown: null,
      unreadable: [],
    });
    expect(bad.map((f) => f.reason)).toEqual([
      "summary_missing",
      "finding_ids_not_unique",
      "markdown_missing",
    ]);
    expect(checkPrReview({ json: null, markdown: md, unreadable: [] })[0]!.reason).toBe(
      "review_missing",
    );
  });
});

describe("hunk mapping", () => {
  const hunks = parseChangedHunks(DIFF);
  const files = new Set(["src/app.ts", "docs/new.md"]);

  it("reads changed ranges of both sides", () => {
    expect(hunks.right.get("src/app.ts")).toEqual([{ start: 10, end: 12 }]);
    expect(hunks.left.get("src/app.ts")).toEqual([
      { start: 10, end: 11 },
      { start: 40, end: 40 },
    ]);
    expect(hunks.right.get("docs/new.md")).toEqual([{ start: 1, end: 5 }]);
    expect(hunks.left.has("docs/new.md")).toBe(false);
    expect(hunks.right.get("odd\tname.ts")).toEqual([{ start: 1, end: 1 }]);
  });

  it("reads --- and +++ as headers only before a file's first hunk", () => {
    const tricky = parseChangedHunks(
      [
        "diff --git a/s.sql b/s.sql",
        "--- a/s.sql",
        "+++ b/s.sql",
        "@@ -3,2 +3,2 @@",
        "--- legacy",
        "-old",
        "+++ x",
        "+new",
        "@@ -9 +9 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect([...tricky.paths]).toEqual(["s.sql"]);
    expect(tricky.right.get("s.sql")).toEqual([
      { start: 3, end: 4 },
      { start: 9, end: 9 },
    ]);
    expect(tricky.left.get("s.sql")).toEqual([
      { start: 3, end: 4 },
      { start: 9, end: 9 },
    ]);
  });

  it("places findings inline inside a hunk, general otherwise, never dropped", () => {
    const at = (o: Partial<PlacedFinding>) => placeFinding({ side: "RIGHT", ...o }, hunks, files);
    expect(at({ file: "src/app.ts", line: 11 })).toEqual({ placement: "inline" });
    expect(at({ file: "src/app.ts", line: 11, endLine: 12 })).toEqual({ placement: "inline" });
    expect(at({ file: "src/app.ts", line: 12, endLine: 13 }).placement).toBe("general");
    expect(at({ file: "src/app.ts", line: 40, side: "LEFT" })).toEqual({ placement: "inline" });
    expect(at({ file: "src/app.ts", line: 40 })).toMatchObject({
      placement: "general",
      placementNote: expect.stringContaining("outside"),
    });
    expect(at({ file: "src/other.ts", line: 1 })).toMatchObject({
      placement: "general",
      placementNote: expect.stringContaining("not part of this pull request"),
    });
    expect(at({ file: "src/app.ts" })).toMatchObject({ placement: "general" });
    expect(at({})).toEqual({ placement: "general" });
    expect(
      placeFinding({ side: "RIGHT", file: "src/app.ts", line: 11 }, null, files),
    ).toMatchObject({ placement: "general" });
  });
});

const finding = (o: Partial<PlacedFinding>): PlacedFinding => ({
  id: "F1",
  planTaskId: "pr-review",
  severity: "major",
  side: "RIGHT",
  message: "Null deref",
  placement: "general",
  included: true,
  ...o,
});

describe("finding ids", () => {
  const review = (findings: object[]) =>
    parsePrReview(JSON.stringify({ verdict: "comment", summary: "s", findings }));

  it("derives stable ids for findings without one, so reordering keeps draft edits attached", () => {
    const a = { severity: "major", file: "src/a.ts", line: 3, message: "A" };
    const b = { severity: "minor", message: "B" };
    const dup = { severity: "minor", message: "B" };
    const first = review([a, b, dup]);
    const second = review([dup, b, a]);
    if (!first.ok || !second.ok) throw new Error("parse");
    const placed1 = placeFindings(
      [{ planTaskId: "pr-review", review: first.review }],
      null,
      new Set(),
    );
    const placed2 = placeFindings(
      [{ planTaskId: "pr-review", review: second.review }],
      null,
      new Set(),
    );
    expect(placed1.map((f) => f.id)[0]).toMatch(/^f-[0-9a-f]{10}$/);
    const idOf = (list: PlacedFinding[], message: string) =>
      list.filter((f) => f.message === message).map((f) => f.id);
    expect(idOf(placed2, "A")).toEqual(idOf(placed1, "A"));
    expect(new Set(idOf(placed1, "B")).size).toBe(2);
    expect(idOf(placed1, "B")[1]).toBe(`${idOf(placed1, "B")[0]}-2`);
    // An edit made against the first order applies to the same finding in the second.
    const edit = editDraft(currentDraft({ summary: "s", findings: placed1 }, null), {
      findings: [{ id: idOf(placed1, "A")[0]!, included: false }],
    });
    if (!edit.ok) throw new Error("edit");
    const after = currentDraft(
      { summary: "s", findings: placed2 },
      { ...edit.next, version: 1, actor: "op", createdAt: "t" },
    );
    expect(after.findings.find((f) => f.message === "A")!.included).toBe(false);
    expect(after.findings.filter((f) => f.message === "B").every((f) => f.included)).toBe(true);
  });
});

describe("payload and leak check", () => {
  it("builds a review: summary plus general findings, inline comments, event and commit", () => {
    const { payload, texts } = buildReviewPayload(
      {
        verdict: "request_changes",
        summary: "Two problems.",
        findings: [
          finding({ id: "F1", file: "src/app.ts", line: 10, endLine: 12, placement: "inline" }),
          finding({ id: "F2", file: "src/x.ts", line: 3, message: "Elsewhere", suggestion: "Fix" }),
          finding({ id: "F3", included: false, message: "Dropped by operator" }),
        ],
      },
      HEAD,
    );
    expect(payload).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: "Two problems.\n\n- `src/x.ts:3` **major**: Elsewhere\n  \n  Suggestion: Fix",
      comments: [
        {
          path: "src/app.ts",
          line: 12,
          side: "RIGHT",
          start_line: 10,
          start_side: "RIGHT",
          body: "**major**: Null deref",
        },
      ],
    });
    expect(texts.map((t) => t.findingId)).toEqual([null, "F2", "F1"]);
    expect(JSON.stringify(payload)).not.toContain("Dropped by operator");
    expect(
      buildReviewPayload({ verdict: "comment", summary: "s", findings: [] }, HEAD).payload.event,
    ).toBe("COMMENT");
  });

  it("marks the posted body but keeps the marker out of the leak check", () => {
    const built = buildReviewPayload({ verdict: "comment", summary: "Fine.", findings: [] }, HEAD);
    const { payload, payloadSha256, marker } = markReviewPayload(built.payload, "exe_1");
    expect(marker).toBe(`<!-- viking-review:exe_1:${payloadSha256.slice(0, 16)} -->`);
    expect(payload.body).toBe(`Fine.\n\n${marker}`);
    expect(built.texts.some((t) => t.text.includes("viking-review"))).toBe(false);
    expect(markReviewPayload(built.payload, "exe_1").payloadSha256).toBe(payloadSha256);
    expect(findMarkedReview([{ body: "x" }, { body: payload.body }], "exe_1")).toEqual({
      body: payload.body,
    });
    expect(findMarkedReview([{ body: payload.body }], "exe_2")).toBeUndefined();
    expect(findMarkedReview([{ body: null }], "exe_1")).toBeUndefined();
  });

  it("passes clean text", () => {
    expect(leakCheck([{ findingId: null, field: "summary", text: "Looks good." }])).toEqual({
      ok: true,
    });
  });

  it.each([
    ["Per the Feedback Graph this is wrong", "private_tooling"],
    ["see feedback-graph", "private_tooling"],
    ["call fg__search", "private_tooling"],
    ["run check_before_done first", "private_tooling"],
    ["report_feedback said so", "private_tooling"],
    ["http://localhost:8787/inbox", "private_tooling"],
    ["http://127.0.0.1:8787", "private_tooling"],
    ["As lesson:abc-123 says", "lesson_reference"],
    ["token ghp_" + "a".repeat(36), "secret:github-token"],
    ["key AKIA" + "ABCDEFGHIJKLMNOP", "secret:aws-access-key"],
    ['api_key = "abcd1234efgh5678ijkl"', "secret:generic"],
  ])("blocks %s", (text, rule) => {
    expect(leakCheck([{ findingId: "F9", field: "comment", text }])).toEqual({
      ok: false,
      rule,
      findingId: "F9",
      field: "comment",
    });
  });
});

describe("drafts", () => {
  const agent = {
    summary: "Agent summary",
    findings: [finding({ id: "F1" }), finding({ id: "F2", suggestion: "s2" })],
  };

  it("starts from the agent's review with verdict comment, and applies stored edits", () => {
    const d0 = currentDraft(agent, null);
    expect(d0).toMatchObject({ version: 0, verdict: "comment", summary: "Agent summary" });
    const e = editDraft(d0, {
      verdict: "approve",
      findings: [
        { id: "F1", included: false },
        { id: "F2", included: true, message: "Reworded", suggestion: null },
      ],
    });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const d1 = currentDraft(agent, { ...e.next, version: 1, actor: "op", createdAt: "t" });
    expect(d1).toMatchObject({ version: 1, verdict: "approve", editedBy: "op" });
    expect(d1.findings[0]!.included).toBe(false);
    expect(d1.findings[1]).toMatchObject({ message: "Reworded", included: true });
    expect(d1.findings[1]!.suggestion).toBeUndefined();
    // The agent's findings are untouched.
    expect(agent.findings[1]!.message).toBe("Null deref");
    expect(editDraft(d0, { findings: [{ id: "nope", included: true }] })).toEqual({
      ok: false,
      unknown: ["nope"],
    });
  });

  it("stores versions and a single post", () => {
    const db = openDeliveryTestDb();
    db.prepare(
      "INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES ('p', 'p', '/p', 't', 't')",
    ).run();
    const store = new PrReviewStore(db);
    expect(store.latestDraft("exe")).toBeNull();
    store.saveDraft("exe", "p", { verdict: "comment", summary: "a", findings: [] }, "op");
    const v2 = store.saveDraft(
      "exe",
      "p",
      { verdict: "approve", summary: "b", findings: [] },
      "op",
    );
    expect(v2.version).toBe(2);
    expect(store.latestDraft("exe")).toMatchObject({ version: 2, summary: "b" });
    const post = {
      executionId: "exe",
      draftVersion: 2,
      reviewId: 5,
      htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-5",
      commitId: HEAD,
      payloadSha256: "x",
      actor: "op",
    };
    expect(store.recordPost("p", post).reviewId).toBe(5);
    expect(store.recordPost("p", { ...post, reviewId: 6 }).reviewId).toBe(5);
  });
});

const PR: PrReviewView = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  url: "https://github.com/acme/widgets/pull/7",
  title: "Add widgets",
  body: "",
  author: "octo",
  baseRef: "main",
  headRef: "f",
  baseSha: BASE,
  headSha: HEAD,
  isCrossRepository: false,
  files: ["src/app.ts"],
  filesOmitted: 0,
  nonce: "abc123",
};

const context: ContextReader = {
  spec: (id) =>
    Promise.resolve(
      id === "spc_1"
        ? {
            id,
            lineageId: "spl_1",
            version: 1,
            status: "approved",
            title: "Review PR 7",
            intakeId: null,
            acceptanceCriteria: [{ id: "AC-1", text: "Review it", verification: "manual" }],
          }
        : undefined,
    ),
  intake: () => Promise.resolve(undefined),
};

function prWorld(opts: { review?: unknown; markdown?: string | null; diff?: string | null } = {}) {
  const plan = planView(
    [
      planTaskView("pr-review", { role: "reviewer" }),
      planTaskView("security-review", { role: "security" }),
    ],
    { work: { kind: "pr_review", prReview: PR } },
  );
  const w = new FakeDeliveryWorld(plan);
  w.addTask("pr-review", "mt_rev", "crw_rev", { template: "reviewer" });
  w.addTask("security-review", "mt_sec", "crw_sec", { template: "reviewer" });
  const review = opts.review ?? {
    verdict: "request_changes",
    summary: "One bug.",
    findings: [
      { id: "F1", severity: "major", file: "src/app.ts", line: 11, message: "Null deref" },
      { id: "F2", severity: "minor", file: "src/app.ts", line: 99, message: "Outside" },
    ],
  };
  w.artifact("mt_rev", "review", JSON.stringify(review), { name: "review.json" });
  if (opts.markdown !== null)
    w.artifact("mt_rev", "report", opts.markdown ?? "# Review", { name: "review.md" });
  w.artifact(
    "mt_sec",
    "review",
    JSON.stringify({
      verdict: "comment",
      summary: "No security issues.",
      findings: [{ id: "F1", severity: "info", message: "Token handling is fine" }],
    }),
    { name: "review.json" },
  );
  w.artifact("mt_sec", "report", "# Security", { name: "review.md" });
  const db = openDeliveryTestDb();
  const gates = new GateRunner({
    db,
    executions: w,
    mimir: w,
    content: w,
    gatesFor: () => [{ id: "pr-review", kind: "pr-review", required: true }] as GateSpec[],
  });
  const reports = new DeliveryReports({
    db,
    executions: w,
    mimir: w,
    content: w,
    context,
    provider: new FakeProvider(() => {
      throw new Error("PR review reports call no model");
    }),
    gates,
    reviews: { list: () => [] },
    prDiff: {
      diff: () =>
        opts.diff === null
          ? Promise.reject(new Error("no mirror"))
          : Promise.resolve({ diff: opts.diff ?? DIFF, mergeBaseSha: BASE }),
    },
  });
  return { w, gates, reports };
}

describe("PR review delivery", () => {
  it("passes the gates without Brokkr and reports placed findings of both reviewers", async () => {
    const { w, gates, reports } = prWorld();
    const r = await gates.evaluate(w.executionId, "pr-review");
    expect(r).toMatchObject({ passed: true, engineering: null, failures: [] });
    await gates.evaluate(w.executionId, "security-review");
    const report = await reports.build(w.executionId);
    expect(report.workKind).toBe("pr_review");
    expect(report.summary).toEqual({ sentences: [], stripped: [] });
    expect(report.review).toMatchObject({
      pr: { owner: "acme", number: 7, headSha: HEAD },
      verdict: "request_changes",
      summary: "One bug.",
      markdown: "# Review",
      gatePassed: true,
      hunksAvailable: true,
      findings: [
        { id: "F1", placement: "inline", included: true },
        { id: "F2", placement: "general", placementNote: expect.any(String) },
        { id: "security-review.F1", planTaskId: "security-review", placement: "general" },
      ],
    });
    const read = reports.latestFor(w.executionId)!;
    expect(read.review!.draft).toMatchObject({ version: 0, verdict: "comment" });
    expect(read.review!.posted).toBeNull();
  });

  it("fails the gate without review.md or with an invalid review.json", async () => {
    const { w, gates } = prWorld({ markdown: null, review: { verdict: "lgtm", findings: [] } });
    const r = await gates.evaluate(w.executionId, "pr-review");
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.reason)).toEqual(["schema:verdict", "markdown_missing"]);
  });

  it("keeps every finding when the diff cannot be read", async () => {
    const { w, reports } = prWorld({ diff: null });
    const report = await reports.build(w.executionId);
    expect(report.review!.hunksAvailable).toBe(false);
    expect(report.review!.findings.every((f) => f.placement === "general")).toBe(true);
    expect(report.review!.findings).toHaveLength(3);
  });
});
