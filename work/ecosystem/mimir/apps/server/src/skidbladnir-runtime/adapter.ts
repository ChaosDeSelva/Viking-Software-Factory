import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SshRuntime } from "../ssh-runtime/adapter.js";
import type { RemoteRequest, SshRoute, TransportResult } from "../ssh-runtime/transport.js";
export type SkidbladnirConfig = {
  url: string;
  template: "node" | "python" | "general";
  minutes: number;
  root: string;
  id: string;
};
type Worker = { id: string; state: string; final?: Record<string, unknown> };
type Command = {
  id: string;
  commandId?: string;
  status: string;
  stdout?: string;
  exitCode?: number;
};
/** Uses Skidbladnir's owned worker controls. The approved AMI must contain mimir-remote-entrypoint and the selected harness. */
export function skidbladnirRequester(
  config: SkidbladnirConfig,
  file: string,
  request: typeof fetch = fetch,
) {
  const url = new URL(config.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Skidbladnir requires a loopback IPv4 origin");
  if (!Number.isInteger(config.minutes) || config.minutes < 5 || config.minutes > 240)
    throw Error("Invalid worker lifetime");
  const identity = JSON.stringify(config);
  let workers: Record<string, Worker> = {};
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      identity: string;
      workers: Record<string, Worker>;
    };
    if (saved.identity !== identity)
      throw Error("Skidbladnir configuration changed with existing placement state");
    workers = saved.workers;
  }
  function save() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify({ identity, workers }), { mode: 0o600, flush: true });
    renameSync(temp, file);
  }
  async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      const session = await request(url.origin + "/api/session", {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!session.ok) throw Error("Skidbladnir authentication unavailable");
      const data = (await session.json()) as { token: string };
      headers["Content-Type"] = "application/json";
      headers["X-Skidbladnir-Token"] = data.token;
      if (key) headers["Idempotency-Key"] = key;
    }
    const response = await request(url.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error("Skidbladnir request failed: " + response.status);
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (!response.body) throw Error("Empty Skidbladnir response");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw Error("Skidbladnir response exceeds limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as T;
  }
  const pause = () => new Promise((r) => setTimeout(r, 1000));
  return async (_route: SshRoute, remote: RemoteRequest): Promise<TransportResult> => {
    try {
      if (remote.operation === "health") {
        const info = await api<{ mode: string; templates: string[] }>("/api/snapshot");
        return {
          state: "confirmed",
          response: {
            protocol: 1,
            ok: info.mode === "aws" && info.templates.includes(config.template),
          },
        };
      }
      if (!remote.jobId || !/^[A-Za-z0-9_-]{1,128}$/.test(remote.jobId))
        throw Error("Stable remote job identity required");
      const body = JSON.stringify({ protocol: 1, root: config.root, ...remote });
      // AWS Run Command parameters and inline output are bounded; never truncate a workspace or patch.
      if (Buffer.byteLength(body) > 4500)
        throw Error(
          "AWS inline mission exceeds 4500 bytes; use the SSH runtime for larger workspaces",
        );
      let worker = workers[remote.jobId];
      if (!worker) {
        if (remote.operation !== "submit")
          return { state: "unavailable", reason: "No recorded Skidbladnir worker for this job" };
        const key = createHash("sha256")
          .update(identity + remote.jobId)
          .digest("hex");
        worker = await api<Worker>(
          "/api/workers",
          {
            name: "Mimir " + remote.jobId.slice(0, 40),
            template: config.template,
            minutes: config.minutes,
          },
          key,
        );
        workers[remote.jobId] = worker;
        save();
      }
      if (worker.final) return { state: "confirmed", response: worker.final };
      const deadline = Date.now() + 180000;
      const workerId = worker.id;
      while (true) {
        const readiness = await api<{ ready: boolean; state: string }>(
          `/api/workers/${workerId}/readiness`,
        );
        if (readiness.ready) break;
        if (["failed", "terminated", "terminating"].includes(readiness.state))
          return { state: "unknown", reason: "AWS worker cannot execute: " + readiness.state };
        if (Date.now() > deadline)
          return { state: "unknown", reason: "AWS SSM readiness deadline exceeded" };
        await pause();
      }
      const encoded = Buffer.from(body).toString("base64");
      const command = "printf %s '" + encoded + "' | base64 -d | mimir-remote-entrypoint";
      // Submit retries reuse the API command identity. Inspect requests must obtain fresh evidence.
      const key =
        remote.operation === "submit"
          ? createHash("sha256")
              .update(identity + body)
              .digest("hex")
          : randomUUID();
      let record = await api<Command>(`/api/workers/${worker.id}/commands`, { command }, key);
      while (!["Success", "Failed", "TimedOut", "Cancelled", "Unknown"].includes(record.status)) {
        if (Date.now() > deadline)
          return { state: "unknown", reason: "SSM command outcome unconfirmed" };
        await pause();
        record = await api<Command>(`/api/commands/${record.id}/refresh`, {});
      }
      if (record.status !== "Success" || record.exitCode !== 0)
        return { state: "unknown", reason: "SSM transport did not confirm completion" };
      const response = JSON.parse(record.stdout ?? "") as Record<string, unknown>;
      if (response.protocol !== 1 || typeof response.ok !== "boolean")
        throw Error("Invalid remote protocol response");
      const job = response.job as { state?: string } | undefined;
      if (job && ["completed", "failed", "stopped"].includes(job.state ?? "")) {
        worker.final = response;
        workers[remote.jobId] = worker;
        save();
        // Preserve the complete protocol evidence locally before retiring disposable compute.
        try {
          await api(`/api/workers/${worker.id}/terminate`, {});
        } catch {
          /* Independent cloud expiry remains active if teardown is unavailable. */
        }
      }
      return { state: "confirmed", response };
    } catch (error) {
      return {
        state: "unknown",
        reason: error instanceof Error ? error.message : "Skidbladnir transport unavailable",
      };
    }
  };
}
export class SkidbladnirRuntime extends SshRuntime {
  constructor(config: SkidbladnirConfig, stateFile: string, request: typeof fetch = fetch) {
    super(
      { host: config.id, root: config.root },
      stateFile,
      skidbladnirRequester(config, stateFile + ".workers", request),
    );
  }
  override async capabilities() {
    return { ...(await super.capabilities()), runtime: "skidbladnir" };
  }
}
