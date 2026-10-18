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
    requests.push({ method: req.method, path: req.url, headers: req.headers });
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
    if (req.url === "/v1/projects")
      return res.end(JSON.stringify({ projects: data.projects }));
    if (/^\/v1\/(specs|plans|intakes|deliveries)\?/.test(req.url))
      return res.end(
        JSON.stringify({ [req.url.split("/")[2].split("?")[0]]: [] }),
      );
    if (req.url.startsWith("/v1/executions?"))
      return res.end(JSON.stringify({ executions: [{ id: "exe_demo" }] }));
    if (req.url === "/v1/executions/exe_demo")
      return res.end(
        JSON.stringify({
          execution: { id: "exe_demo", mimirMissionId: "msn_demo" },
          tasks: [],
          gates: [],
        }),
      );
    if (req.url === "/v1/executions/exe_demo/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "POST") {
      let b = "";
      for await (const chunk of req) b += chunk;
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
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
      await new Promise((r) => server.close(r));
    },
  };
}
