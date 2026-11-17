// Work kinds: labels and form logic, the Sindri routes they use, and the delivery summaries the
// snapshot carries for research documents and PR reviews.
import test from "node:test";
import assert from "node:assert/strict";
import { statuses } from "@factory/docs";
import { commandRoute } from "../apps/server/commands.mjs";
import { listedWork } from "../apps/server/connectors.mjs";
import { workDetail } from "../apps/server/main.mjs";
import {
  docSources,
  findingParts,
  shortLocation,
  kindBadge,
  kindOf,
  leakCheckOf,
  pendingDocuments,
  commandErrorText,
  documentWaiting,
  findingCounts,
  gateResult,
  postedUrl,
  researchChecksPassed,
  prReviewBlock,
  prReviewBody,
  projectCandidates,
  researchBlock,
  researchBody,
  reviewDraft,
  localOnlyOf,
  webSourceBlock,
  isWorkKind,
  RESEARCH_DECISIONS,
  REVIEW_POST_STATES,
  WORK_KINDS,
  detectProjects,
  planBlock,
  planBody,
  PLAN_TEXT_MAX_CHARS,
} from "../apps/web/src/features/workKinds.ts";
import { setup, until } from "./support.mjs";

test("known kinds have their own badge; a missing kind is a change and an unknown one is Other", () => {
  assert.equal(kindBadge("research").text, "Research");
  assert.equal(kindBadge("pr_review").text, "PR review");
  assert.equal(kindBadge(undefined).text, "Change");
  assert.deepEqual(
    [kindBadge("audit").text, kindBadge("audit").tone],
    ["Other", "neutral"],
  );
  assert.match(kindBadge("audit").hint, /audit/);
  assert.equal(kindBadge(42).text, "Other");
});

test("work kinds, research decisions and review posts match @factory/docs", () => {
  const documented = (domain) =>
    statuses
      .filter((s) => s.app === "heimdall" && s.domain === domain)
      .map((s) => s.value)
      .sort();
  assert.deepEqual(documented("work-kind"), [...WORK_KINDS].sort());
  assert.deepEqual(
    documented("research-decision"),
    [...RESEARCH_DECISIONS].sort(),
  );
  assert.deepEqual(documented("review-post"), [...REVIEW_POST_STATES].sort());
  assert.deepEqual(
    documented("work-kind").filter((k) => !isWorkKind(k)),
    [],
  );
});

test("the kind comes from the intake, the run's plan, or the delivery's plan", () => {
  const plans = [{ id: "pln_r", work: { kind: "research" } }];
  assert.equal(kindOf({ workKind: "pr_review" }), "pr_review");
  assert.equal(
    kindOf({ execution: { id: "e" }, plan: { work: { kind: "research" } } }),
    "research",
  );
  assert.equal(kindOf({ id: "e1", planId: "pln_r" }, plans), "research");
  const views = [{ execution: { id: "e2", planId: "pln_r" } }];
  assert.equal(kindOf({ id: "e2" }, plans, views), "research");
  assert.equal(kindOf({ id: "e3" }, plans, views), undefined);
});

const research = {
  projectId: "prj",
  question: "  Why are totals off?  ",
  background: "Seen in March",
  code: true,
  lessons: true,
  lessonsAvailable: false,
  web: false,
  factCheck: true,
  notes: "",
  skillIds: [],
};

test("a research question needs a project, a question and one usable source", () => {
  assert.equal(researchBlock(research), "");
  assert.equal(
    researchBlock({ ...research, projectId: "" }),
    "Choose a project first.",
  );
  assert.equal(
    researchBlock({ ...research, question: " " }),
    "Ask a question first.",
  );
  // Lessons do not count while the project has no lessons link.
  assert.equal(
    researchBlock({ ...research, code: false }),
    "Pick at least one source.",
  );
  assert.equal(
    researchBlock({ ...research, code: false, lessonsAvailable: true }),
    "",
  );
  assert.equal(
    researchBlock({ ...research, notes: "é".repeat(4097) }),
    "Notes are too long.",
  );
  assert.match(
    researchBlock({ ...research, question: "q".repeat(501) }),
    /Keep the question to 500 characters \(it has 501\)/,
  );
  assert.equal(
    researchBlock({ ...research, question: ` ${"q".repeat(500)} ` }),
    "",
  );
  const skills = (n) => Array.from({ length: n }, (_, i) => "sk" + i);
  assert.equal(researchBlock({ ...research, skillIds: skills(20) }), "");
  assert.equal(
    researchBlock({ ...research, skillIds: skills(21) }),
    "Choose at most 20 skills (21 selected).",
  );
});

