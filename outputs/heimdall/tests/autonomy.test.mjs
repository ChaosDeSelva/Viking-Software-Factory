// Steward (Autonomy page) and Feedback Graph: command routes, read handlers and pure view logic.
import test from "node:test";
import assert from "node:assert/strict";
import { commandRoute, decisionNeedsApproval } from "../apps/server/commands.mjs";
import { stewardDetail } from "../apps/server/main.mjs";
import { setup } from "./support.mjs";
import {
  acceptBody,
  acceptIsApproval,
  clearLinkBlock,
  confidenceLabel,
  decisionQuery,
  entryActions,
  feedbackGraphSummary,
  filterDecisions,
  filterNotes,
  linkBlock,
  linkLabel,
  modeBlock,
  modeLabel,
  runningLabel,
  statusLabel,
  stewardProjects,
  trackRecord,
  typeLabel,
} from "../apps/web/src/features/autonomyState.ts";

const route = (action, body = {}, extra = {}) => commandRoute({ action, id: "item", body, ...extra });
const summary = (r) => `${r.source} ${r.method} ${r.path} approval=${r.approval}`;

test("steward and Feedback Graph actions map to Sindri routes with methods and the approval factor", () => {
  const expected = {
    "steward.mode": ["sindri PUT /v1/steward/modes approval=true", { type: "spec.answer", mode: "auto" }],
    "steward.pause": ["sindri POST /v1/steward/pause approval=false", {}],
    "steward.resume": ["sindri POST /v1/steward/resume approval=false", {}],
    "steward.reject": ["sindri POST /v1/steward/decisions/item/reject approval=false", { reason: "wrong" }],
    "steward.rollback": ["sindri POST /v1/steward/decisions/item/rollback approval=false", { reason: "undo" }],
    "steward.note": ["sindri POST /v1/steward/decisions/item/notes approval=false", { text: "hi" }],
    "steward.globalNote": ["sindri POST /v1/steward/notes approval=false", { projectId: null, text: "hi" }],
    "project.feedbackGraph": ["sindri PUT /v1/projects/item/feedback-graph approval=false", { projectKey: "demo-app" }],
  };
  for (const [action, [want, body]] of Object.entries(expected)) {
    const r = route(action, body);
    assert.equal(summary(r), want, action);
    assert.deepEqual(r.body, body, action);
    assert.throws(() => commandRoute({ action, id: "../escape", body }), action);
  }
  // Non-steward Sindri controls carry the approval secret; Mimir controls do not.
  assert.equal(route("spec.submit").approval, true);
  assert.equal(route("mission.pause").approval, false);
});

test("accepting carries the approval factor only for approval types; unknown types count as approvals", () => {
  const accept = (decisionType, body = {}) => route("steward.accept", body, { decisionType });
  assert.equal(summary(accept("spec.answer")), "sindri POST /v1/steward/decisions/item/accept approval=false");
  assert.equal(accept("spec.approve").approval, true);
  assert.equal(accept("plan.approve").approval, true);
  assert.equal(accept("escalation.resolve").approval, false);
  assert.equal(accept("delivery.export").approval, true);
  assert.equal(decisionNeedsApproval("rework.suggest"), false);
  // Only the answer is forwarded; the type is Heimdall's check, not part of Sindri's body.
  assert.deepEqual(accept("spec.answer", { value: "Half to even", extra: 1 }).body, { value: "Half to even" });
  assert.deepEqual(accept("spec.answer").body, {});
  assert.throws(() => route("steward.accept", {}), /decision type is required/);
  assert.throws(() => accept("spec.answer", { value: "  " }), /answer is required/);
});

test("steward bodies are validated before anything reaches Sindri", () => {
  assert.throws(() => route("steward.mode", { type: "spec.answer", mode: "always" }), /Unknown steward mode/);
  assert.throws(() => route("steward.mode", { type: "../x", mode: "off" }), /Invalid decision type/);
  assert.throws(() => route("steward.rollback", {}), /rollback reason is required/);
  assert.throws(() => route("steward.rollback", { reason: " " }), /rollback reason is required/);
  assert.throws(() => route("steward.note", { text: "" }), /Note text is required/);
  assert.throws(() => route("steward.globalNote", { projectId: "../x", text: "t" }), /Invalid project ID/);
  assert.deepEqual(route("steward.globalNote", { projectId: "prj_demo", text: "t" }).body, { projectId: "prj_demo", text: "t" });
  assert.deepEqual(route("project.feedbackGraph", { projectKey: null }).body, { projectKey: null });
  assert.deepEqual(route("project.feedbackGraph", {}).body, { projectKey: null });
  assert.throws(() => route("project.feedbackGraph", { projectKey: "" }), /Feedback Graph project key/);
  assert.deepEqual(route("steward.reject", { reason: "" }).body, {});
});

