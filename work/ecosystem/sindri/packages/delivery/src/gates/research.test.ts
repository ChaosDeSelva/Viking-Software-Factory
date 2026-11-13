import { FakeProvider } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { DeliveryError, DeliveryReports } from "../report/delivery-report.js";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import { BASE_SHA, FakeDeliveryWorld, planTaskView, planView } from "./fakes.js";
import { GateRunner, type GateSpec } from "./gate-runner.js";
import type { ContextReader, PlanWorkView, RepoReader } from "./ports.js";
import {
  checkResearch,
  citationIds,
  parseFileRef,
  RESEARCH_GATES,
  type ResearchCheckInput,
} from "./research.js";

const DOC = [
  "# Retry scheduling",
  "## Answer",
  "Retries back off exponentially [1].",
  "## Findings",
  "The worker reads the delay from config [1][2].",
  "```ts",
  "const x = arr[9];",
  "```",
  "Inline `a[7]` is code too.",
  "## Open questions",
  "None.",
  "## Sources",
  "[1] src/retry.ts:10-20",
  "[2] https://example.com/backoff",
].join("\n");

const SOURCES = [
  { id: "1", kind: "file", ref: "src/retry.ts:10-20", title: "retry" },
  { id: "2", kind: "url", ref: "https://example.com/backoff" },
];

const ALL = { code: true, feedbackGraph: true, web: true };

const input = (over: Partial<ResearchCheckInput> = {}): ResearchCheckInput => ({
  artifacts: {
    document: { text: DOC, artifactId: "art_doc" },
    sources: { text: JSON.stringify(SOURCES), artifactId: "art_src" },
  },
  allowed: ALL,
  lessonRefs: new Set(["lesson:l1"]),
  lineCount: (path) => Promise.resolve(path === "src/retry.ts" ? 40 : null),
  ...over,
});

const reasons = async (over: Partial<ResearchCheckInput> = {}) =>
  (await checkResearch(input(over))).failures.map((f) => `${f.gateId} ${f.reason}`);