test("the research body sends lessons only when linked, and notes and skills only when set", () => {
  assert.deepEqual(researchBody(research), {
    projectId: "prj",
    title: "Why are totals off?",
    body: "Seen in March",
    workKind: "research",
    research: {
      sources: { code: true, feedbackGraph: false, web: false },
      factCheck: true,
    },
  });
  const linked = researchBody({
    ...research,
    lessonsAvailable: true,
    web: true,
    factCheck: false,
    notes: "Be brief",
    skillIds: ["sk1"],
  });
  assert.deepEqual(linked.research, {
    sources: { code: true, feedbackGraph: true, web: true },
    factCheck: false,
  });
  assert.equal(linked.notes, "Be brief");
  assert.deepEqual(linked.skillIds, ["sk1"]);
});

test("local-only mode disables the Web source and the body never asks for the web", () => {
  assert.equal(localOnlyOf({ localOnly: true }), true);
  assert.equal(localOnlyOf({ localOnly: false }), false);
  assert.equal(localOnlyOf(null), false);
  assert.match(webSourceBlock(true), /^Local-only mode is on/);
  assert.equal(webSourceBlock(false), "");
  const local = { ...research, web: true, localOnly: true };
  assert.equal(researchBody(local).research.sources.web, false);
  // The Web source alone does not count as a source in local-only mode.
  assert.equal(
    researchBlock({ ...local, code: false }),
    "Pick at least one source.",
  );
  assert.equal(
    researchBody({ ...local, localOnly: false }).research.sources.web,
    true,
  );
});

test("a PR review needs a github.com pull request URL, and a project once Sindri asked for one", () => {
  const pr = {
    url: "https://github.com/octo/widgets/pull/7",
    notes: "",
    skillIds: ["sk1"],
    candidates: null,
    pick: "",
  };
  assert.equal(prReviewBlock(pr), "");
  assert.equal(
    prReviewBlock({ ...pr, url: "" }),
    "Paste a pull request URL first.",
  );
  assert.equal(
    prReviewBlock({ ...pr, url: "https://gitlab.com/o/r/pull/1" }),
    "Use a github.com pull request URL.",
  );
  assert.equal(
    prReviewBlock({ ...pr, url: "https://github.com/o/r/issues/1" }),
    "Use a github.com pull request URL.",
  );
  assert.equal(
    prReviewBlock({ ...pr, url: "https://github.com/o/r/pull/1/files#diff" }),
    "",
  );
  const asked = { ...pr, candidates: [{ id: "a", name: "A" }] };
  assert.equal(prReviewBlock(asked), "Choose the project first.");
  assert.equal(
    prReviewBlock({
      ...pr,
      skillIds: Array.from({ length: 21 }, (_, i) => "s" + i),
    }),
    "Choose at most 20 skills (21 selected).",
  );
  assert.deepEqual(prReviewBody(pr), {
    url: pr.url,
    workKind: "pr_review",
    skillIds: ["sk1"],
  });
  assert.deepEqual(prReviewBody({ ...asked, pick: "a", url: ` ${pr.url} ` }), {
    url: pr.url,
    workKind: "pr_review",
    projectId: "a",
    skillIds: ["sk1"],
  });
});

test("project_required candidates are read flat or nested, else every project", () => {
  const all = [{ id: "p1", name: "One" }, { id: "p2" }];
  assert.deepEqual(
    projectCandidates({ candidates: [{ id: "x", name: "X" }] }, all),
    [{ id: "x", name: "X" }],
  );
  assert.deepEqual(projectCandidates({ projects: [{ id: "y" }] }, all), [
    { id: "y", name: "y" },
  ]);
  assert.deepEqual(projectCandidates([{ id: "z", name: "Z" }], all), [
    { id: "z", name: "Z" },
  ]);
  assert.deepEqual(projectCandidates(undefined, all), [
    { id: "p1", name: "One" },
    { id: "p2", name: "p2" },
  ]);
});