test("read paths map to Sindri and only known, well-formed query parameters pass", () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(stewardDetail("/api/details/steward/status", q("")), "/v1/steward/status");
  assert.equal(
    stewardDetail("/api/details/steward/decisions", q("projectId=prj_demo&type=spec.answer&status=pending&limit=50&before=2026-01-01T00:00:00.000Z&evil=1")),
    "/v1/steward/decisions?projectId=prj_demo&type=spec.answer&status=pending&limit=50&before=2026-01-01T00%3A00%3A00.000Z",
  );
  assert.equal(stewardDetail("/api/details/steward/decisions", q("type=")), "/v1/steward/decisions");
  assert.equal(stewardDetail("/api/details/steward/decisions/dec_1", q("")), "/v1/steward/decisions/dec_1");
  assert.equal(stewardDetail("/api/details/steward/notes", q("projectId=prj_demo")), "/v1/steward/notes?projectId=prj_demo");
  assert.equal(stewardDetail("/api/details/feedback-graph", q("")), "/v1/feedback-graph/status");
  assert.equal(stewardDetail("/api/details/feedback-graph/prj_demo", q("")), "/v1/projects/prj_demo/feedback-graph");
  assert.equal(stewardDetail("/api/details/specs/spc_1", q("")), null);
  assert.equal(stewardDetail("/api/details/feedback-graph/..%2Fx", q("")), null);
  for (const bad of ["projectId=../x", "limit=0", "limit=500", "type=a%26b"])
    assert.throws(() => stewardDetail("/api/details/steward/decisions", q(bad)), (e) => e.status === 400, bad);
});

const decision = (over = {}) => ({
  id: "dec_answer",
  projectId: "prj_demo",
  type: "spec.answer",
  subject: { kind: "question", id: "q-1", label: "Rounding" },
  inputs: [],
  recommendation: { value: "Half to even" },
  reasoning: "The ledger does.",
  confidence: 0.8,
  mode: "recommend",
  status: "pending",
  outcome: null,
  reversible: false,
  notes: [],
  createdAt: "2026-11-01T10:00:00.000Z",
  decidedAt: null,
  ...over,
});
function seed(source) {
  source.steward = {
    running: true,
    types: [
      { type: "spec.answer", mode: "recommend", autoAllowed: true, stats: {} },
      { type: "spec.approve", mode: "recommend", autoAllowed: false, stats: {} },
    ],
    decisions: [
      decision(),
      decision({ id: "dec_approve", type: "spec.approve", subject: { kind: "spec", id: "spc_1", label: "Spec" } }),
    ],
    notes: [],
  };
  source.feedbackGraph = {
    status: { configured: true, enabled: true, url: "http://127.0.0.1:8787", reachable: true, error: null },
    projects: {
      prj_demo: {
        auto: "invoice",
        link: { projectKey: "invoice", source: "auto" },
        lessons: [{ id: "l1", title: "Keep cents", rule: "Integer cents", appliesWhen: null, paths: [], status: "approved" }],
        error: null,
      },
    },
  };
}

