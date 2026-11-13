import { validatePreferences } from "./preferences.mjs";
import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  statSync,
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
import { commandRoute, commandTimeout } from "./commands.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
// Anything but text can never match; an empty secret is replaced at start-up.
const equals = (a, b) =>
  typeof a === "string" &&
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
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
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object")
    throw Error("The request body must be a JSON object");
  return value;
}
const QUERY_ID = /^[\w-]{1,200}$/;
const QUERY_PARAMS = {
  projectId: QUERY_ID,
  type: /^[\w.-]{1,100}$/,
  status: /^[\w.-]{1,100}$/,
  limit: /^(?:[1-9]\d?|1\d\d|200)$/,
  before: /^[\w:.+-]{1,100}$/,
};
/** Sindri path for a steward or Feedback Graph read, or null when the path is not one. */
export function stewardDetail(path, params) {
  const query = (names) => {
    const out = new URLSearchParams();
    for (const name of names) {
      const value = params.get(name);
      if (value === null || value === "") continue;
      if (!QUERY_PARAMS[name].test(value))
        throw Object.assign(Error(`Invalid ${name}`), { status: 400 });
      out.set(name, value);
    }
    const text = out.toString();
    return text ? "?" + text : "";
  };
  if (path === "/api/details/steward/status") return "/v1/steward/status";
  if (path === "/api/details/steward/decisions")
    return "/v1/steward/decisions" + query(["projectId", "type", "status", "limit", "before"]);
  if (path === "/api/details/steward/notes")
    return "/v1/steward/notes" + query(["projectId"]);
  if (path === "/api/details/feedback-graph") return "/v1/feedback-graph/status";
  const decision = /^\/api\/details\/steward\/decisions\/([\w-]{1,200})$/.exec(path);
  if (decision) return `/v1/steward/decisions/${decision[1]}`;
  const project = /^\/api\/details\/feedback-graph\/([\w-]{1,200})$/.exec(path);
  if (project) return `/v1/projects/${project[1]}/feedback-graph`;
  return null;
}
/** Sindri path for a skills, project guidance, GitHub status or PR review preview read, or null. */
export function workDetail(path) {
  if (path === "/api/details/skills") return "/v1/skills";
  // Carries `localOnly`: the research form disables its Web source in local-only mode.
  if (path === "/api/details/github-status") return "/v1/github/status";
  const guidance = /^\/api\/details\/guidance\/([\w-]{1,200})$/.exec(path);
  if (guidance) return `/v1/projects/${guidance[1]}/guidance`;
  const preview = /^\/api\/details\/review-preview\/([\w-]{1,200})$/.exec(path);
  if (preview) return `/v1/executions/${preview[1]}/review/preview`;
  return null;
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
    clients = new Map(),
    sessions = new Map(),
    inFlight = new Set();
  // An empty value would match an empty submission, so it counts as not set.
  const token = env.HEIMDALL_TOKEN || randomBytes(24).toString("base64url"),
    operatorCode = options.operatorCode || randomBytes(8).toString("hex");
  let timer;
  let closing = false;
  const broadcast = () => {
    if (closing) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (closing) return;
      let data;
      // A throw in a timer would end the process; the next change sends a fresh snapshot.
      try {
        data = JSON.stringify(hub.snapshot());
      } catch {
        return;
      }
      for (const res of clients.keys()) {
        if (res.writableLength > 2 * 1024 * 1024) {
          res.destroy();
          clients.delete(res);
        } else res.write(`event: snapshot\ndata: ${data}\n\n`);
      }
    }, 100);
  };
  let hub = new Hub(connections, store, broadcast);
  const web = resolve(
    options.webDir ??
      process.env.HEIMDALL_WEB_DIR ??
      fileURLToPath(new URL("../../dist/", import.meta.url)),
  );
  const heartbeatMs = options.heartbeatMs ?? 15000;
  let boundPort = port;
  // Separate counts: a token holder must not be able to reset the operator-code lockout.
  const attempts = { login: { failures: 0, lockedUntil: 0 }, unlock: { failures: 0, lockedUntil: 0 } };
  const failedAttempt = (kind) => {
    if (++attempts[kind].failures >= 5)
      attempts[kind] = { failures: 0, lockedUntil: Date.now() + 60000 };
  };
  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
      // Browsers share cookies between ports of one host, so each instance names its own.
      const cookieName = "heimdall_" + boundPort;
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
        let file = resolve(web, asset);
        if (!file.startsWith(web + "/"))
          throw Object.assign(Error("Not found"), { status: 404 });
        // The app routes by path (/pipeline, /docs/glossary): a path without a file extension
        // that is not a file is one of its pages, so it gets the app. Missing assets stay 404.
        if (!existsSync(file) && !extname(asset)) file = resolve(web, "index.html");
        if (!existsSync(file) || !statSync(file).isFile())
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
        if (Date.now() < attempts.login.lockedUntil)
          throw Object.assign(
            Error("Too many attempts. Try again in one minute."),
            { status: 429 },
          );
        const b = await body(req);
        if (!equals(b.token, token)) {
          failedAttempt("login");
          throw Object.assign(Error("Invalid access token"), { status: 401 });
        }
        attempts.login.failures = 0;
        // Sessions are only ever added here, so pruning here keeps the map bounded.
        for (const [id, s] of sessions)
          if (s.expires < Date.now()) sessions.delete(id);
        const sid = randomBytes(32).toString("base64url");
        sessions.set(sid, {
          expires: Date.now() + 12 * 3600000,
          operator: false,
          approvalSecret: null,
        });
        res.setHeader(
          "set-cookie",
          `${cookieName}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        );
        return json(res, 200, { ok: true });
      }
      const sid = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(
        req.headers.cookie ?? "",
      )?.[1];
      const session = sessions.get(sid);
      if (!session || session.expires < Date.now()) {
        sessions.delete(sid);
        throw Object.assign(
          Error("Sign in with the access token printed in the launcher."),
          { status: 401 },
        );
      }
      if (path === "/api/logout" && req.method === "POST") {
        sessions.delete(sid);
        for (const [stream, owner] of clients)
          if (owner === sid) stream.end();
        res.setHeader(
          "set-cookie",
          `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        );
        return json(res, 200, { ok: true });
      }
      if (path === "/api/session")
        return json(res, 200, {
          operator: session.operator,
          pairedSindri: !!session.approvalSecret,
        });
      if (path === "/api/unlock" && req.method === "POST") {
        if (Date.now() < attempts.unlock.lockedUntil)
          throw Object.assign(Error("Too many attempts. Try later."), {
            status: 429,
          });
        const b = await body(req);
        if (!equals(b.code, operatorCode)) {
          failedAttempt("unlock");
          throw Object.assign(Error("Incorrect operator code"), {
            status: 403,
          });
        }
        attempts.unlock.failures = 0;
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
        // Without a secret every Sindri control would be refused later, so this is no pairing.
        if (typeof r?.approvalSecret !== "string" || !r.approvalSecret)
          throw Object.assign(
            Error("Sindri did not return an approval secret"),
            {
              status: 502,
            },
          );
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
            const answer = await request(
              next,
              b.source === "mimir" ? "/v1/snapshot" : "/v1/projects",
            );
            // Any 200 is not enough: a different local service, or the other source, would pass.
            if (!Array.isArray(answer[b.source === "mimir" ? "missions" : "projects"]))
              throw Error("Not this source");
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
      // Mimir's attention list (budgets at their warning fraction or used up, with spend and
      // limits), read-only: the Raise budget form shows the current numbers from it.
      if (path === "/api/attention" && req.method === "GET")
        return json(res, 200, hub.clean(await request(connections.mimir, "/v1/attention")));
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
      if (path === "/api/events") {
        const before = url.searchParams.get("before");
        if (before !== null && !/^\d{1,15}$/.test(before))
          throw Error("before must be an event sequence number");
        return json(res, 200, {
          events: store.events(Object.fromEntries(url.searchParams)),
        });
      }
      if (path === "/api/stream") {
        // Built before the headers go out, so a failure here is still an ordinary error answer.
        const first = JSON.stringify(hub.snapshot());
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(`event: snapshot\ndata: ${first}\n\n`);
        clients.set(res, sid);
        const ping = setInterval(() => {
          if (!sessions.has(sid) || session.expires < Date.now())
            return res.end();
          res.write(": heartbeat\n\n");
        }, heartbeatMs);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      const artifact = /^\/api\/artifacts\/([\w-]+)$/.exec(path);
      if (artifact && req.method === "GET")
        return json(res, 200, await hub.artifact(artifact[1]));
      // Sindri's read-only Guide. POST only because it carries a question: it changes nothing,
      // so a signed-in read session is enough (no operator unlock, no idempotency key). Sindri
      // validates the body and rate-limits; its 422/429/503 come back as they are.
      if (path === "/api/details/guide/ask" && req.method === "POST") {
        const question = JSON.stringify(await body(req));
        let answer;
        try {
          answer = await request(connections.sindri, "/v1/guide/ask", {
            method: "POST",
            body: question,
            // Sindri's rate limit is per token; every Heimdall operator shares this one, so each
            // signed-in session gets its own bucket. A one-way hash: the session ID stays here.
            headers: {
              "x-guide-client": createHash("sha256")
                .update("guide-client:" + sid)
                .digest("hex"),
            },
            timeoutMs: 120000,
          });
        } catch (e) {
          if (e.name === "TimeoutError") e.status = 504;
          e.status ??= 502;
          throw e;
        }
        return json(res, 200, hub.clean(answer));
      }
      if (path.startsWith("/api/details/") && req.method === "GET") {
        const upstream = stewardDetail(path, url.searchParams) ?? workDetail(path);
        if (upstream)
          return json(res, 200, hub.clean(await request(connections.sindri, upstream)));
      }
      const detail =
        /^\/api\/details\/(specs|plans|intakes|deliveries|questions|local|profile)\/([\w-]+)$/.exec(
          path,
        );
      if (detail && req.method === "GET") {
        const [, kind, id] = detail;
        const upstream =
          kind === "questions"
            ? `/v1/specs/${id}/questions`
            : kind === "local"
              ? `/v1/deliveries/${id}/local`
              : kind === "profile"
                ? `/v1/projects/${id}/profile`
                : `/v1/${kind}/${id}`;
        const raw = await request(connections.sindri, upstream);
        const cleaned = hub.clean(raw);
        // The form saves what it shows, so it must know when a value was replaced for display.
        if (kind === "profile")
          cleaned.altered = JSON.stringify(cleaned) !== JSON.stringify(raw);
        if (kind === "local") {
          // A patch has to apply byte for byte, so the display rewrite skips it. It is the
          // operator's own repository diff; only this app's source tokens are still withheld.
          const tokens = Object.values(connections).map((c) => c?.token).filter(Boolean);
          const exact = (shown, patch) => {
            if (typeof patch !== "string" || !shown) return;
            shown.patchExact = !tokens.some((t) => patch.includes(t));
            if (shown.patchExact) shown.patch = patch;
          };
          exact(cleaned.result, raw.result?.patch);
          exact(cleaned.result?.followUp, raw.result?.followUp?.patch);
        }
        return json(res, 200, cleaned);
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
            route.approval = true;
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
            { status: 403, code: "pairing_required" },
          );
        // Only final outcomes get a receipt. A resend after a timeout or source error is
        // forwarded with the same key, and the source's own idempotency answers it.
        // The browser says which type it accepts; Sindri's own record decides, so an approval
        // can never be sent without the approval factor under a mislabelled type.
        if (c.action === "steward.accept") {
          const { decision } = await request(
            connections.sindri,
            `/v1/steward/decisions/${encodeURIComponent(c.id)}`,
          );
          if (decision?.type !== c.decisionType)
            throw Object.assign(
              Error("This decision is not the type shown. Refresh the Autonomy page and review it again."),
              { status: 409 },
            );
        }
        if (inFlight.has(key))
          throw Object.assign(
            Error(
              "This command is still waiting for the source. Its outcome will appear here; check the Pipeline before sending again.",
            ),
            { status: 409 },
          );
        inFlight.add(key);
        const timeoutMs = options.commandTimeout?.(c.action) ?? commandTimeout(c.action);
        // Everything after the key is taken sits inside the try, so the key is always released.
        try {
          store.audit({
            actor: "local operator",
            action: c.action,
            id: c.id,
            reason: c.reason,
            key,
            outcome: "requested",
          });
          const result = await request(connections[route.source], route.path, {
            method: route.method,
            headers: {
              "idempotency-key": key,
              "x-heimdall-audit": key,
              ...(route.source === "sindri" && route.approval
                ? { "x-sindri-approval": session.approvalSecret }
                : {}),
            },
            body: JSON.stringify(route.body),
            timeoutMs,
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
          const timedOut = e.name === "TimeoutError";
          const status = timedOut ? 504 : (e.status ?? 502);
          const unpaired =
            route.source === "sindri" &&
            e.status === 403 &&
            e.code === "approval_required";
          if (unpaired) session.approvalSecret = null;
          const working = e.code === "idempotency_in_progress";
          const final = !unpaired && !working && status < 500;
          // Refusals the page explains from their details: a PR import matching no single project,
          // a document decided meanwhile, a pull request that moved since planning.
          const choose = [
            "project_required",
            "already_decided",
            "pr_changed_since_plan",
          ].includes(e.code);
          const response = {
            message: timedOut
              ? `The source did not answer within ${Math.round(timeoutMs / 60000) || 1} minute(s). The work may still be running: check the Pipeline before retrying. Sending again with the same details continues this request instead of starting a second one.`
              : working
                ? "The source is still working on this request. Check the Pipeline, and send again later to collect the result."
                : unpaired
                  ? "Sindri no longer accepts this approval pairing. Pair again under Connections, then send again."
                  : hub.clean(e.message),
            confirmed: false,
            ...(final ? {} : { retryable: true }),
            ...(unpaired ? { code: "pairing_required" } : {}),
            ...(choose
              ? { code: e.code, details: hub.clean(e.details ?? null) }
              : {}),
          };
          if (final) store.receiptPut(key, fingerprint, status, response);
          store.audit({
            actor: "local operator",
            action: c.action,
            id: c.id,
            key,
            outcome: final ? "failed" : "unconfirmed; may be retried",
            status,
          });
          return json(res, status, response);
        } finally {
          inFlight.delete(key);
        }
      }
      throw Object.assign(Error("Not found"), { status: 404 });
    } catch (e) {
      // After the headers went out there is no status left to send; a second one would throw.
      if (res.headersSent) return void res.destroy();
      json(res, e.status ?? 400, {
        message: hub.clean(String(e?.message ?? e)),
        ...(e?.code === "pairing_required" ? { code: e.code } : {}),
      });
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
    sessions,
    close: async () => {
      if (closing) return;
      closing = true;
      hub.stop();
      clearTimeout(timer);
      for (const r of clients.keys()) r.end();
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