test("research sources line up with their citation numbers and keep lessons private", () => {
  const sources = docSources([
    { id: "3", kind: "lesson", ref: "lesson-9", title: "Round late" },
    { id: "1", kind: "file", ref: "src/total.ts:4" },
    { id: "2", kind: "mystery", ref: "somewhere" },
  ]);
  assert.deepEqual(
    sources.map((s) => [s.id, s.kind, !!s.private]),
    [
      ["1", "file", false],
      ["2", "url", false],
      ["3", "lesson", true],
    ],
  );
  assert.equal(
    docSources([
      { id: "1", kind: "url", ref: "a" },
      { id: "3", kind: "url", ref: "b" },
    ])[1].ref,
    "Source 2 is not listed",
  );
  assert.deepEqual(
    docSources([{ id: "web-a", kind: "url", ref: "x" }]).map((s) => s.id),
    ["web-a"],
  );
  assert.deepEqual(docSources(null), []);
});

test("the leak check is read in each shape Sindri may send, and missing is unknown", () => {
  assert.deepEqual(leakCheckOf({ leakCheck: { ok: true }, canPost: true }), {
    ok: true,
  });
  assert.deepEqual(
    leakCheckOf({
      leakCheck: {
        ok: false,
        rule: "private_tooling",
        findingId: "f2",
        field: "message",
      },
    }),
    {
      ok: false,
      rule: "private_tooling",
      findingId: "f2",
    },
  );
  assert.deepEqual(
    leakCheckOf({
      preview: { leakCheck: { ok: false, blocked: { rule: "secret:aws" } } },
    }),
    {
      ok: false,
      rule: "secret:aws",
    },
  );
  assert.equal(leakCheckOf({ payload: {} }), null);
  assert.equal(leakCheckOf(null), null);
});

test("a review shows the operator's draft over the agent's, and its posted URL when posted", () => {
  const review = {
    verdict: "request_changes",
    summary: "Agent",
    findings: [{ id: "a", severity: "major", message: "m", included: true }],
    draft: {
      verdict: "comment",
      summary: "Mine",
      findings: [{ id: "a", severity: "major", message: "m", included: false }],
    },
  };
  const d = reviewDraft(review);
  assert.equal(d.verdict, "comment");
  assert.equal(d.summary, "Mine");
  assert.equal(d.findings[0].included, false);
  assert.equal(
    reviewDraft({ verdict: "approve", summary: "s", findings: [] }).verdict,
    "approve",
  );
  assert.equal(postedUrl(review), null);
  assert.equal(
    postedUrl({ posted: { htmlUrl: "https://github.com/o/r/pull/1#r1" } }),
    "https://github.com/o/r/pull/1#r1",
  );
  assert.equal(postedUrl({}, { posted: { htmlUrl: "u" } }), "u");
  assert.equal(postedUrl({ postedUrl: "v" }), "v");
});

test("research checks pass only when every gate reported passed; failed ones leave reject or a follow-up", () => {
  assert.equal(researchChecksPassed({ gate: { passed: true } }), true);
  assert.equal(
    researchChecksPassed({
      gate: { passed: true },
      factCheck: { gatePassed: true },
    }),
    true,
  );
  assert.equal(
    researchChecksPassed({
      gate: { passed: true },
      factCheck: { gatePassed: null },
    }),
    false,
  );
  assert.equal(researchChecksPassed({ gate: null }), false);
  assert.equal(researchChecksPassed(undefined), false);
  assert.equal(
    documentWaiting({ kind: "research", title: null, gatePassed: true }),
    "Accept or reject",
  );
  assert.equal(
    documentWaiting({ kind: "research", title: null, gatePassed: false }),
    "Reject or ask a follow-up (checks failed)",
  );
  assert.equal(
    documentWaiting({ kind: "research", title: null }),
    "Reject or ask a follow-up (checks failed)",
  );
  assert.equal(
    documentWaiting({
      kind: "pr_review",
      title: null,
      verdict: "request_changes",
    }),
    "Posting in Sindri · Request changes",
  );
});

test("pending documents are undecided research and unposted reviews only", () => {
  const rows = [
    { id: "a", work: { kind: "research", decision: null } },
    { id: "b", work: { kind: "research", decision: "accepted" } },
    { id: "c", work: { kind: "pr_review", posted: false } },
    { id: "d", work: { kind: "pr_review", posted: true } },
    { id: "e", work: { kind: "audit" } },
    { id: "f" },
  ];
  assert.deepEqual(
    pendingDocuments(rows).map((r) => r.id),
    ["a", "c"],
  );
});

