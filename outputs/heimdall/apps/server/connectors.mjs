import { attentionRecords } from "./preferences.mjs";
import { createHash } from "node:crypto";
export function localUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Connections must be loopback HTTP origins.");
  return u.origin;
}
export function sanitizer(secrets) {
  return (value) =>
    JSON.parse(
      JSON.stringify(value, (key, v) => {
        if (
          /^(authorization|token|apiKey|api_key|password|approvalSecret|secret|pairingCode)$/i.test(
            key,
          )
        )
          return "[redacted]";
        if (typeof v !== "string") return v;
        for (const secret of secrets.filter(Boolean))
          v = v.split(secret).join("[redacted]");
        return v.replace(
          /\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._-]{16,})/g,
          "[redacted]",
        );
      }),
    );
}
export async function request(connection, path, options = {}) {
  if (!connection)
    throw Object.assign(Error("Source is not configured"), { status: 503 });
  const r = await fetch(connection.url + path, {
    ...options,
    redirect: "error",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(12000),
  });
  const text = await boundedText(r, 12 * 1024 * 1024);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text.slice(0, 1000) };
  }
  if (!r.ok)
    throw Object.assign(
      Error(
        data.error?.message ??
          data.message ??
          `Source returned HTTP ${r.status}`,
      ),
      { status: r.status },
    );
  return data;
}
export async function boundedText(r, max) {
  let size = 0;
  const parts = [];
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > max) throw Error("Response exceeds display limit");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
export async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );
    if (buffer.length > 4 * 1024 * 1024)
      throw Error("Event exceeds display limit");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = {};
      const lines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        if (line.startsWith("event:")) frame.type = line.slice(6).trim();
        if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
      }
      if (lines.length) frame.data = JSON.parse(lines.join("\n"));
      yield frame;
    }
  }
}
export class Hub {
  constructor(connections, store, notify) {
    this.connections = connections;
    this.store = store;
    this.notify = notify;
    this.streams = new Map();
    this.stopped = false;
    this.busy = false;
    this.refreshQueued = false;
    this.clean = sanitizer(
      Object.values(connections)
        .filter(Boolean)
        .map((c) => c.token),
    );
    this.state = {
      mimir: {},
      sindri: {
        projects: [],
        specs: [],
        plans: [],
        intakes: [],
        executions: [],
        deliveries: [],
      },
      sources: {},
      generatedAt: null,
    };
  }
  async start() {
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.refresh(), 3000);
    if (this.connections.mimir) {
      await this.replayMimir();
      this.stream("mimir", "/v1/events/stream", "mimir");
    }
  }
  async replayMimir() {
    try {
      for (let i = 0; i < 10000 && !this.stopped; i++) {
        const cursor = this.store.cursor("mimir");
        const page = await request(
          this.connections.mimir,
          "/v1/events?limit=500" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
        if (this.stopped) return;
        for (const d of page.events)
          this.store.event(
            "mimir",
            this.clean({
              schemaVersion: "1.0",
              eventId: d.id,
              source: "mimir",
              sourceSequence: d.sequence,
              sourceStream: d.streamId,
              timestamp: d.occurredAt,
              type: d.type,
              missionId: d.missionId,
              crewId: d.crewId,
              agentId: d.agentId,
              taskId: d.taskId,
              payload: d.payload,
              original: d,
            }),
          );
        if (page.lastCursor) this.store.setCursor("mimir", page.lastCursor);
        if (!page.hasMore) break;
      }
      this.notify();
    } catch (e) {
      this.state.sources.mimir.gap =
        "History replay incomplete: " + this.clean(e.message);
      this.notify();
    }
  }
  async refresh() {
    if (this.stopped) return;
    if (this.busy) {
      this.refreshQueued = true;
      return;
    }
    this.busy = true;
    await Promise.all(
      ["mimir", "sindri"].map(async (source) => {
        const c = this.connections[source];
        if (!c) {
          this.state.sources[source] = { status: "not configured" };
          return;
        }
        try {
          if (source === "mimir")
            this.state.mimir = await request(c, "/v1/snapshot");
          else {
            const { projects } = await request(c, "/v1/projects");
            const next = {
              projects,
              specs: [],
              plans: [],
              intakes: [],
              executions: [],
              deliveries: [],
            };
            for (const p of projects) {
              const parts = await Promise.all(
                ["specs", "plans", "intakes", "executions", "deliveries"].map(
                  (k) =>
                    request(
                      c,
                      `/v1/${k}?projectId=${encodeURIComponent(p.id)}`,
                    ).then((data) => [k, data[k]]),
                ),
              );
              for (const [k, rows] of parts) next[k].push(...rows);
            }
            // Execution details carry authoritative task mappings, gates, and escalations.
            next.executions = await Promise.all(
              next.executions.map((e) =>
                request(c, `/v1/executions/${encodeURIComponent(e.id)}`),
              ),
            );
            this.state.sindri = next;
            for (const { execution: e } of next.executions)
              this.stream(
                "sindri",
                `/v1/executions/${encodeURIComponent(e.id)}/events`,
                "sindri:" + e.id,
                e.id,
              );
            const active = new Set(
              next.executions.map((x) => "sindri:" + x.execution.id),
            );
            for (const [key, stream] of this.streams)
              if (key.startsWith("sindri:") && !active.has(key)) {
                stream.removed = true;
                stream.controller?.abort();
                this.streams.delete(key);
              }
          }
          this.state.sources[source] = {
            ...this.state.sources[source],
            url: c.url,
            status: "connected",
            lastSuccess: new Date().toISOString(),
            error: null,
          };
        } catch (e) {
          this.state.sources[source] = {
            ...this.state.sources[source],
            url: c.url,
            status: "disconnected",
            error: this.clean(e.message),
          };
        }
      }),
    );
    if (this.stopped) {
      this.busy = false;
      return;
    }
    this.store.updateNotifications(
      attentionRecords(this.state).map(this.clean),
    );
    this.state.generatedAt = new Date().toISOString();
    this.busy = false;
    this.notify();
    if (this.refreshQueued && !this.stopped) {
      this.refreshQueued = false;
      setTimeout(() => void this.refresh(), 100);
    }
  }
  stream(source, path, key, executionId) {
    if (this.stopped) return;
    if (this.streams.has(key)) return;
    const entry = { controller: null, removed: false };
    this.streams.set(key, entry);
    const run = async () => {
      while (!this.stopped && !entry.removed) {
        const controller = new AbortController();
        entry.controller = controller;
        let watchdog = setTimeout(() => controller.abort(), 45000);
        try {
          const cursor = this.store.cursor(key);
          const response = await fetch(this.connections[source].url + path, {
            headers: {
              authorization: `Bearer ${this.connections[source].token}`,
              ...(cursor ? { "last-event-id": cursor } : {}),
            },
            redirect: "error",
            signal: controller.signal,
          });
          if (response.status === 410) {
            if (this.stopped) return;
            this.store.setCursor(key, "");
            this.state.sources[source].gap =
              "Source cursor expired; older events are unavailable. Reconciled from snapshot.";
            await this.refresh();
            throw Error("Cursor expired");
          }
          if (!response.ok) throw Error(`Event stream HTTP ${response.status}`);
          for await (const frame of sseFrames(response.body)) {
            if (this.stopped) return;
            clearTimeout(watchdog);
            watchdog = setTimeout(() => controller.abort(), 45000);
            this.state.sources[source] = {
              ...this.state.sources[source],
              stream: "connected",
              lastStreamAt: new Date().toISOString(),
            };
            if (frame.type === "gap" || frame.type === "error")
              throw Error("Stream interrupted; reconnecting from saved cursor");
            if (
              frame.data &&
              (source === "mimir" || frame.type === "execution.event")
            ) {
              const d = frame.data;
              const event = this.clean({
                schemaVersion: "1.0",
                eventId: d.id ?? frame.id,
                source,
                sourceCursor: frame.id ?? null,
                sourceStream: key,
                sourceSequence: d.sequence ?? null,
                timestamp: d.occurredAt ?? d.createdAt ?? d.timestamp ?? null,
                type: d.type ?? frame.type,
                missionId: d.missionId,
                crewId: d.crewId,
                agentId: d.agentId,
                taskId: d.taskId,
                executionId,
                payload: d.payload ?? d,
                original: d,
              });
              if (event.eventId && this.store.event(key, event, frame.id)) {
                this.notify();
                void this.refresh();
              }
            } else if (frame.id) this.store.setCursor(key, frame.id);
          }
          throw Error("Event stream closed");
        } catch (e) {
          if (!this.stopped && !entry.removed) {
            this.state.sources[source] = {
              ...this.state.sources[source],
              stream: "reconnecting",
              streamError: this.clean(e.message),
            };
            this.notify();
          }
        } finally {
          clearTimeout(watchdog);
          controller.abort();
        }
        if (!this.stopped && !entry.removed)
          await new Promise((r) => {
            entry.delay = setTimeout(r, 2000);
            entry.wake = r;
          });
      }
    };
    void run();
  }
  snapshot() {
    return this.clean({
      ...this.state,
      events: this.store.events(),
      preferences: this.store.preferences(),
      notifications: this.store.notifications(),
      audit: this.store.audits(),
      retention:
        "Most recent 20,000 cached events; source IDs and per-stream cursors preserved.",
    });
  }
  async artifact(id) {
    const c = this.connections.mimir;
    const meta = await request(c, `/v1/artifacts/${id}`);
    const r = await fetch(c.url + `/v1/artifacts/${id}/content`, {
      headers: { authorization: `Bearer ${c.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok)
      throw Object.assign(Error(`Artifact unavailable (HTTP ${r.status})`), {
        status: r.status,
      });
    const chunks = [];
    let n = 0;
    for await (const b of r.body) {
      n += b.length;
      if (n > 12 * 1024 * 1024)
        throw Error("Artifact exceeds 12 MB preview limit");
      chunks.push(b);
    }
    const bytes = Buffer.concat(chunks);
    const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (meta.artifact.hash !== hash)
      throw Error("Artifact hash mismatch. Preview refused.");
    const type = r.headers.get("content-type") ?? "";
    return this.clean({
      artifact: meta.artifact,
      verifiedHash: hash,
      content: type.startsWith("image/") ? null : bytes.toString("utf8"),
      image: /^image\/(png|jpeg|webp)$/.test(type)
        ? `data:${type};base64,${bytes.toString("base64")}`
        : null,
    });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const e of this.streams.values()) {
      e.controller?.abort();
      clearTimeout(e.delay);
      e.wake?.();
    }
  }
}