test("details handlers read the steward and Feedback Graph through Heimdall's session", async (t) => {
  const { source, call, signIn } = await setup(t);
  seed(source);
  assert.equal((await call("details/steward/status")).status, 401);
  await signIn();
  const status = await (await call("details/steward/status")).json();
  assert.equal(status.running, true);
  assert.equal(status.feedbackGraph.reachable, true);
  const { decisions } = await (await call("details/steward/decisions?type=spec.approve")).json();
  assert.deepEqual(decisions.map((d) => d.id), ["dec_approve"]);
  assert.ok(source.requests.some((r) => r.path === "/v1/steward/decisions?type=spec.approve"));
  assert.equal((await (await call("details/steward/decisions/dec_answer")).json()).decision.type, "spec.answer");
  assert.equal((await call("details/steward/decisions/nope")).status, 404);
  assert.equal((await call("details/steward/decisions?limit=9999")).status, 400);
  assert.deepEqual(await (await call("details/steward/notes?projectId=prj_demo")).json(), { notes: [] });
  assert.equal((await (await call("details/feedback-graph")).json()).configured, true);
  const fg = await (await call("details/feedback-graph/prj_demo")).json();
  assert.deepEqual(fg.link, { projectKey: "invoice", source: "auto" });
  assert.equal(fg.lessons[0].rule, "Integer cents");
});

test("accept is checked against Sindri's decision type and carries the approval factor only when needed", async (t) => {
  const { source, call, operator, key } = await setup(t);
  seed(source);
  await operator();
  const accept = (id, decisionType, body = {}) =>
    call("commands", { action: "steward.accept", id, decisionType, reason: "Agree", body }, key());
  const sent = (path) => source.requests.filter((r) => r.method === "POST" && r.path === path);

  // A browser that calls an approval a plain answer is refused before anything is posted.
  const lie = await accept("dec_approve", "spec.answer");
  assert.equal(lie.status, 409);
  assert.match((await lie.json()).message, /not the type shown/);
  assert.equal(sent("/v1/steward/decisions/dec_approve/accept").length, 0);

  const approve = await accept("dec_approve", "spec.approve");
  assert.equal(approve.status, 200);
  const [approved] = sent("/v1/steward/decisions/dec_approve/accept");
  assert.equal(approved.headers["x-sindri-approval"], "sindri-human-secret");
  assert.equal((await approve.json()).result.decision.status, "accepted");

  const answer = await accept("dec_answer", "spec.answer", { value: "Half up" });
  assert.equal(answer.status, 200);
  const [answered] = sent("/v1/steward/decisions/dec_answer/accept");
  assert.equal(answered.headers["x-sindri-approval"], undefined);
  assert.deepEqual(JSON.parse(answered.body), { value: "Half up" });
  assert.equal(source.steward.decisions[0].status, "changed");
  assert.equal((await accept("missing", "spec.answer")).status, 404);
});

test("mode changes need the approval factor; other steward controls do not send it", async (t) => {
  const { source, call, operator, key } = await setup(t);
  seed(source);
  const cmd = (action, id, body) => call("commands", { action, id, reason: "Operator", body }, key());
  await operator({ pair: false });
  const unpaired = await cmd("steward.pause", "steward", {});
  assert.equal(unpaired.status, 403);
  assert.match((await unpaired.json()).message, /Pair with Sindri/);
  await operator();
  const mode = await cmd("steward.mode", "modes", { type: "spec.answer", mode: "auto" });
  assert.equal(mode.status, 200);
  const put = source.requests.find((r) => r.method === "PUT" && r.path === "/v1/steward/modes");
  assert.equal(put.headers["x-sindri-approval"], "sindri-human-secret");
  assert.deepEqual(JSON.parse(put.body), { type: "spec.answer", mode: "auto" });
  const refused = await cmd("steward.mode", "modes", { type: "spec.approve", mode: "auto" });
  assert.equal(refused.status, 422);
  assert.equal((await cmd("steward.pause", "steward", {})).status, 200);
  assert.equal(source.steward.running, false);
  const pause = source.requests.find((r) => r.path === "/v1/steward/pause");
  assert.equal(pause.headers["x-sindri-approval"], undefined);
  assert.equal((await cmd("steward.rollback", "dec_answer", { reason: "Undo" })).status, 409);
  source.steward.decisions[0] = decision({ status: "applied", reversible: true });
  assert.equal((await cmd("steward.rollback", "dec_answer", { reason: "Undo" })).status, 200);
  assert.equal(source.steward.decisions[0].status, "rolled_back");
  assert.equal((await cmd("steward.rollback", "dec_answer", {})).status, 400);
  assert.equal((await cmd("steward.note", "dec_answer", { text: "Prefer ledger rules" })).status, 200);
  assert.equal(source.steward.decisions[0].notes[0].text, "Prefer ledger rules");
  assert.equal((await cmd("steward.globalNote", "notes", { projectId: null, text: "Be careful" })).status, 200);
  assert.equal(source.steward.notes[0].projectId, null);
  const link = await cmd("project.feedbackGraph", "prj_demo", { projectKey: "demo-app" });
  assert.deepEqual((await link.json()).result.link, { projectKey: "demo-app", source: "override" });
  const linkPut = source.requests.find((r) => r.method === "PUT" && r.path === "/v1/projects/prj_demo/feedback-graph");
  assert.equal(linkPut.headers["x-sindri-approval"], undefined);
  assert.deepEqual(JSON.parse(linkPut.body), { projectKey: "demo-app" });
  const cleared = await cmd("project.feedbackGraph", "prj_demo", { projectKey: null });
  assert.deepEqual((await cleared.json()).result.link, { projectKey: "invoice", source: "auto" });
});