test("research decisions, follow-ups and PR imports route to Sindri with the approval factor", () => {
  const route = (action, body) => commandRoute({ action, id: "exe_1", body });
  const accept = route("research.accept", { reason: " looks right " });
  assert.deepEqual(
    [accept.source, accept.path, accept.approval, accept.body],
    ["sindri", "/v1/executions/exe_1/accept", true, { reason: "looks right" }],
  );
  assert.deepEqual(route("research.accept", { reason: "" }).body, {});
  // Accepting over the fact-check forwards the override, and only with a reason.
  assert.deepEqual(
    route("research.accept", { reason: "Our call", override: true, document: "plan" }).body,
    { reason: "Our call", override: true },
  );
  assert.throws(
    () => route("research.accept", { reason: " ", override: true }),
    /why you accept over the fact-check/,
  );
  assert.deepEqual(
    route("research.reject", { reason: "Wrong module", extra: 1 }).body,
    { reason: "Wrong module" },
  );
  assert.throws(
    () => route("research.reject", { reason: "  " }),
    /rejection reason/,
  );
  const follow = route("research.followUp", { question: " And refunds? " });
  assert.deepEqual(
    [follow.path, follow.body],
    ["/v1/executions/exe_1/follow-up", { question: "And refunds?" }],
  );
  assert.throws(() => route("research.followUp", {}), /follow-up question/);
  const imported = commandRoute({
    action: "intake.import",
    id: "new",
    body: { url: "u", workKind: "pr_review" },
  });
  assert.deepEqual(
    [imported.path, imported.body],
    ["/v1/intakes/import", { url: "u", workKind: "pr_review" }],
  );
  assert.throws(() =>
    commandRoute({ action: "research.accept", id: "../x", body: {} }),
  );
});

test("skills, guidance, GitHub status and review previews are the only work reads relayed", () => {
  assert.equal(workDetail("/api/details/skills"), "/v1/skills");
  assert.equal(workDetail("/api/details/github-status"), "/v1/github/status");
  assert.equal(
    workDetail("/api/details/guidance/prj_1"),
    "/v1/projects/prj_1/guidance",
  );
  assert.equal(
    workDetail("/api/details/review-preview/exe_1"),
    "/v1/executions/exe_1/review/preview",
  );
  assert.equal(workDetail("/api/details/guidance/../x"), null);
  assert.equal(workDetail("/api/details/review-preview/a/b"), null);
  assert.equal(workDetail("/api/details/skills/sk1"), null);
});

test("list summaries are trimmed to what lists show, and an unevaluated gate has not passed", () => {
  const work = (w) => ({
    work: {
      title: "T",
      decision: null,
      posted: false,
      postedUrl: "u",
      verdict: null,
      prUrl: "p",
      gatePassed: null,
      ...w,
    },
  });
  assert.deepEqual(
    listedWork(work({ decision: "accepted", gatePassed: true }), "research"),
    {
      kind: "research",
      title: "T",
      decision: "accepted",
      gatePassed: true,
      changesRequested: false,
      decidedAt: null,
      decidedBy: null,
      replacedBy: null,
    },
  );
  assert.equal(
    listedWork(work({ gatePassed: false, changesRequested: true }), "proposal")
      .changesRequested,
    true,
  );
  assert.equal(listedWork(work({}), "research").gatePassed, false);
  assert.equal(
    listedWork(work({ gatePassed: false }), "research").gatePassed,
    false,
  );
  assert.deepEqual(
    listedWork(work({ posted: true, verdict: "comment" }), "pr_review"),
    {
      kind: "pr_review",
      title: "T",
      posted: true,
      verdict: "comment",
    },
  );
  assert.equal(listedWork(work({}), "change"), null);
  assert.equal(listedWork({}, "research"), null);
  assert.equal(listedWork({ work: [] }, "research"), null);
});

test("refusals with details read plainly; anything else keeps the source's message", () => {
  assert.equal(
    commandErrorText({
      message: "x",
      code: "already_decided",
      details: { decision: { decision: "accepted", actor: "web" } },
    }),
    "This document was already accepted by web. The current decision is shown; nothing was changed.",
  );
  assert.match(
    commandErrorText({
      message: "x",
      code: "already_decided",
      details: { decision: "rejected" },
    }),
    /already rejected\./,
  );
  assert.equal(
    commandErrorText({
      message: "x",
      code: "pr_changed_since_plan",
      details: { planHead: "abcdef0123", currentHead: "9876543210" },
    }),
    "The pull request changed since this review was planned (planned at abcdef0, now at 9876543). Import the pull request again to review the new commits.",
  );
  assert.equal(
    commandErrorText({ message: "plain", code: "invalid_state" }),
    "plain",
  );
});

