import { createServer } from "node:http";
/** Like Sindri's deliveries list: `workKind` and the `work` summary, built from the stored report. */
function listFields(row, report) {
  if (!report || row.work || !["research", "pr_review"].includes(report.workKind)) return row;
  const gates = (passed) => (passed.every((p) => p === true) ? true : passed.some((p) => p === false) ? false : null);
  if (report.workKind === "research") {
    const r = report.research;
    return {
      ...row,
      workKind: "research",
      work: {
        title: r.question ?? null,
        decision: r.decision?.decision ?? null,
        posted: false,
        postedUrl: null,
        verdict: null,
        prUrl: null,
        gatePassed: gates([r.gate?.passed ?? null, ...(r.factCheck ? [r.factCheck.gatePassed ?? null] : [])]),
      },
    };
  }
  const r = report.review;
  return {
    ...row,
    workKind: "pr_review",
    work: {
      title: r.pr?.title ?? null,
      decision: null,
      posted: !!r.posted,
      postedUrl: r.posted?.htmlUrl ?? null,
      verdict: r.draft?.verdict ?? null,
      prUrl: r.pr?.url ?? null,
      gatePassed: gates([r.gatePassed ?? null]),
    },
  };
}
export async function fixture() {
  const now = new Date().toISOString(),
    common = { createdAt: now, updatedAt: now, version: 1 };
  const data = {
    projects: [
      {
        ...common,
        id: "prj_demo",
        name: "Invoice library",
        repoPath: "/example/invoice",
      },
    ],
    missions: [
      {
        ...common,
        id: "msn_demo",
        projectId: "prj_demo",
        objective: "Build reliable invoice tools",
        status: "active",
      },
    ],
    crews: [
      {
        ...common,
        id: "crw_demo",
        missionId: "msn_demo",
        template: "Implementation crew",
        status: "running",
      },
    ],
    tasks: [
      {
        ...common,
        id: "tsk_demo",
        missionId: "msn_demo",
        crewId: "crw_demo",
        title: "Implement integer-cent totals",
        acceptance: "Reject negative quantities. Keep integer cents.",
        status: "running",
        attempt: 1,
        maxAttempts: 3,
        agentId: "agt_demo",
      },
      {
        ...common,
        id: "tsk_qa",
        missionId: "msn_demo",
        crewId: "crw_demo",
        title: "Review and verify totals",
        acceptance: "All regression tests pass.",
        status: "pending",
        attempt: 0,
        maxAttempts: 3,
      },
    ],
    taskDependencies: [
      { id: "dep_demo", taskId: "tsk_qa", dependsOnId: "tsk_demo" },
    ],
    agents: [
      {
        ...common,
        id: "agt_demo",
        crewId: "crw_demo",
        taskId: "tsk_demo",
        role: "implementer",
        agentKind: "codex",
        status: "running",
        runtimeSessionId: "ses_demo",
      },
    ],
    approvals: [
      {
        ...common,
        id: "apr_demo",
        missionId: "msn_demo",
        taskId: "tsk_demo",
        action: "runtime.command",
        reason: "A command requires operator approval",
        status: "pending",
      },
    ],
    worktrees: [],
    usage: {
      tokens: 12240,
      estimatedCost: 0,
      samples: 1,
      bySource: { unavailable: 1 },
    },
    cursor: "c0",
  };
  const streams = new Set(),
    requests = [];
  let disconnected = false,
    seq = 0;
  const server = createServer(async (req, res) => {
    const seen = { method: req.method, path: req.url, headers: req.headers };
    requests.push(seen);
    if (disconnected) {
      res.writeHead(503);
      res.end('{"message":"Source offline"}');
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-token") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/snapshot") return res.end(JSON.stringify(data));
    if (req.url === "/v1/attention" && req.method === "GET")
      return res.end(JSON.stringify({ items: api.attention }));
    // Like Mimir: new crew limits, then tasks held only by that budget are ready again.
    const budget = /^\/v1\/crews\/([\w-]+)\/budget$/.exec(req.url);
    if (budget && req.method === "PATCH") {
      let b = "";
      for await (const chunk of req) b += chunk;
      seen.body = b;
      if (await api.intercept?.(req, res, b)) return;
      const input = JSON.parse(b);
      const current = api.budgets[budget[1]] ?? { version: 0, limitTokens: null, limitCost: null };
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        res.writeHead(409);
        return res.end('{"error":{"code":"conflict","message":"budget version changed"}}');
      }
      const next = (api.budgets[budget[1]] = {
        ...current,
        ...("limitTokens" in input ? { limitTokens: input.limitTokens } : {}),
        ...("limitCost" in input ? { limitCost: input.limitCost } : {}),
        ...("onUnknown" in input ? { onUnknown: input.onUnknown } : {}),
        version: current.version + 1,
      });
      // Allowing unknown usage is what releases a budget_uncertain hold.
      const released = (t) =>
        t.blockedReason === "budget_exceeded" ||
        (t.blockedReason === "budget_uncertain" && next.onUnknown === "allow");
      for (const t of data.tasks)
        if (t.crewId === budget[1] && released(t))
          Object.assign(t, { status: "ready", blockedReason: undefined });
      return res.end(JSON.stringify({ budget: { id: "bgt_" + budget[1], crewId: budget[1], ...next }, changed: true }));
    }
    if (req.url.startsWith("/v1/events?"))
      return res.end(
        JSON.stringify({ events: [], hasMore: false, lastCursor: "c0" }),
      );
    if (req.url === "/v1/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    // Sindri planning records are opt-in: tests assign `workflow` to serve them.
    const flow = api.workflow;
    if (req.url === "/v1/projects")
      return res.end(
        JSON.stringify({ projects: flow?.projects ?? data.projects }),
      );
    const listed = /^\/v1\/(specs|plans|intakes|deliveries)\?projectId=(.+)$/.exec(
      req.url,
    );
    if (listed)
      return res.end(
        JSON.stringify({
          [listed[1]]: (flow?.[listed[1]] ?? [])
            .filter((r) => r.projectId === decodeURIComponent(listed[2]))
            .map((r) => (listed[1] === "deliveries" ? listFields(r, api.work?.reports?.[r.id]) : r)),
        }),
      );
    if (req.url.startsWith("/v1/executions?"))
      return res.end(
        JSON.stringify({
          executions: [
            ...(flow && !req.url.endsWith("=prj_demo") ? [] : [{ id: "exe_demo" }]),
            // Runs started while `workflow.authoring` is set, listed under their project.
            ...(flow?.authoring ? flow.runs ?? [] : [])
              .filter((r) => req.url.endsWith("=" + encodeURIComponent(r.projectId)))
              .map((r) => ({ id: r.view.execution.id })),
          ],
        }),
      );
    if (req.url === "/v1/executions/exe_demo")
      return res.end(JSON.stringify(api.execution));
    const tracked =
      flow?.authoring &&
      (flow.runs ?? []).find((r) => req.url === "/v1/executions/" + r.view.execution.id);
    if (tracked && req.method === "GET") return res.end(JSON.stringify(tracked.view));
    // Steward and Feedback Graph routes are opt-in: tests assign `steward` / `feedbackGraph`.
    if (
      (api.steward && req.url.startsWith("/v1/steward/")) ||
      (api.feedbackGraph && /^\/v1\/(feedback-graph\/status|projects\/[\w-]+\/feedback-graph)$/.test(req.url))
    ) {
      let b = "";
      for await (const chunk of req) b += chunk;
      seen.body = b;
      if (await api.intercept?.(req, res, b)) return;
      return autonomy(req, res, b ? JSON.parse(b) : {});
    }
    // Work kinds are opt-in: tests assign `work` to serve skills, guidance, research and PR
    // review reports, and to answer imports and document decisions.
    const work = api.work;
    if (work && req.method === "GET") {
      if (req.url === "/v1/skills") return res.end(JSON.stringify({ skills: work.skills ?? [] }));
      if (req.url === "/v1/github/status")
        return res.end(
          JSON.stringify({ enabled: true, configured: true, ghInstalled: true, localOnly: work.localOnly ?? false }),
        );
      const guidance = /^\/v1\/projects\/([\w-]+)\/guidance$/.exec(req.url);
      if (guidance)
        return res.end(
          JSON.stringify({
            guidance: work.guidance?.[guidance[1]] ?? { projectId: guidance[1], notes: "", defaultSkillIds: [], updatedAt: null },
          }),
        );
      const preview = /^\/v1\/executions\/([\w-]+)\/review\/preview$/.exec(req.url);
      if (preview && work.previews?.[preview[1]])
        return res.end(JSON.stringify(work.previews[preview[1]]));
      const report = /^\/v1\/deliveries\/([\w-]+)$/.exec(req.url);
      // `reportHook(id, res)` may delay or fail a report read; true means it answered.
      if (report && work.reports?.[report[1]] && (await work.reportHook?.(report[1], res))) return;
      if (report && work.reports?.[report[1]])
        return res.end(JSON.stringify({ deliveryService: "fixture", report: work.reports[report[1]], prDescription: "" }));
    }
    const profile = /^\/v1\/projects\/([\w-]+)\/profile$/.exec(req.url);
    if (profile && req.method === "GET")
      return res.end(JSON.stringify({ profile: api.profiles[profile[1]] ?? {} }));
    if (profile && req.method === "PUT") {
      let b = "";
      for await (const chunk of req) b += chunk;
      seen.body = b;
      if (req.headers["x-sindri-approval"] !== "sindri-human-secret") {
        res.writeHead(403);
        return res.end(
          '{"error":{"code":"approval_required","message":"approvals need a valid approval secret"}}',
        );
      }
      const saved = (api.profiles[profile[1]] = JSON.parse(b));
      return res.end(
        JSON.stringify({
          profile: saved,
          harness: saved.checks?.length
            ? { name: "sindri-fixture-1a2b3c4d", version: "1.0.0" }
            : null,
        }),
      );
    }
    const record = /^\/v1\/(specs|plans|intakes|deliveries)\/([\w-]+)(\/local)?$/.exec(
      req.url,
    );
    if (flow && record && req.method === "GET") {
      const [, kind, id, local] = record;
      const row = flow[kind].find((r) => r.id === id);
      if (!row) {
        res.writeHead(404);
        return res.end('{"error":{"code":"not_found","message":"not found"}}');
      }
      return res.end(
        JSON.stringify(
          local
            ? { result: flow.local ?? null }
            : kind === "specs"
              ? {
                  spec: row,
                  meta: flow.meta?.[row.lineageId] ?? {},
                  lineage: flow.specs
                    .filter((r) => r.lineageId === row.lineageId)
                    .map(({ id, version, status, title }) => ({
                      id,
                      version,
                      status,
                      title,
                    })),
                }
              : kind === "deliveries"
                ? { deliveryService: "fixture", report: { executionId: id } }
                : { [kind.slice(0, -1)]: row },
        ),
      );
    }
    if (
      req.url === "/v1/executions/exe_demo/events" ||
      (flow?.authoring &&
        (flow.runs ?? []).some(
          (r) => req.url === `/v1/executions/${r.view.execution.id}/events`,
        ))
    ) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "POST") {
      let b = "";
      for await (const chunk of req) b += chunk;
      seen.body = b;
      // Tests set `intercept` to answer a command themselves (slow, failing or refused).
      if (await api.intercept?.(req, res, b)) return;
      if (work) {
        const input = JSON.parse(b || "{}");
        const answer = (status, value) => {
          res.writeHead(status);
          res.end(JSON.stringify(value));
        };
        if (req.url === "/v1/intakes/import") {
          if (!input.projectId && work.importCandidates)
            return answer(422, {
              error: {
                code: "project_required",
                message: "no registered project has octo/widgets as a git remote; choose the project",
                details: { repo: "octo/widgets", candidates: work.importCandidates },
              },
            });
          const intake = {
            id: "int_pr" + String((work.imported = (work.imported ?? 0) + 1)),
            projectId: input.projectId ?? "prj_demo",
            title: "Review " + input.url,
            body: "",
            workKind: input.workKind,
          };
          flow?.intakes.push(intake);
          return answer(201, { intake });
        }
        const decide = /^\/v1\/executions\/([\w-]+)\/(accept|reject|follow-up)$/.exec(req.url);
        const report = decide && work.reports?.[decide[1]];
        if (report) {
          if (decide[2] === "follow-up") {
            const intake = {
              id: "int_follow" + decide[1],
              projectId: report.projectId ?? "prj_demo",
              title: input.question,
              body: "",
              workKind: "research",
              linkedExecutionId: decide[1],
            };
            flow?.intakes.push(intake);
            return answer(201, { intake });
          }
          if (req.headers["x-sindri-approval"] !== "sindri-human-secret")
            return answer(403, { error: { code: "approval_required", message: "approvals need a valid approval secret" } });
          if (report.research.decision)
            return answer(409, {
              error: { code: "already_decided", message: "this document was already decided", details: { decision: report.research.decision } },
            });
          report.research.decision = {
            decision: decide[2] === "accept" ? "accepted" : "rejected",
            actor: "web",
            reason: input.reason ?? null,
            decidedAt: new Date().toISOString(),
          };
          return answer(200, { report });
        }
      }
      if (req.url === "/v1/approval-session") {
        if (JSON.parse(b).pairingCode !== "sindri-code") {
          res.writeHead(403);
          return res.end('{"message":"Bad pairing code"}');
        }
        return res.end(
          JSON.stringify({
            approvalSecret: "sindri-human-secret",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
      }
      const act = /^\/v1\/(specs|plans)\/([\w-]+)\/(submit|approve|answer)$/.exec(
        req.url,
      );
      const target = act && flow?.[act[1]].find((r) => r.id === act[2]);
      if (target) {
        const [, kind, , verb] = act;
        const refuse = (status, code, message) => {
          res.writeHead(status);
          res.end(JSON.stringify({ error: { code, message } }));
        };
        if (verb === "submit") {
          if (target.status !== "draft")
            return refuse(409, "invalid_state", "only drafts can be submitted");
          target.status = "review";
        } else if (verb === "approve") {
          if (req.headers["x-sindri-approval"] !== "sindri-human-secret")
            return refuse(403, "approval_required", "approvals need a valid approval secret");
          if (target.status !== "review")
            return refuse(409, "invalid_state", "only records in review can be approved");
          if (
            kind === "specs" &&
            flow.meta?.[target.lineageId]?.untrustedInstructionDetected &&
            JSON.parse(b).acknowledgeUntrusted !== true
          )
            return refuse(409, "untrusted_unacknowledged", "acknowledge the flagged instructions");
          target.status = "approved";
        } else {
          // Like Sindri, an answer produces the next version of the specification.
          const revised = {
            ...target,
            id: target.id + "x",
            version: target.version + 1,
            body: {
              ...target.body,
              openQuestions: target.body.openQuestions.filter(
                (q) => q.id !== JSON.parse(b).questionId,
              ),
            },
          };
          flow.specs.push(revised);
          res.writeHead(201);
          return res.end(JSON.stringify({ spec: revised, meta: flow.meta?.[revised.lineageId] ?? {} }));
        }
        return res.end(JSON.stringify({ [kind.slice(0, -1)]: target }));
      }
      // `workflow.authoring` makes the fixture answer the authoring steps like Sindri: saving an
      // intake, drafting and answering specifications, proposing plans, starting, cancelling and
      // reworking runs. Without it these requests keep their earlier answers.
      if (flow?.authoring) {
        const input = JSON.parse(b || "{}");
        const refuse = (status, code, message) => {
          res.writeHead(status);
          res.end(JSON.stringify({ error: { code, message } }));
          return true;
        };
        const created = (value) => {
          res.writeHead(201);
          res.end(JSON.stringify(value));
          return true;
        };
        const n = () => String(++flow.authored).padStart(2, "0");
        flow.authored ??= 0;
        flow.runs ??= [];
        const draft = (projectId, intakeId, request) => {
          const id = "spc_new" + n();
          const spec = {
            id,
            projectId,
            ...(intakeId ? { intakeId } : {}),
            lineageId: "ln_" + id,
            version: 1,
            status: "draft",
            title: "Drafted: " + request.trim().slice(0, 40),
            body: {
              problem: request.trim(),
              goals: [],
              acceptanceCriteria: [{ id: "AC1", text: "It works", verification: "test" }],
              openQuestions: [
                {
                  id: "q-scope",
                  text: "Which modules are in scope?",
                  blocking: true,
                  recommendation: "Only the totals module",
                  rationale: "The request names totals only.",
                },
              ],
            },
          };
          flow.specs.push(spec);
          return spec;
        };
        if (req.url === "/v1/intakes") {
          if (!String(input.title ?? "").trim())
            return refuse(422, "validation_failed", "title is required");
          const intake = {
            id: "int_new" + n(),
            projectId: input.projectId,
            title: input.title,
            body: input.body,
            ...(input.workKind ? { workKind: input.workKind } : {}),
          };
          flow.intakes.push(intake);
          return created({ intake });
        }
        if (req.url === "/v1/director/draft") {
          // Sindri trims the request and refuses an empty one.
          if (!String(input.request ?? "").trim())
            return refuse(422, "validation_failed", "request: must not be empty");
          if (input.intakeId && !flow.intakes.some((i) => i.id === input.intakeId))
            return refuse(404, "not_found", "intake not found");
          return created({ spec: draft(input.projectId, input.intakeId, input.request), meta: {} });
        }
        if (req.url === "/v1/plans/propose") {
          const spec = flow.specs.find((s) => s.id === input.specId);
          if (!spec) return refuse(404, "not_found", "specification not found");
          if (spec.status !== "approved")
            return refuse(409, "invalid_state", "only an approved specification can be planned");
          const id = "pln_new" + n();
          const plan = {
            id,
            projectId: spec.projectId,
            lineageId: "lp_" + id,
            version: 1,
            status: "draft",
            specId: spec.id,
            tasks: [
              { id: "build", objective: "Build it", budget: { wallClockMinutes: 10 }, maxRetries: 1, dependsOn: [], inputs: [], outputs: [], acceptanceCriteria: ["AC1"] },
            ],
          };
          flow.plans.push(plan);
          return created({ plan, versions: [] });
        }
        const rework = /^\/v1\/deliveries\/([\w-]+)\/rework$/.exec(req.url);
        if (rework) {
          const delivery = flow.deliveries.find((d) => d.id === rework[1]);
          if (!delivery) return refuse(404, "not_found", "delivery not found");
          if (!String(input.feedback ?? "").trim())
            return refuse(422, "validation_failed", "feedback is required");
          return created({ rework: { id: "rwk_" + n() }, spec: draft(delivery.projectId, undefined, input.feedback) });
        }
        if (req.url === "/v1/executions") {
          const plan = flow.plans.find((r) => r.id === input.planId);
          if (!plan) return refuse(404, "not_found", "plan not found");
          if (plan.status !== "approved")
            return refuse(409, "invalid_state", "only an approved plan can be started");
          const view = {
            execution: { id: "exe_new" + n(), planId: plan.id, projectId: plan.projectId, status: "running" },
            plan,
            tasks: [],
            gates: [],
          };
          flow.runs.push({ projectId: plan.projectId, view });
          return created(view);
        }
        const cancel = /^\/v1\/executions\/([\w-]+)\/cancel$/.exec(req.url);
        const run = cancel && flow.runs.find((r) => r.view.execution.id === cancel[1]);
        if (run) {
          if (["verified_pending_review", "cancelled", "failed"].includes(run.view.execution.status))
            return refuse(409, "invalid_state", "the execution has finished; there is nothing to cancel");
          run.view.execution.status = "cancelled";
          return res.end(JSON.stringify(run.view));
        }
      }
      if (flow && req.url === "/v1/executions") {
        const plan = flow.plans.find((r) => r.id === JSON.parse(b).planId);
        res.writeHead(201);
        return res.end(
          JSON.stringify({
            execution: { id: "exe_started", planId: plan.id, status: "running" },
            plan,
            tasks: [],
          }),
        );
      }
      if (req.url === "/v1/executions/exe_demo/cancel") {
        const run = api.execution.execution;
        if (["verified_pending_review", "cancelled", "failed"].includes(run.status)) {
          res.writeHead(409);
          return res.end(
            JSON.stringify({
              error: {
                code: "invalid_state",
                message: `the execution has finished (${run.status}); there is nothing to cancel`,
              },
            }),
          );
        }
        run.status = "cancelled";
        return res.end(JSON.stringify(api.execution));
      }
      if (req.url === "/v1/executions/exe_demo/approvals/apr_demo") {
        if (req.headers["x-sindri-approval"] !== "sindri-human-secret") {
          res.writeHead(403);
          return res.end('{"message":"Human factor required"}');
        }
        data.approvals[0].status = JSON.parse(b).decision;
        return res.end(JSON.stringify({ approval: data.approvals[0] }));
      }
      if (req.url === "/v1/missions/msn_demo/pause")
        data.missions[0].status = "paused";
      else if (req.url === "/v1/missions/msn_demo/resume")
        data.missions[0].status = "active";
      else {
        res.writeHead(409);
        return res.end('{"message":"Source rejected this action"}');
      }
      return res.end(JSON.stringify({ mission: data.missions[0] }));
    }
    res.writeHead(404);
    res.end("{}");
  });
  // Answers like Sindri's steward and Feedback Graph routes, from `api.steward` and `api.feedbackGraph`.
  function autonomy(req, res, input) {
    const send = (status, value) => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };
    const refuse = (status, code, message) => send(status, { error: { code, message } });
    const approved = req.headers["x-sindri-approval"] === "sindri-human-secret";
    const url = new URL(req.url, "http://fixture");
    const fg = api.feedbackGraph;
    const fgStatus = () =>
      fg?.status ?? { configured: false, enabled: false, url: null, reachable: null, error: null };
    if (url.pathname === "/v1/feedback-graph/status") return send(200, fgStatus());
    const fgProject = /^\/v1\/projects\/([\w-]+)\/feedback-graph$/.exec(url.pathname);
    if (fgProject) {
      const entry = (fg.projects[fgProject[1]] ??= {
        auto: null,
        link: { projectKey: null, source: "none" },
        lessons: [],
        error: null,
      });
      if (req.method === "PUT") {
        const key = input.projectKey;
        entry.link =
          key === null
            ? { projectKey: entry.auto, source: entry.auto ? "auto" : "none" }
            : { projectKey: key, source: "override" };
      }
      const { auto: _auto, ...shown } = entry;
      return send(200, shown);
    }
    const st = api.steward;
    const status = () => ({ running: st.running, types: st.types, feedbackGraph: fgStatus() });
    if (url.pathname === "/v1/steward/status") return send(200, status());
    if (url.pathname === "/v1/steward/modes" && req.method === "PUT") {
      if (!approved) return refuse(403, "approval_required", "approvals need a valid approval secret");
      const row = st.types.find((t) => t.type === input.type);
      if (!row) return refuse(404, "not_found", "unknown decision type");
      if (input.mode === "auto" && !row.autoAllowed)
        return refuse(422, "validation_failed", "approvals are never automatic");
      row.mode = input.mode;
      return send(200, { types: st.types });
    }
    if (/^\/v1\/steward\/(pause|resume)$/.test(url.pathname)) {
      st.running = url.pathname.endsWith("resume");
      return send(200, status());
    }
    if (url.pathname === "/v1/steward/decisions") {
      const q = url.searchParams;
      return send(200, {
        decisions: st.decisions
          .filter(
            (d) =>
              (!q.get("projectId") || d.projectId === q.get("projectId")) &&
              (!q.get("type") || d.type === q.get("type")) &&
              (!q.get("status") || d.status === q.get("status")),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    }
    if (url.pathname === "/v1/steward/notes") {
      if (req.method === "POST") {
        const note = {
          id: "note_" + (st.notes.length + 1),
          projectId: input.projectId ?? null,
          decisionId: null,
          author: "operator",
          text: input.text,
          createdAt: new Date().toISOString(),
        };
        st.notes.unshift(note);
        return send(201, { note });
      }
      const projectId = url.searchParams.get("projectId");
      return send(200, {
        notes: st.notes.filter((n) => !projectId || n.projectId === projectId || n.projectId === null),
      });
    }
    const act = /^\/v1\/steward\/decisions\/([\w-]+)(?:\/(accept|reject|rollback|notes))?$/.exec(url.pathname);
    const decision = act && st.decisions.find((d) => d.id === act[1]);
    if (!decision) return refuse(404, "not_found", "decision not found");
    const verb = act[2];
    if (!verb && req.method === "GET") return send(200, { decision });
    const now = new Date().toISOString();
    if (verb === "accept" || verb === "reject") {
      if (verb === "accept" && ["spec.approve", "plan.approve"].includes(decision.type) && !approved)
        return refuse(403, "approval_required", "approvals need a valid approval secret");
      if (decision.status !== "pending")
        return refuse(409, "invalid_state", "only a pending decision can be decided");
      decision.status =
        verb === "reject"
          ? "rejected"
          : input.value !== undefined && input.value !== decision.recommendation.value
            ? "changed"
            : "accepted";
      if (input.value !== undefined) decision.recommendation = { ...decision.recommendation, value: input.value };
      decision.decidedAt = now;
    } else if (verb === "rollback") {
      if (!decision.reversible || decision.status !== "applied")
        return refuse(409, "invalid_state", "only an applied, reversible decision can be rolled back");
      decision.status = "rolled_back";
    } else if (verb === "notes") {
      decision.notes.push({
        id: "note_d" + (decision.notes.length + 1),
        projectId: decision.projectId,
        decisionId: decision.id,
        author: "operator",
        text: input.text,
        createdAt: now,
      });
    } else return refuse(405, "method_not_allowed", "method not allowed");
    return send(200, { decision });
  }
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = {
    // Steward state `{ running, types, decisions, notes }`; null leaves those routes unanswered.
    steward: null,
    // Feedback Graph `{ status, projects: { [projectId]: { auto, link, lessons, error } } }`.
    feedbackGraph: null,
    intercept: null,
    workflow: null,
    // `{ skills, guidance, reports, previews, importCandidates }` keyed by project or execution ID.
    work: null,
    // Execution profiles by Sindri project ID, as saved through PUT.
    profiles: {},
    // Mimir's `/v1/attention` items, and crew budgets as changed through PATCH, by crew ID.
    attention: [],
    budgets: {},
    execution: {
      execution: { id: "exe_demo", mimirMissionId: "msn_demo" },
      tasks: [],
      gates: [],
    },
    data,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    emit() {
      const event = {
        id: "evt_" + ++seq,
        type: "task.output",
        sequence: seq,
        occurredAt: new Date().toISOString(),
        missionId: "msn_demo",
        taskId: "tsk_demo",
        payload: { text: "Running regression tests" },
      };
      for (const s of streams)
        s.write(
          `id: c${seq}\nevent: task.output\ndata: ${JSON.stringify(event)}\n\n`,
        );
      return event;
    },
    disconnect() {
      disconnected = true;
      for (const s of streams) s.end();
    },
    reconnect() {
      disconnected = false;
    },
    close: async () => {
      for (const s of streams) s.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
  return api;
}

/**
 * Research, PR review and unknown-kind records for `prj_demo`: plans, deliveries, an intake, and
 * the `work` routes (skills, guidance, reports, review preview, a PR import that asks for the
 * project). Adds to `source.workflow`, or starts one.
 */
export function installWorkKinds(source) {
  const flow = (source.workflow ??= {
    projects: [{ id: "prj_demo", name: "Invoice library", repoPath: "/example/invoice" }],
    specs: [],
    plans: [],
    intakes: [],
    deliveries: [],
  });
  const plan = (id, kind) => ({
    id,
    projectId: "prj_demo",
    lineageId: "lp_" + id,
    version: 1,
    status: "approved",
    title: "Plan for " + kind,
    work: { kind },
    tasks: [],
  });
  flow.plans.push(plan("pln_res", "research"), plan("pln_rev", "pr_review"), plan("pln_odd", "audit"));
  const delivery = (id, planId) => ({ id, executionId: id, projectId: "prj_demo", planId, status: "verified_pending_review" });
  flow.deliveries.push(
    delivery("exe_research", "pln_res"),
    delivery("exe_review", "pln_rev"),
    delivery("exe_odd", "pln_odd"),
  );
  flow.intakes.push({ id: "int_odd", projectId: "prj_demo", title: "Mystery intake", body: "", workKind: "audit" });
  source.work = {
    skills: [
      { id: "sk_sec", name: "Security review", description: "Look for injection and secrets" },
      { id: "sk_style", name: "House style", description: "" },
    ],
    guidance: {
      prj_demo: { projectId: "prj_demo", notes: "", defaultSkillIds: ["sk_sec"], updatedAt: null },
      sp_ledger: { projectId: "sp_ledger", notes: "", defaultSkillIds: ["sk_style"], updatedAt: null },
    },
    reports: {
      exe_research: {
        workKind: "research",
        projectId: "prj_demo",
        guidance: {
          skills: [{ id: "sk_sec", name: "Security review", digest: "sha256:abcdef0123456789" }],
          projectNotesDigest: null,
          requestNotes: "Be brief",
          requestNotesDigest: "sha256:1234567890abcdef",
        },
        research: {
          question: "Why do totals drift?",
          sourcesAllowed: { code: true, feedbackGraph: true, web: false },
          planTaskId: "research",
          document: {
            markdown:
              "## Answer\n\nRounding happens per line [1][2].\n\n## Findings\n\nFloats are used for money [1, 2].\n\n## Open questions\n\nNone.\n\n## Sources\n\n1. src/total.ts:4\n2. lesson-7\n",
            artifactId: "art_doc",
          },
          sources: [
            { id: "1", kind: "file", ref: "src/total.ts:4" },
            { id: "2", kind: "lesson", ref: "lesson-7", title: "Never use floats for money", private: true },
          ],
          sourcesArtifactId: "art_src",
          containsPrivateSources: true,
          gate: { passed: true, failures: [] },
          factCheck: {
            planTaskId: "fact-check",
            verdict: "approve",
            findings: [{ id: "fc1", severity: "minor", message: "Line 4 rounds, not line 5", file: "src/total.ts", line: 4 }],
            reviewArtifactId: null,
            gatePassed: true,
          },
          decision: null,
        },
      },
      exe_review: {
        workKind: "pr_review",
        projectId: "prj_demo",
        review: {
          pr: { owner: "octo", repo: "widgets", number: 7, url: "https://github.com/octo/widgets/pull/7", title: "Add totals cache", baseSha: "b0", headSha: "h0" },
          verdict: "request_changes",
          summary: "The agent's summary",
          markdown: null,
          findings: [],
          draft: {
            version: 2,
            verdict: "comment",
            summary: "The cache is unbounded.",
            findings: [
              { id: "f1", severity: "major", message: "Cache never evicts entries", file: "src/cache.ts", line: 10, placement: "inline", included: true },
              { id: "f2", severity: "nit", message: "Rename the helper", placement: "general", included: false },
            ],
          },
          posted: null,
          gatePassed: true,
          gateFailures: [],
          hunksAvailable: true,
        },
      },
      exe_odd: { workKind: "audit", projectId: "prj_demo" },
    },
    previews: {
      exe_review: {
        draftVersion: 2,
        leakCheck: { ok: false, rule: "private_tooling", findingId: "f1", field: "message" },
        gatesPassed: true,
        posted: null,
        canPost: false,
        blockers: ["post_blocked"],
        payload: { event: "COMMENT", body: "The cache is unbounded.", comments: [] },
      },
    },
    importCandidates: [
      { id: "prj_demo", name: "Invoice library" },
      { id: "sp_ledger", name: "Ledger app" },
    ],
  };
  return source.work;
}
