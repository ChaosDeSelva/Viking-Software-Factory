import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { SqliteDatabase } from "@sindri/knowledge";

const HEARTBEAT_MS = 15_000;
const DEFAULT_POLL_MS = 500;

/**
 * A number that moves whenever Sindri's database is written: total_changes() counts this
 * connection's writes (the server, the Director, the steward, run ingestion), data_version moves
 * on commits from other connections (the CLI). Watching the database itself means no write path
 * can forget to announce a change.
 */
export function changeFingerprint(db: SqliteDatabase): string {
  const own = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const others = db.pragma("data_version", { simple: true }) as number;
  return `${own}:${others}`;
}

/**
 * `GET /v1/changes`: an SSE stream that sends `changed` with a version number once on connect and
 * again whenever Sindri's data changes, so open pages can refresh themselves. It carries no record
 * data (each page reloads through its usual authorized endpoint) and has no side effects.
 */
export function changeRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  opts: { pollMs?: number } = {},
) {
  const streams = new Set<ServerResponse>();
  let version = 0;
  let last = changeFingerprint(db);
  let timer: NodeJS.Timeout | undefined;

  const broadcast = () => {
    for (const raw of streams) raw.write(`event: changed\ndata: {"version":${version}}\n\n`);
  };
  const poll = () => {
    const now = changeFingerprint(db);
    if (now === last) return;
    last = now;
    version += 1;
    broadcast();
  };
  // Polls only while someone listens; one read of two counters every half second.
  const start = () => {
    timer ??= setInterval(poll, opts.pollMs ?? DEFAULT_POLL_MS);
  };
  const stopIfIdle = () => {
    if (streams.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  app.addHook("preClose", async () => {
    for (const raw of streams) raw.end();
    streams.clear();
    stopIfIdle();
  });

  app.get("/v1/changes", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    const cors = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter(
        ([k]) => k.startsWith("access-control-") || k === "vary",
      ),
    );
    raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Catch up before listening so a change between connect and the first poll is not lost.
    poll();
    raw.write(`event: changed\ndata: {"version":${version}}\n\n`);
    streams.add(raw);
    start();
    const ping = setInterval(() => raw.write(": ping\n\n"), HEARTBEAT_MS);
    req.raw.on("close", () => {
      clearInterval(ping);
      streams.delete(raw);
      stopIfIdle();
    });
  });
}