function workFixture(source) {
  source.workflow = {
    projects: [
      { id: "prj_demo", name: "Invoice library", repoPath: "/example/invoice" },
    ],
    specs: [],
    plans: [
      {
        id: "pln_r",
        projectId: "prj_demo",
        status: "approved",
        work: { kind: "research" },
        tasks: [],
      },
      {
        id: "pln_p",
        projectId: "prj_demo",
        status: "approved",
        work: { kind: "pr_review" },
        tasks: [],
      },
      {
        id: "pln_x",
        projectId: "prj_demo",
        status: "approved",
        work: { kind: "audit" },
        tasks: [],
      },
    ],
    intakes: [],
    deliveries: [
      {
        id: "exe_r",
        projectId: "prj_demo",
        planId: "pln_r",
        status: "verified_pending_review",
      },
      {
        id: "exe_p",
        projectId: "prj_demo",
        planId: "pln_p",
        status: "verified_pending_review",
      },
      {
        id: "exe_x",
        projectId: "prj_demo",
        planId: "pln_x",
        status: "verified_pending_review",
      },
    ],
  };
  source.work = {
    reports: {
      exe_r: {
        workKind: "research",
        research: { question: "Why?", decision: null, gate: { passed: true } },
      },
      exe_p: {
        workKind: "pr_review",
        review: {
          pr: { title: "Fix", url: "https://github.com/o/r/pull/1" },
          verdict: "comment",
          posted: null,
        },
      },
    },
    importCandidates: [{ id: "prj_demo", name: "Invoice library" }],
  };
}

test("the snapshot labels deliveries with their kind and keeps research and review summaries live", async (t) => {
  const { app, source, operator, call, key } = await setup(t);
  workFixture(source);
  await operator();
  const row = (id) => app.hub.state.sindri.deliveries.find((d) => d.id === id);
  await until(() => row("exe_r")?.work, "the research summary");
  assert.deepEqual(row("exe_r").work, {
    kind: "research",
    title: "Why?",
    decision: null,
    gatePassed: true,
    changesRequested: false,
    decidedAt: null,
    decidedBy: null,
    replacedBy: null,
  });
  assert.equal(row("exe_p").work.posted, false);
  assert.equal(row("exe_x").workKind, "audit");
  assert.equal(row("exe_x").work, undefined, "an unknown kind has no summary");

  const decide = await call(
    "commands",
    {
      action: "research.reject",
      id: "exe_r",
      body: { reason: "Wrong module" },
      reason: "Wrong module",
    },
    key(),
  );
  assert.equal(decide.status, 200);
  const sent = source.requests.find(
    (r) => r.path === "/v1/executions/exe_r/reject",
  );
  assert.equal(sent.headers["x-sindri-approval"], "sindri-human-secret");
  assert.deepEqual(JSON.parse(sent.body), { reason: "Wrong module" });
  await until(
    () => row("exe_r").work.decision === "rejected",
    "the decision in the snapshot",
  );
  // Deciding again is refused with the decision, which reaches the page.
  const again = await call(
    "commands",
    { action: "research.accept", id: "exe_r", body: {}, reason: "Second look" },
    key(),
  );
  assert.equal(again.status, 409);
  const refusal = await again.json();
  assert.equal(refusal.code, "already_decided");
  assert.equal(refusal.details.decision.decision, "rejected");

  // Posted in Sindri: the next list shows it.
  source.work.reports.exe_p.review.posted = {
    htmlUrl: "https://github.com/o/r/pull/1#review-9",
  };
  await app.hub.refresh();
  await until(() => row("exe_p").work.posted, "the posted review");
  // Lists come from Sindri's list rows; no delivery report is read for them.
  assert.equal(
    source.requests.filter((r) => r.path.startsWith("/v1/deliveries/")).length,
    0,
  );
});