const paired = { operator: true, pairedSindri: true };
test("labels: known values are named, unknown ones are shown as sent", () => {
  assert.equal(modeLabel("auto"), "Automatic");
  assert.equal(modeLabel("turbo"), "turbo");
  assert.equal(typeLabel("spec.answer"), "Answer specification questions");
  assert.equal(typeLabel("delivery.export"), "delivery.export");
  assert.equal(statusLabel("rolled_back"), "Rolled back");
  assert.equal(statusLabel("superseded"), "superseded");
  assert.equal(statusLabel(undefined), "unknown");
  assert.equal(typeLabel("constructor"), "constructor");
  assert.equal(linkLabel("override"), "Set by the operator");
  assert.equal(linkLabel("guess"), "guess");
  assert.equal(runningLabel({ running: false }), "paused");
  assert.equal(runningLabel({ running: "yes" }), null);
  assert.equal(runningLabel(null), null);
  assert.equal(confidenceLabel(0.834), "83%");
  assert.equal(confidenceLabel(null), "not reported");
  assert.equal(acceptIsApproval("plan.approve"), true);
  assert.equal(acceptIsApproval("spec.answer"), false);
  assert.equal(acceptIsApproval("brand.new"), true);
});

test("mode gating: session first, then auto only where Sindri allows it", () => {
  const row = { type: "spec.answer", mode: "recommend", autoAllowed: true };
  assert.match(modeBlock(row, "auto", {}), /Unlock operator controls/);
  assert.match(modeBlock(row, "auto", { operator: true }), /Pair with Sindri/);
  assert.equal(modeBlock(row, "auto", paired), "");
  assert.equal(modeBlock(row, "off", paired), "");
  assert.match(modeBlock(row, "recommend", paired), /^Already/);
  assert.match(modeBlock({ ...row, type: "plan.approve", autoAllowed: false }, "auto", paired), /never automatic/);
  assert.match(modeBlock({ ...row, autoAllowed: false }, "auto", paired), /does not allow automatic/);
  assert.match(modeBlock({ ...row, autoAllowed: "yes" }, "auto", paired), /does not allow automatic/);
  assert.match(modeBlock({ ...row, mode: "turbo" }, "recommend", paired), /^$/);
  assert.match(modeBlock(row, "turbo", paired), /Unknown mode/);
});

test("entry actions: decide only pending ones, roll back only reversible applied ones", () => {
  const pending = entryActions(decision(), paired);
  assert.equal(pending.accept, "");
  assert.equal(pending.reject, "");
  assert.match(pending.rollback, /cannot be reversed/);
  assert.equal(pending.note, "");
  const applied = entryActions(decision({ status: "applied", reversible: true }), paired);
  assert.match(applied.accept, /awaiting you/);
  assert.equal(applied.rollback, "");
  assert.match(entryActions(decision({ status: "accepted", reversible: true }), paired).rollback, /Only an applied/);
  assert.match(entryActions(decision({ status: "mystery" }), paired).accept, /status is mystery/);
  const locked = entryActions(decision({ status: "applied", reversible: true }), {});
  for (const reason of Object.values(locked)) assert.match(reason, /Unlock operator/);
});