describe("research gate rules", () => {
  it("passes a complete, cited document", async () => {
    expect(await reasons()).toEqual([]);
  });

  it("counts citations outside code only", () => {
    expect(citationIds(DOC).sort()).toEqual(["1", "2"]);
    expect(citationIds("Read items[0] and arr[3] and f(x)[4], see [a][5].")).toEqual([]);
    expect(citationIds("A [1](https://x.test) link is not a citation.")).toEqual([]);
    expect(citationIds("Lists [1, 2] and runs [3][4] count.").sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("refuses range citations with a message the agent can act on", async () => {
    const ranged = DOC.replace("[1][2]", "[1-2]");
    const r = await checkResearch(
      input({
        artifacts: {
          document: { text: ranged, artifactId: "d" },
          sources: input().artifacts.sources,
        },
      }),
    );
    expect(r.failures.map((f) => f.reason)).toEqual([
      "citation_range_unsupported:[1-2]: cite each source, as [1] or [1, 2]",
    ]);
  });

  it("fails empty sources and a document without citations", async () => {
    const bare = DOC.replace(/\[\d\]/g, "");
    expect(
      await reasons({
        artifacts: {
          document: { text: bare, artifactId: "d" },
          sources: { text: "[]", artifactId: "s" },
        },
      }),
    ).toEqual([`${RESEARCH_GATES.sources} no_sources`, `${RESEARCH_GATES.citations} no_citations`]);
  });

  it("does not read a heading across lines", async () => {
    const bareHeading = DOC.replace("## Open questions", "##\nOpen questions");
    expect(
      await reasons({
        artifacts: {
          document: { text: bareHeading, artifactId: "d" },
          sources: input().artifacts.sources,
        },
      }),
    ).toEqual([`${RESEARCH_GATES.document} section_missing:Open questions`]);
  });

  it("(a) needs the document and its four sections", async () => {
    expect(
      await reasons({ artifacts: { document: null, sources: input().artifacts.sources } }),
    ).toContain(`${RESEARCH_GATES.document} document_missing`);
    const noOpen = DOC.replace("## Open questions", "## Questions");
    expect(
      await reasons({
        artifacts: {
          document: { text: noOpen, artifactId: "a" },
          sources: input().artifacts.sources,
        },
      }),
    ).toEqual([`${RESEARCH_GATES.document} section_missing:Open questions`]);
  });

  it("(b) needs parseable sources and every citation resolved", async () => {
    expect(
      await reasons({
        artifacts: {
          document: input().artifacts.document,
          sources: { text: "{not json", artifactId: "s" },
        },
      }),
    ).toContain(`${RESEARCH_GATES.sources} sources_unparseable`);
    const extra = DOC.replace("[1][2]", "[1][2][3]");
    expect(
      await reasons({
        artifacts: {
          document: { text: extra, artifactId: "d" },
          sources: input().artifacts.sources,
        },
      }),
    ).toEqual([`${RESEARCH_GATES.citations} citation_unresolved:3`]);
  });

  it("(c) needs file sources that exist at the base commit with valid ranges", async () => {
    expect(await reasons({ lineCount: () => Promise.resolve(null) })).toEqual([
      `${RESEARCH_GATES.files} file_not_found:1`,
    ]);
    expect(await reasons({ lineCount: () => Promise.resolve(15) })).toEqual([
      `${RESEARCH_GATES.files} line_range_invalid:1`,
    ]);
    const noRepo = input();
    delete noRepo.lineCount;
    expect((await checkResearch(noRepo)).failures.map((f) => f.reason)).toEqual([
      "file_unverifiable:1:no_base_commit",
    ]);
    expect(parseFileRef("../etc/passwd:1")).toBeNull();
    expect(parseFileRef("/abs/path.ts:1")).toBeNull();
    expect(parseFileRef("src/a.ts:5-2")).toBeNull();
    expect(parseFileRef("./src/a.ts:5")).toEqual({ path: "src/a.ts", start: 5, end: 5 });
  });

  it("(d) allows web and lesson sources only when the request did", async () => {
    expect(await reasons({ allowed: { ...ALL, web: false } })).toEqual([
      `${RESEARCH_GATES.policy} web_not_allowed:2`,
    ]);
    const withLesson = [...SOURCES, { id: "3", kind: "lesson", ref: "lesson:l1" }];
    const src = { text: JSON.stringify(withLesson), artifactId: "s" };
    const docs = input().artifacts.document;
    expect(await reasons({ artifacts: { document: docs, sources: src } })).toEqual([]);
    expect(
      await reasons({
        artifacts: { document: docs, sources: src },
        allowed: { ...ALL, feedbackGraph: false },
      }),
    ).toEqual([`${RESEARCH_GATES.policy} lesson_not_allowed:3`]);
    const unknown = [...SOURCES, { id: "3", kind: "lesson", ref: "lesson:zz" }];
    expect(
      await reasons({
        artifacts: { document: docs, sources: { text: JSON.stringify(unknown), artifactId: "s" } },
      }),
    ).toEqual([`${RESEARCH_GATES.policy} lesson_unknown:3`]);
    const badUrl = [SOURCES[0], { id: "2", kind: "url", ref: "ftp://example.com/x" }];
    expect(
      await reasons({
        artifacts: { document: docs, sources: { text: JSON.stringify(badUrl), artifactId: "s" } },
      }),
    ).toEqual([`${RESEARCH_GATES.policy} url_invalid:2`]);
  });
});

const RESEARCH_WORK: PlanWorkView = {
  kind: "research",
  research: {
    sources: { code: true, feedbackGraph: true, web: true },
    factCheck: true,
    question: "Q?",
  },
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
            title: "Retry scheduling",
            intakeId: null,
            acceptanceCriteria: [{ id: "AC-1", text: "Answer it", verification: "manual" }],
          }
        : undefined,
    ),
  intake: () => Promise.resolve(undefined),
};

function researchWorld(opts: { document?: string; review?: unknown } = {}) {
  const plan = planView(
    [
      planTaskView("research", {
        role: "investigator",
        lessonContext: [{ id: "fg:l1", title: "t", text: "x" }],
      }),
      planTaskView("fact-check", { role: "reviewer", dependsOn: ["research"] }),
    ],
    {
      work: RESEARCH_WORK,
      guidance: {
        skills: [{ id: "skl_a", name: "a", digest: "f".repeat(64), content: "secret skill text" }],
        omitted: [],
        projectNotes: "",
        requestNotes: "Be brief",
        projectNotesDigest: null,
        requestNotesDigest: "e".repeat(64),
      },
    },
  );
  const w = new FakeDeliveryWorld(plan);
  w.addTask("research", "mt_res", "crw_inv", { template: "investigator" });
  w.addTask("fact-check", "mt_fc", "crw_rev", { template: "reviewer" });
  w.event(
    "git.worktree_created",
    { worktreeId: "wt_1", path: "/wt", branch: "mimir/mt_res", baseSha: BASE_SHA },
    { taskId: "mt_res" },
  );
  w.artifact("mt_res", "report", opts.document ?? DOC, { name: "research.md" });
  const withLesson = [...SOURCES, { id: "3", kind: "lesson", ref: "lesson:l1" }];
  w.artifact("mt_res", "file", JSON.stringify(withLesson), { name: "sources.json" });
  w.artifact(
    "mt_fc",
    "review",
    JSON.stringify(
      opts.review ?? {
        verdict: "approve",
        findings: [{ severity: "minor", message: "Claim [1] is slightly overstated" }],
        acceptance: [{ criterionId: "AC-1", satisfied: true }],
      },
    ),
    { name: "review.json" },
  );
  const seen: { commit: string; path: string }[] = [];
  const repo: RepoReader = {
    lineCount: (_p, commit, path) => {
      seen.push({ commit, path });
      return Promise.resolve(path === "src/retry.ts" ? 40 : null);
    },
  };
  const db = openDeliveryTestDb();
  const gates = new GateRunner({
    db,
    executions: w,
    mimir: w,
    content: w,
    repo,
    gatesFor: (task) =>
      task.role === "investigator"
        ? [{ id: "research", kind: "research" }]
        : task.role === "reviewer"
          ? [{ id: "review-verdict", kind: "review-artifact" }]
          : ([] as GateSpec[]),
  });
  const provider = new FakeProvider(() => {
    throw new Error("research reports call no model");
  });
  const reports = new DeliveryReports({
    db,
    executions: w,
    mimir: w,
    content: w,
    context,
    provider,
    gates,
    reviews: { list: () => [] },
  });
  return { w, gates, reports, seen };
}

describe("research delivery", () => {
  it("skips Brokkr, checks the document at the base commit, and passes", async () => {
    const { w, gates, seen } = researchWorld();
    const r = await gates.evaluate(w.executionId, "research");
    expect(r).toMatchObject({ passed: true, engineering: null, failures: [] });
    expect(seen).toEqual([{ commit: BASE_SHA, path: "src/retry.ts" }]);
    expect((await gates.evaluate(w.executionId, "fact-check")).passed).toBe(true);
  });

  it("fails the gate on a broken document", async () => {
    const { w, gates } = researchWorld({ document: "## Answer\nIt is fast [9]." });
    const r = await gates.evaluate(w.executionId, "research");
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.reason)).toEqual(
      expect.arrayContaining(["section_missing:Findings", "citation_unresolved:9"]),
    );
  });

  it("reports the document, private lesson sources, fact-check and guidance used", async () => {
    const { w, gates, reports } = researchWorld();
    await gates.evaluate(w.executionId, "research");
    await gates.evaluate(w.executionId, "fact-check");
    const report = await reports.build(w.executionId);
    expect(report.workKind).toBe("research");
    expect(report.summary).toEqual({ sentences: [], stripped: [] });
    expect(report.research).toMatchObject({
      question: "Q?",
      document: { markdown: DOC },
      containsPrivateSources: true,
      gate: { passed: true, failures: [] },
      factCheck: {
        planTaskId: "fact-check",
        verdict: "approve",
        findings: [expect.objectContaining({ severity: "minor" })],
        gatePassed: true,
      },
      decision: null,
    });
    expect(report.research!.sources.find((s) => s.id === "3")).toEqual({
      id: "3",
      kind: "lesson",
      ref: "lesson:l1",
      private: true,
    });
    expect(report.research!.sources.find((s) => s.id === "1")!.private).toBeUndefined();
    expect(report.guidance).toEqual({
      skills: [{ id: "skl_a", name: "a", digest: "f".repeat(64) }],
      omitted: [],
      projectNotes: "",
      requestNotes: "Be brief",
      projectNotesDigest: null,
      requestNotesDigest: "e".repeat(64),
    });
    expect(JSON.stringify(report)).not.toContain("secret skill text");
  });

  it("refuses a PR and records one final accept or reject decision", async () => {
    const { w, gates, reports } = researchWorld();
    await expect(reports.requestPr(w.executionId)).rejects.toMatchObject({
      code: "not_exportable",
    });
    await expect(
      reports.decide(w.executionId, { decision: "accepted", actor: "jacob" }),
    ).rejects.toMatchObject({ code: "gates_not_passed" });
    await gates.evaluate(w.executionId, "research");
    await gates.evaluate(w.executionId, "fact-check");
    const accepted = await reports.decide(w.executionId, { decision: "accepted", actor: "jacob" });
    expect(accepted.research!.decision).toMatchObject({ decision: "accepted", actor: "jacob" });
    expect(reports.latestFor(w.executionId)!.research!.decision!.decision).toBe("accepted");
    const again = await reports
      .decide(w.executionId, { decision: "rejected", actor: "jacob", reason: "no" })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DeliveryError);
    expect((again as DeliveryError).code).toBe("already_decided");
  });

  it("lets a human reject a document whose gates failed", async () => {
    const { w, gates, reports } = researchWorld({ document: "nothing" });
    await gates.evaluate(w.executionId, "research");
    const rejected = await reports.decide(w.executionId, {
      decision: "rejected",
      actor: "jacob",
      reason: "Missing sections",
    });
    expect(rejected.research!.decision).toMatchObject({
      decision: "rejected",
      reason: "Missing sections",
    });
  });
});