test("summaries Sindri puts on its list rows are used without reading the report", async (t) => {
  const { app, source, operator } = await setup(t);
  workFixture(source);
  source.workflow.deliveries[0].workKind = "research";
  source.workflow.deliveries[0].work = {
    title: "Listed",
    decision: "accepted",
    gatePassed: true,
  };
  await operator();
  const row = () =>
    app.hub.state.sindri.deliveries.find((d) => d.id === "exe_r");
  await until(() => row()?.work, "the listed summary");
  assert.deepEqual(row().work, {
    kind: "research",
    title: "Listed",
    decision: "accepted",
    gatePassed: true,
    changesRequested: false,
    decidedAt: null,
    decidedBy: null,
    replacedBy: null,
  });
  await app.hub.refresh();
  assert.equal(
    source.requests.filter((r) => r.path === "/v1/deliveries/exe_r").length,
    0,
  );
});

test("a PR import that matches no single project returns Sindri's candidates to the form", async (t) => {
  const { source, operator, call, key } = await setup(t);
  workFixture(source);
  await operator();
  const body = {
    url: "https://github.com/octo/widgets/pull/7",
    workKind: "pr_review",
  };
  const refused = await call(
    "commands",
    { action: "intake.import", id: "new", body, reason: "Review it" },
    key(),
  );
  assert.equal(refused.status, 422);
  const answer = await refused.json();
  assert.equal(answer.code, "project_required");
  assert.deepEqual(answer.details.candidates, [
    { id: "prj_demo", name: "Invoice library" },
  ]);
  const chosen = await call(
    "commands",
    {
      action: "intake.import",
      id: "new",
      body: { ...body, projectId: "prj_demo" },
      reason: "Review it",
    },
    key(),
  );
  assert.equal(chosen.status, 200);
  assert.equal((await chosen.json()).result.intake.workKind, "pr_review");
});

test("skills, guidance, GitHub status and the review preview are relayed for a signed-in session", async (t) => {
  const { source, signIn, call } = await setup(t);
  source.work = {
    skills: [{ id: "sk1", name: "Security", token: "x" }],
    guidance: {
      prj_demo: {
        projectId: "prj_demo",
        notes: "n",
        defaultSkillIds: ["sk1"],
        updatedAt: null,
      },
    },
    previews: {
      exe_p: { leakCheck: { ok: true }, canPost: true, blockers: [] },
    },
  };
  await signIn();
  assert.deepEqual(await (await call("details/skills")).json(), {
    skills: [{ id: "sk1", name: "Security", token: "[redacted]" }],
  });
  assert.deepEqual(
    (await (await call("details/guidance/prj_demo")).json()).guidance
      .defaultSkillIds,
    ["sk1"],
  );
  assert.equal(
    (await (await call("details/review-preview/exe_p")).json()).canPost,
    true,
  );
  assert.equal((await call("details/review-preview/exe_none")).status, 404);
  source.work.localOnly = true;
  assert.equal(
    (await (await call("details/github-status")).json()).localOnly,
    true,
  );
});

const PROJECTS = [
  { id: "p-app", name: "invoice-app", repoPath: "/code/invoice-app" },
  { id: "p-docs", name: "DocsSite", repoPath: "/code/docs-site" },
  {
    id: "p-api",
    name: "billing",
    repoPath: "/code/billing-api",
    settings: { aliases: ["the ledger"] },
  },
  { id: "p-ui", name: "frontend", repoPath: "/code/frontend" },
];

test("a plan suggests the projects the text names, most mentioned first, everyday words weak", () => {
  const text = [
    "We need the invoice app to call billing; the Invoice-App team owns it.",
    "Update the docs site too. Talk to the ledger people. The frontend shows totals.",
  ].join("\n");
  const found = detectProjects(text, PROJECTS);
  assert.deepEqual(
    found.map((f) => f.projectId),
    ["p-app", "p-api", "p-docs", "p-ui"],
  );
  assert.equal(found[0].mentions, 2);
  assert.equal(found.find((f) => f.projectId === "p-ui").weak, true);
  assert.equal(found.find((f) => f.projectId === "p-app").weak, false);
  assert.deepEqual(detectProjects("rebilling and the abacus", PROJECTS), []);
});