test("accept body sends an answer only when spec.answer was changed", () => {
  const d = decision();
  assert.deepEqual(acceptBody(d, "Half to even"), {});
  assert.deepEqual(acceptBody(d, " Half to even "), {});
  assert.deepEqual(acceptBody(d, "Half up "), { value: "Half up" });
  assert.deepEqual(acceptBody(d, null), {});
  assert.deepEqual(acceptBody(decision({ type: "spec.approve" }), "Other"), {});
});

test("decision filters follow the repository-keyed project selection", () => {
  const sindri = [
    { id: "prj_a", repoPath: "/r/a" },
    { id: "prj_a2", repoPath: "/r/a" },
    { id: "prj_b", repoPath: "/r/b" },
  ];
  assert.equal(stewardProjects("all", sindri), null);
  assert.deepEqual(stewardProjects("/r/a", sindri), ["prj_a", "prj_a2"]);
  assert.deepEqual(stewardProjects("prj_b", sindri), ["prj_b"]);
  assert.deepEqual(stewardProjects("/r/none", sindri), []);
  assert.equal(decisionQuery({ projectIds: ["prj_b"], type: "spec.answer", status: "" }), "details/steward/decisions?projectId=prj_b&type=spec.answer&limit=100");
  assert.equal(decisionQuery({ projectIds: ["prj_a", "prj_a2"], type: "", status: "pending" }), "details/steward/decisions?status=pending&limit=100");
  const rows = [
    decision({ id: "1", projectId: "prj_a" }),
    decision({ id: "2", projectId: "prj_a2", status: "applied" }),
    decision({ id: "3", projectId: "prj_b", type: "spec.approve" }),
  ];
  assert.deepEqual(filterDecisions(rows, { projectIds: ["prj_a", "prj_a2"], type: "", status: "" }).map((d) => d.id), ["1", "2"]);
  assert.deepEqual(filterDecisions(rows, { projectIds: null, type: "spec.approve", status: "" }).map((d) => d.id), ["3"]);
  assert.deepEqual(filterDecisions(rows, { projectIds: [], type: "", status: "" }), []);
  const notes = [{ projectId: null }, { projectId: "prj_a" }, { projectId: "prj_b" }];
  assert.deepEqual(filterNotes(notes, ["prj_a"]), [{ projectId: null }, { projectId: "prj_a" }]);
  assert.equal(filterNotes(notes, null).length, 3);
});

test("track record and Feedback Graph summaries degrade to plain text", () => {
  assert.deepEqual(trackRecord({ decided: 10, accepted: 7, changed: 1, rejected: 2, rolledBack: 0, autoApplied: 3, accuracy: 0.8 }), {
    decided: "10", accepted: "7", changed: "1", rejected: "2", rolledBack: "0", autoApplied: "3", accuracy: "80%",
  });
  assert.equal(trackRecord(undefined).accuracy, "No record yet");
  assert.equal(trackRecord({ decided: "x" }).decided, "—");
  assert.equal(feedbackGraphSummary(null).badge, "unknown");
  assert.equal(feedbackGraphSummary({ configured: false }).badge, "not configured");
  assert.equal(feedbackGraphSummary({ configured: true, enabled: false }).badge, "disabled");
  assert.equal(feedbackGraphSummary({ configured: true, enabled: true, reachable: true, url: "http://x" }).badge, "connected");
  const down = feedbackGraphSummary({ configured: true, enabled: true, reachable: false, error: "ECONNREFUSED" });
  assert.equal(down.badge, "unreachable");
  assert.match(down.text, /ECONNREFUSED/);
  assert.equal(feedbackGraphSummary({ configured: true, enabled: true, reachable: null }).badge, "not checked");
});

test("link override gating", () => {
  const auto = { projectKey: "invoice", source: "auto" };
  assert.match(linkBlock("x", auto, {}), /Unlock/);
  assert.match(linkBlock("x", null, paired), /not loaded/);
  assert.match(linkBlock(" ", auto, paired), /Enter a Feedback Graph project key/);
  assert.equal(linkBlock("demo-app", auto, paired), "");
  assert.match(linkBlock("demo-app", { projectKey: "demo-app", source: "override" }, paired), /already set/);
  assert.match(clearLinkBlock(auto, paired), /no operator override/);
  assert.equal(clearLinkBlock({ projectKey: "x", source: "override" }, paired), "");
  assert.match(clearLinkBlock({ source: "override" }, { operator: true }), /Pair with Sindri/);
});
