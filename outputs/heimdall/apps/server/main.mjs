import { validatePreferences } from "./preferences.mjs";
import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Store } from "./storage.mjs";
import { Hub, localUrl, request } from "./connectors.mjs";
import { commandRoute } from "./commands.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const equals = (a, b) =>
  timingSafeEqual(Buffer.from(hash(a ?? "")), Buffer.from(hash(b ?? "")));
const json = (res, status, data) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 524288)
      throw Object.assign(Error("Request too large"), { status: 413 });
  }
  return JSON.parse(text || "{}");
}
export async function startHeimdall(options = {}) {
  const env = options.env ?? process.env,
    port = Number(env.HEIMDALL_PORT ?? 4320);
  const dataDir = resolve(env.HEIMDALL_DATA_DIR ?? ".heimdall");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const connectionFile = join(dataDir, "connections.json");
  const savedConnections = existsSync(connectionFile)
    ? JSON.parse(readFileSync(connectionFile, "utf8"))
    : {};
  const connections = {};
  for (const name of ["mimir", "sindri"]) {
    const upper = name.toUpperCase();
    if (!env[upper + "_URL"]) continue;
    connections[name] = {
      url: localUrl(env[upper + "_URL"]),
      token: env[upper + "_TOKEN_FILE"]
        ? readFileSync(env[upper + "_TOKEN_FILE"], "utf8").trim()
        : env[upper + "_TOKEN"],
    };
    if (!connections[name].token)
      throw Error(`${upper}_TOKEN or ${upper}_TOKEN_FILE required`);
  }
  for (const name of ["mimir", "sindri"])
    if (Object.hasOwn(savedConnections, name)) {
      if (savedConnections[name])
        connections[name] = {
          url: localUrl(savedConnections[name].url),
          token: String(savedConnections[name].token),
        };
      else delete connections[name];
    }
  const store = new Store(dataDir),
    clients = new Set(),
    sessions = new Map();
  const token = env.HEIMDALL_TOKEN ?? randomBytes(24).toString("base64url"),
    operatorCode = options.operatorCode ?? randomBytes(8).toString("hex");
  let timer;
  let closing = false;
  const broadcast = () => {
    if (closing) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (closing) return;
      const data = JSON.stringify(hub.snapshot());
      for (const res of clients) {
        if (res.writableLength > 2 * 1024 * 1024) {
          res.destroy();
          clients.delete(res);
        } else res.write(`event: snapshot\ndata: ${data}\n\n`);
      }
    }, 100);
  };
  let hub = new Hub(connections, store, broadcast);
  const web = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
  let boundPort = port;
  let loginFailures = 0,
    lockedUntil = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
      if (!hosts.includes(req.headers.host))
        throw Object.assign(Error("Invalid host"), { status: 403 });
      if (
        req.headers.origin &&
        !hosts.some((h) => req.headers.origin === "http://" + h)
      )
        throw Object.assign(Error("Cross-origin request denied"), {
          status: 403,
        });
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      if (!path.startsWith("/api/")) {
        if (req.method !== "GET")
          throw Object.assign(Error("Method not allowed"), { status: 405 });
        const asset =
          path === "/" ? "index.html" : decodeURIComponent(path).slice(1);
        const file = resolve(web, asset);
        if (!file.startsWith(web + "/") || !existsSync(file))
          throw Object.assign(Error("Not found"), { status: 404 });
        res.setHeader(
          "content-type",
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(file)] ?? "application/octet-stream",
        );
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "POST" && req.headers["x-heimdall-request"] !== "1")
        throw Object.assign(Error("Missing same-origin request header"), {
          status: 403,
        });
      if (path === "/api/login" && req.method === "POST") {
        if (Date.now() < lockedUntil)
          throw Object.assign(
            Error("Too many attempts. Try again in one minute."),
            { status: 429 },
          );
        const b = await body(req);
        if (!equals(b.token, token)) {
          if (++loginFailures >= 5) {
            lockedUntil = Date.now() + 60000;
            loginFailures = 0;
          }
          throw Object.assign(Error("Invalid access token"), { status: 401 });
        }
        const sid = randomBytes(32).toString("base64url");
        sessions.set(sid, {
          expires: Date.now() + 12 * 3600000,
          operator: false,
          approvalSecret: null,
        });
        res.setHeader(
          "set-cookie",
          `heimdall=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        );
        return json(res, 200, { ok: true });
      }
      const sid = /\bheimdall=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      const session = sessions.get(sid);
      if (!session || session.expires < Date.now())
        throw Object.assign(
          Error("Sign in with the access token printed in the launcher."),
          { status: 401 },
        );
      if (path === "/api/logout" && req.method === "POST") {
        sessions.delete(sid);
        res.setHeader(
          "set-cookie",
          "heimdall=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(res, 200, { ok: true });
      }
      if (path === "/api/session")
        return json(res, 200, {
          operator: session.operator,
          pairedSindri: !!session.approvalSecret,
        });
      if (path === "/api/unlock" && req.method === "POST") {
        if (Date.now() < lockedUntil)
          throw Object.assign(Error("Too many attempts. Try later."), {
            status: 429,
          });
        const b = await body(req);
        if (!equals(b.code, operatorCode)) {
          if (++loginFailures >= 5) {
            lockedUntil = Date.now() + 60000;
            loginFailures = 0;
          }
          throw Object.assign(Error("Incorrect operator code"), {
            status: 403,
          });
        }
        session.operator = true;
        store.audit({
          actor: "local operator",
          action: "operator.unlock",
          outcome: "confirmed",
        });
        return json(res, 200, { operator: true });
      }
      if (path === "/api/pair" && req.method === "POST") {
        if (!session.operator)
          throw Object.assign(Error("Unlock operator controls first"), {
            status: 403,
          });
        const b = await body(req);
        const r = await request(connections.sindri, "/v1/approval-session", {
          method: "POST",
          body: JSON.stringify({ pairingCode: b.code, channel: "web" }),
        });
        session.approvalSecret = r.approvalSecret;
        return json(res, 200, { paired: true, expiresAt: r.expiresAt });
      }
      if (path === "/api/config" && req.method === "GET")
        return json(res, 200, {
          connections: Object.fromEntries(
            Object.entries(connections).map(([k, c]) => [
              k,
              { url: c.url, authenticated: !!c.token },
            ]),
          ),
          preferences: store.preferences(),
        });
      if (path === "/api/preferences" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key))
          throw Error("Idempotency key required");
        const value = validatePreferences(await body(req));
        const fingerprint = hash("preferences:" + JSON.stringify(value));
        const prior = store.receipt(key);
        if (prior) {
          if (prior.hash !== fingerprint)
            throw Object.assign(Error("Idempotency conflict"), { status: 409 });
          return json(res, prior.status, JSON.parse(prior.json));
        }
        const next = { ...store.preferences(), ...value };
        store.savePreferences(next);
        store.audit({
          actor: "local user",
          action: "preferences.update",
          key,
          outcome: "confirmed",
        });
        const result = { preferences: next };
        store.receiptPut(key, fingerprint, 200, result);
        broadcast();
        return json(res, 200, result);
      }
      if (path === "/api/notifications/read" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key))
          throw Error("Idempotency key required");
        const b = await body(req);
        if (typeof b.id !== "string" || b.id.length > 500)
          throw Error("Invalid notification");
        store.markNotification(b.id);
        store.audit({
          actor: "local user",
          action: "notification.read",
          id: b.id,
          key,
          outcome: "confirmed",
        });
        broadcast();
        return json(res, 200, { ok: true });
      }
      if (path === "/api/connections" && req.method === "POST") {
        if (!session.operator)
          throw Object.assign(Error("Unlock operator controls first"), {
            status: 403,
          });
        const b = await body(req),
          key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key))
          throw Error("Idempotency key required");
        if (!["mimir", "sindri"].includes(b.source))
          throw Error("Unknown source");
        if (!["save", "test", "disconnect"].includes(b.action))
          throw Error("Unknown connection action");
        const fingerprint = hash(JSON.stringify(b));
        const prior = store.receipt(key);
        if (prior) {
          if (prior.hash !== fingerprint)
            throw Object.assign(Error("Idempotency conflict"), { status: 409 });
          return json(res, prior.status, JSON.parse(prior.json));
        }
        const next =
          b.action === "disconnect"
            ? null
            : {
                url: localUrl(b.url),
                token:
                  typeof b.token === "string" && b.token
                    ? b.token
                    : connections[b.source]?.token,
              };
        if (next && !next.token) throw Error("A source token is required");
        if (next) {
          try {
            await request(
              next,
              b.source === "mimir" ? "/v1/snapshot" : "/v1/projects",
            );
          } catch (e) {
            throw Object.assign(
              Error(
                "Connection test failed. Check the origin, token and source server.",
              ),
              { status: e.status ?? 502 },
            );
          }
        }
        if (b.action !== "test") {
          hub.stop();
          if (next) connections[b.source] = next;
          else delete connections[b.source];
          savedConnections[b.source] = next;
          const temporary = connectionFile + ".tmp";
          writeFileSync(temporary, JSON.stringify(savedConnections), {
            mode: 0o600,
          });
          chmodSync(temporary, 0o600);
          renameSync(temporary, connectionFile);
          store.clearSource(b.source);
          for (const sess of sessions.values()) sess.approvalSecret = null;
          hub = new Hub(connections, store, broadcast);
          void hub.start();
        }
        store.audit({
          actor: "local operator",
          action: "connection." + b.action,
          source: b.source,
          key,
          outcome: "confirmed",
        });
        const result = { ok: true, source: b.source, action: b.action };
        store.receiptPut(key, fingerprint, 200, result);
        return json(res, 200, result);
      }
      const telemetry = /^\/api\/agents\/([\w-]+)\/telemetry$/.exec(path);
      if (telemetry && req.method === "GET") {
        const agent = hub.state.mimir.agents?.find(
          (a) => a.id === telemetry[1],
        );
        if (!agent?.runtimeSessionId)
          throw Object.assign(Error("Agent session is unavailable"), {
            status: 404,
          });
        const sessionId = encodeURIComponent(agent.runtimeSessionId);
        const [info, terminal] = await Promise.allSettled([
          request(connections.mimir, `/v1/sessions/${sessionId}`),
          request(
            connections.mimir,
            `/v1/sessions/${sessionId}/terminal?lines=500`,
          ),
        ]);
        return json(
          res,
          200,
          hub.clean({
            agent,
            info: info.status === "fulfilled" ? info.value : null,
            terminal: terminal.status === "fulfilled" ? terminal.value : null,
            errors: [info, terminal]
              .filter((x) => x.status === "rejected")
              .map((x) => x.reason.message),
            capturedAt: new Date().toISOString(),
          }),
        );
      }
      if (path === "/api/harnesses" && req.method === "GET")
        return json(res, 200, hub.clean(await request(connections.mimir, "/v1/harnesses")));
      if (path === "/api/fleet" && req.method === "GET")
        return json(
          res,
          200,
          hub.clean(await request(connections.mimir, "/v1/fleet")),
        );
      if (path === "/api/supervisors" && req.method === "GET")
        return json(
          res,
          200,
          hub.clean(await request(connections.mimir, "/v1/supervisors")),
        );
      const supervisor = /^\/api\/supervisors\/([\w-]+)$/.exec(path);
      if (supervisor && req.method === "GET")
        return json(
          res,
          200,
          hub.clean(
            await request(
              connections.mimir,
              `/v1/supervisors/${supervisor[1]}`,
            ),
          ),
        );
      if (path === "/api/snapshot") return json(res, 200, hub.snapshot());
      if (path === "/api/events")
        return json(res, 200, {
          events: store.events(Object.fromEntries(url.searchParams)),
        });
      if (path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(
          `event: snapshot\ndata: ${JSON.stringify(hub.snapshot())}\n\n`,
        );
        clients.add(res);
        const ping = setInterval(() => {
          if (!sessions.has(sid) || session.expires < Date.now())
            return res.end();
          res.write(": heartbeat\n\n");
        }, 15000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      const artifact = /^\/api\/artifacts\/([\w-]+)$/.exec(path);
      if (artifact && req.method === "GET")
        return json(res, 200, await hub.artifact(artifact[1]));
      const detail =
        /^\/api\/details\/(specs|plans|intakes|deliveries|questions|local)\/([\w-]+)$/.exec(
          path,
        );
      if (detail && req.method === "GET") {
        const [, kind, id] = detail;
        const upstream =
          kind === "questions"
            ? `/v1/specs/${id}/questions`
            : kind === "local"
              ? `/v1/deliveries/${id}/local`
              : `/v1/${kind}/${id}`;
        return json(
          res,
          200,
          hub.clean(await request(connections.sindri, upstream)),
        );
      }
      if (path === "/api/commands" && req.method === "POST") {
        if (!session.operator)
          throw Object.assign(
            Error(
              "Read-only session. Unlock operator controls in Connections.",
            ),
            { status: 403 },
          );
        const c = await body(req);
        if (
          typeof c.reason !== "string" ||
          !c.reason.trim() ||
          c.reason.length > 2000
        )
          throw Object.assign(Error("An audit reason is required"), {
            status: 422,
          });
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key))
          throw Object.assign(Error("An idempotency key is required"), {
            status: 422,
          });
        const fingerprint = hash(JSON.stringify(c)),
          prior = store.receipt(key);
        if (prior) {
          if (prior.hash !== fingerprint)
            throw Object.assign(
              Error("Idempotency key was used for a different command"),
              { status: 409 },
            );
          return json(res, prior.status, JSON.parse(prior.json));
        }
        const route = commandRoute(c);
        // An integrated execution approval must preserve Sindri's human approval factor.
        if (c.action === "approval.decide") {
          const approval = hub.state.mimir.approvals?.find(
            (a) => a.id === c.id,
          );
          if (!approval)
            throw Object.assign(Error("Approval unavailable; refresh first"), {
              status: 409,
            });
          const owner = hub.state.sindri.executions.find(
            (e) => e.execution.mimirMissionId === approval.missionId,
          );
          if (owner) {
            route.source = "sindri";
            route.path = `/v1/executions/${owner.execution.id}/approvals/${c.id}`;
          } else if (
            connections.sindri &&
            hub.state.sources.sindri?.status !== "connected"
          )
            throw Object.assign(
              Error(
                "Sindri disconnected; approval ownership cannot be confirmed",
              ),
              { status: 409 },
            );
        }
        if (route.source === "sindri" && !session.approvalSecret)
          throw Object.assign(
            Error(
              "Pair with Sindri in Connections before issuing its controls",
            ),
            { status: 403 },
          );
        store.receiptPut(key, fingerprint, 409, {
          message:
            "Command is pending or outcome is uncertain. Inspect source state before retrying.",
        });
        store.audit({
          actor: "local operator",
          action: c.action,
          id: c.id,
          reason: c.reason,
          key,
          outcome: "requested",
        });
        try {
          const result = await request(connections[route.source], route.path, {
            method: "POST",
            headers: {
              "idempotency-key": key,
              "x-heimdall-audit": key,
              ...(route.source === "sindri"
                ? { "x-sindri-approval": session.approvalSecret }
                : {}),
            },
            body: JSON.stringify(route.body),
            signal: AbortSignal.timeout(
              ["spec.draft", "plan.propose", "task.verify"].includes(c.action)
                ? 180000
                : 30000,
            ),
          });
          const response = hub.clean({
            confirmed: true,
            source: route.source,
            result,
          });
          store.receiptPut(key, fingerprint, 200, response);
          store.audit({
            actor: "local operator",
            action: c.action,
            id: c.id,
            key,
            outcome: "source confirmed",
          });
          await hub.refresh();
          return json(res, 200, response);
        } catch (e) {
          const status = e.status ?? 502;
          const response = { message: hub.clean(e.message), confirmed: false };
          store.receiptPut(key, fingerprint, status, response);
          store.audit({
            actor: "local operator",
            action: c.action,
            id: c.id,
            key,
            outcome: "failed or unconfirmed",
            status,
          });
          return json(res, status, response);
        }
      }
      throw Object.assign(Error("Not found"), { status: 404 });
    } catch (e) {
      json(res, e.status ?? 400, { message: hub.clean(e.message) });
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  boundPort = server.address().port;
  void hub.start();
  return {
    url: `http://127.0.0.1:${boundPort}`,
    token,
    operatorCode,
    get hub() {
      return hub;
    },
    store,
    close: async () => {
      if (closing) return;
      closing = true;
      hub.stop();
      clearTimeout(timer);
      for (const r of clients) r.end();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startHeimdall();
  console.log(
    `Heimdall: ${app.url}\nAccess token: ${app.token}\nOperator code: ${app.operatorCode}\nKeep this terminal open. Control+C stops Heimdall.`,
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => void app.close().then(() => process.exit(0)));
}