test("a plan needs its project and text, and sends the other projects without its own", () => {
  const base = {
    projectId: "p-app",
    title: "",
    text: "Kickoff call\nShip the reports page.",
    referenceProjectIds: ["p-app", "p-docs", "p-docs"],
    web: true,
    localOnly: true,
    factCheck: true,
    notes: "",
    skillIds: [],
  };
  assert.match(planBlock({ ...base, projectId: "" }), /project/);
  assert.match(planBlock({ ...base, text: "  " }), /Paste/);
  assert.match(
    planBlock({ ...base, text: "x".repeat(PLAN_TEXT_MAX_CHARS + 1) }),
    /limit/,
  );
  assert.match(
    planBlock({
      ...base,
      referenceProjectIds: Array.from({ length: 9 }, (_, i) => `p${i}`),
    }),
    /at most 8/,
  );
  assert.equal(planBlock(base), "");
  assert.deepEqual(planBody(base), {
    projectId: "p-app",
    title: "Kickoff call",
    body: base.text,
    workKind: "proposal",
    proposal: {
      referenceProjectIds: ["p-docs"],
      sources: { code: true, web: false },
      factCheck: true,
    },
  });
});

test("a plan request goes to Sindri's intakes and drafts its spec", () => {
  const route = commandRoute({
    action: "intake.create",
    id: "new",
    body: {
      ...planBody({
        projectId: "p-app",
        title: "T",
        text: "x",
        referenceProjectIds: ["p-docs"],
        web: false,
        factCheck: false,
        notes: "",
        skillIds: [],
      }),
      thenDraft: true,
    },
  });
  assert.equal(route.path, "/v1/intakes");
  assert.equal(route.body.workKind, "proposal");
  assert.equal(route.body.thenDraft, undefined);
});

test("a plan delivery waits for a decision and is listed with its title", async () => {
  const { pendingDocuments, documentWaiting } =
    await import("../apps/web/src/features/workKinds.ts");
  const row = {
    work: {
      kind: "proposal",
      title: "Reports plan",
      decision: null,
      gatePassed: true,
    },
  };
  assert.equal(
    pendingDocuments([row, { work: { ...row.work, decision: "accepted" } }])
      .length,
    1,
  );
  assert.equal(documentWaiting(row.work), "Accept, reject or revise");
  assert.deepEqual(listedWork(row, "proposal"), {
    kind: "proposal",
    title: "Reports plan",
    decision: null,
    gatePassed: true,
    changesRequested: false,
    decidedAt: null,
    decidedBy: null,
    replacedBy: null,
  });
});

test("a fact-check that asked for changes is not shown as a failed check", () => {
  const changes = {
    gateId: "review-verdict",
    reason: "review_request_changes",
  };
  assert.equal(gateResult({ passed: true, failures: [] }), "passed");
  assert.equal(
    gateResult({ passed: false, failures: [changes] }),
    "request_changes",
  );
  assert.equal(
    gateResult({
      passed: false,
      failures: ["review_request_changes:blocking_finding"],
    }),
    "request_changes",
  );
  // Anything else that failed with it, or a failure with no reason, is a real failure.
  assert.equal(
    gateResult({
      passed: false,
      failures: [changes, { reason: "too_few_diagrams:0" }],
    }),
    "failed",
  );
  assert.equal(gateResult({ passed: false, failures: [] }), "failed");
  assert.equal(
    documentWaiting({
      kind: "proposal",
      title: null,
      gatePassed: false,
      changesRequested: true,
    }),
    "Reject or revise (fact-check asked for changes)",
  );
  assert.equal(
    documentWaiting({ kind: "proposal", title: null, gatePassed: false }),
    "Reject or revise (checks failed)",
  );
  assert.equal(
    findingCounts([
      { severity: "info" },
      { severity: "major" },
      { severity: "minor" },
      { severity: "major" },
      "junk",
    ]),
    "2 major · 1 minor · 1 info",
  );
  assert.equal(findingCounts(undefined), "");
  // The badge value has a label of its own in the shared vocabulary.
  assert.ok(JSON.stringify(statuses).includes("request_changes"));
});

test("a fact-check finding's fix reads apart, and its location drops the run's input folders", () => {
  assert.deepEqual(findingParts("Week 1 is too big. Fix: move the export to week 2."), {
    problem: "Week 1 is too big.",
    fix: "move the export to week 2.",
  });
  assert.deepEqual(findingParts("No fix here."), { problem: "No fix here.", fix: null });
  assert.deepEqual(shortLocation({ file: ".mimir/inputs/proposal/proposal.md", line: 3 }), {
    short: "proposal.md:3",
    full: ".mimir/inputs/proposal/proposal.md:3",
  });
  assert.equal(shortLocation({ file: "a.md", placement: "general" }), null);
  assert.equal(shortLocation({}), null);
});

