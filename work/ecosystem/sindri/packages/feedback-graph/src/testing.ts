import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the stub answers for one request; `raw` is sent as is (malformed JSON, huge bodies). */
export type StubReply =
  | { status?: number; json: unknown }
  | { status?: number; raw: string | Buffer; contentType?: string; headers?: Record<string, string> }
  | { hang: true }
  | { destroy: true };

export interface StubFeedbackGraph {
  url: string;
  token: string;
  /** Requests seen: method, path with query, authorization header. */
  requests: { method: string; url: string; authorization: string | undefined }[];
  /** cwd → project key (`GET /api/agent/project`). */
  projects: Map<string, string>;
  /** project key → lesson objects (`GET /api/lessons`). */
  lessons: Map<string, unknown[]>;
  /** When set, answers every request instead of the default routes. */
  override: ((req: IncomingMessage) => StubReply | undefined) | undefined;
  close(): Promise<void>;
}

/**
 * A minimal Feedback Graph API on loopback for tests: Bearer auth, `GET /api/health`,
 * `GET /api/agent/project?cwd=` and `GET /api/lessons?project=&status=`.
 */
export async function startStubFeedbackGraph(token = "fg-test-token"): Promise<StubFeedbackGraph> {
  const hanging = new Set<ServerResponse>();
  const stub: StubFeedbackGraph = {
    url: "",
    token,
    requests: [],
    projects: new Map(),
    lessons: new Map(),
    override: undefined,
    close: async () => {
      for (const r of hanging) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const send = (res: ServerResponse, reply: StubReply) => {
    if ("hang" in reply) {
      hanging.add(res);
      return;
    }
    if ("destroy" in reply) {
      res.socket?.destroy();
      return;
    }
    if ("json" in reply) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
      return;
    }
    res.writeHead(reply.status ?? 200, {
      "content-type": reply.contentType ?? "application/json",
      ...reply.headers,
    });
    res.end(reply.raw);
  };
  const server = createServer((req, res) => {
    stub.requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      authorization: req.headers.authorization,
    });
    const forced = stub.override?.(req);
    if (forced) return send(res, forced);
    const u = new URL(req.url ?? "/", "http://stub");
    if (u.pathname === "/api/health") return send(res, { json: { ok: true } });
    if (req.headers.authorization !== `Bearer ${stub.token}`)
      return send(res, { status: 401, json: { error: "token not recognised" } });
    if (u.pathname === "/api/agent/project") {
      const key = stub.projects.get(u.searchParams.get("cwd") ?? "") ?? null;
      return send(res, { json: { project: key, tracked: key !== null } });
    }
    if (u.pathname === "/api/lessons") {
      const all = stub.lessons.get(u.searchParams.get("project") ?? "") ?? [];
      const status = u.searchParams.get("status");
      const statusOf = (l: unknown) => (l as { status?: unknown } | null)?.status;
      return send(res, {
        json: all.filter((l) => !status || statusOf(l) === undefined || statusOf(l) === status),
      });
    }
    return send(res, { status: 404, json: { error: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

/** A Feedback Graph lesson as `GET /api/lessons` returns it (a subset of its many fields). */
export function fgLesson(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    projectKey: "proj",
    origin: "proj",
    title: `Lesson ${id}`,
    rule: `Always do ${id}.`,
    appliesWhen: `when touching ${id}`,
    scope: "project",
    paths: [`src/${id}.ts`],
    status: "approved",
    source: "postmortem",
    cause: null,
    missId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    decidedAt: "2026-10-02T00:00:00.000Z",
    decidedBy: "you",
    checks: [],
    checksVersion: 1,
    from: "session",
    decisionNote: null,
    proposedAs: null,
    ...over,
  };
}
