import { createServer } from "node:http";
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
          [listed[1]]: (flow?.[listed[1]] ?? []).filter(
            (r) => r.projectId === decodeURIComponent(listed[2]),
          ),
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
          const intake = { id: "int_new" + n(), projectId: input.projectId, title: input.title, body: input.body };
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