test("Documents lists decided plans and research, newest first; context links are checked", async () => {
  const { decidedDocuments, contextFromQuery, contextField } = await import(
    "../apps/web/src/features/workKinds.ts"
  );
  const row = (id, kind, decision, decidedAt) => ({
    executionId: id,
    work: { kind, title: id, decision, decidedAt },
  });
  const rows = [
    row("a", "proposal", "accepted", "2026-11-14T10:00:00Z"),
    row("b", "research", "accepted", "2026-11-17T08:00:00Z"),
    row("c", "proposal", "rejected", "2026-11-16T08:00:00Z"),
    row("d", "proposal", null, null),
    row("e", "pr_review", "accepted", "2026-11-17T09:00:00Z"),
  ];
  assert.deepEqual(decidedDocuments(rows).map((r) => r.executionId), ["b", "a"]);
  assert.deepEqual(
    decidedDocuments(rows, { rejected: true }).map((r) => r.executionId),
    ["b", "c", "a"],
  );
  assert.deepEqual(contextFromQuery("?context=exe_1,exe_2,../x,exe_1"), ["exe_1", "exe_2"]);
  assert.deepEqual(contextField([]), {});
  assert.deepEqual(contextField(["a", "b", "c", "d", "e", "f"]).contextExecutionIds.length, 5);
});

test("a plan replaced by a decided revision waits for nothing and says so", async () => {
  const { pendingDocuments, documentDecision, decidedDocuments } = await import(
    "../apps/web/src/features/workKinds.ts"
  );
  const old = { executionId: "exe_v1", work: { kind: "proposal", title: "v1", decision: null, replacedBy: "exe_v2" } };
  const open = { executionId: "exe_v3", work: { kind: "proposal", title: "v3", decision: null, replacedBy: null } };
  assert.deepEqual(pendingDocuments([old, open]).map((d) => d.executionId), ["exe_v3"]);
  assert.deepEqual(documentDecision([old], "exe_v1"), {
    kind: "proposal",
    decision: "replaced",
    replacedBy: "exe_v2",
  });
  assert.equal(documentDecision([open], "exe_v3"), null);
  // On Documents only with "Show rejected and replaced".
  assert.equal(decidedDocuments([old]).length, 0);
  assert.equal(decidedDocuments([old], { rejected: true }).length, 1);
});

test("Results lists finished work newest first; In progress and Next step see decided plans as done", async () => {
  const { results } = await import("../apps/web/src/features/workKinds.ts");
  const { recordOutcome, nextStep } = await import("../apps/web/src/features/workflowState.ts");
  const deliveries = [
    { executionId: "exe_plan", planId: "pln_1", status: "verified_pending_review", workKind: "proposal",
      work: { kind: "proposal", title: "Plan", decision: "accepted", decidedAt: "2026-11-17T08:00:00Z" } },
    { executionId: "exe_old", planId: "pln_0", status: "verified_pending_review", workKind: "proposal",
      work: { kind: "proposal", title: "Old", decision: null, replacedBy: "exe_plan" } },
    { executionId: "exe_fix", status: "delivered_pending_merge", workKind: "change", work: null, updatedAt: "2026-11-16T08:00:00Z" },
    { executionId: "exe_rev", status: "verified_pending_review", workKind: "pr_review", work: { kind: "pr_review", title: "PR", posted: false } },
  ];
  assert.deepEqual(
    results(deliveries).map((r) => [r.executionId, r.outcome]),
    [["exe_plan", "Plan accepted"], ["exe_fix", "PR opened"]],
  );
  const lists = {
    intakes: [{ id: "int_1" }],
    specs: [{ id: "spc_1", intakeId: "int_1", status: "approved" }],
    plans: [{ id: "pln_1", specId: "spc_1", status: "approved" }],
    deliveries,
  };
  for (const [kind, row] of [["intakes", lists.intakes[0]], ["specs", lists.specs[0]], ["plans", lists.plans[0]]])
    assert.deepEqual(recordOutcome(kind, row, lists), { kind: "proposal", decision: "accepted", executionId: "exe_plan" });
  // The accepted plan's run is still verified_pending_review, but nothing waits on it.
  const executions = [{ execution: { id: "exe_plan", planId: "pln_1", status: "verified_pending_review" } }];
  assert.notEqual(nextStep({ ...lists, executions })?.page, "quality-approvals");
});
