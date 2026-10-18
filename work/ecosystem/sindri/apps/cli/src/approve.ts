import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "@sindri/server";
import { CliError, dataDir, EXIT_CONFIG, EXIT_INFRA, tokenPath } from "./env.js";

export type ApproveKind = "spec" | "plan" | "pr";

/** Terminal access, injectable for tests. */
export interface ApproveIo {
  isTTY: boolean;
  prompt(question: string): Promise<string>;
  write(text: string): void;
}

export interface ApproveOptions {
  env?: NodeJS.ProcessEnv;
  io: ApproveIo;
  fetch?: typeof globalThis.fetch;
}

export interface ApproveResult {
  kind: ApproveKind;
  id: string;
  approvedBy: string;
}

const enc = encodeURIComponent;
const VIEW: Record<ApproveKind, (id: string) => string> = {
  spec: (id) => `/v1/specs/${enc(id)}`,
  plan: (id) => `/v1/plans/${enc(id)}`,
  pr: (id) => `/v1/executions/${enc(id)}`,
};
const ACTION: Record<ApproveKind, (id: string) => string> = {
  spec: (id) => `/v1/specs/${enc(id)}/approve`,
  plan: (id) => `/v1/plans/${enc(id)}/approve`,
  pr: (id) => `/v1/executions/${enc(id)}/pr`,
};

/**
 * `sindri approve <spec|plan|pr> <id>` (audit M9). A human approves at a terminal: the command
 * refuses to run without a TTY, asks for the pairing code shown by `sindri start`, and asks for
 * a typed confirmation (and, for a flagged spec, an explicit acknowledgement) before it mints an
 * approval secret and calls the approval route with it.
 */
export async function approve(
  kind: ApproveKind,
  id: string,
  o: ApproveOptions,
): Promise<ApproveResult> {
  const { io } = o;
  if (!io.isTTY)
    throw new CliError(
      "sindri approve needs an interactive terminal (TTY). This only stops piped or scripted use (agents can run in terminals too); the pairing code from the server terminal is the human check",
      EXIT_CONFIG,
    );
  const env = o.env ?? process.env;
  const doFetch = o.fetch ?? globalThis.fetch;
  let base: string;
  let token: string;
  try {
    const config = loadConfig(env);
    base = `${config.tls ? "https" : "http"}://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
    token = readFileSync(tokenPath(dataDir(env)), "utf8").trim();
  } catch (e) {
    throw new CliError(`cannot reach the Sindri server: ${(e as Error).message}`, EXIT_CONFIG);
  }
  const call = async (method: string, path: string, body?: unknown, extra = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError(`cannot reach the Sindri server at ${base}`, EXIT_INFRA);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = json["error"] as { code?: string; message?: string } | undefined;
      throw new CliError(
        `${method} ${path} failed (${res.status} ${err?.code ?? "error"}): ${err?.message ?? ""}`,
        EXIT_INFRA,
      );
    }
    return json;
  };

  const view = await call("GET", VIEW[kind](id));
  const flagged =
    kind === "spec" &&
    (view["meta"] as { untrustedInstructionDetected?: boolean } | undefined)
      ?.untrustedInstructionDetected === true;
  const title =
    ((view[kind === "pr" ? "execution" : kind] as Record<string, unknown> | undefined)?.[
      "title"
    ] as string | undefined) ?? "";
  io.write(
    `About to ${kind === "pr" ? "request a PR for execution" : `approve ${kind}`} ${id}${title ? `: ${title}` : ""}\n`,
  );

  const pairingCode = (await io.prompt("Pairing code (shown by `sindri start`): ")).trim();
  if (flagged) {
    io.write(
      "This spec was drafted from text with flagged untrusted instructions. Review them first.\n",
    );
    const ack = await io.prompt('Type "acknowledge" to approve it anyway: ');
    if (ack.trim() !== "acknowledge") throw new CliError(`${kind} ${id} not approved`, EXIT_CONFIG);
  }
  const confirm = await io.prompt(`Approve ${kind} ${id}? Type "yes": `);
  if (confirm.trim() !== "yes") throw new CliError(`${kind} ${id} not approved`, EXIT_CONFIG);

  const session = await call("POST", "/v1/approval-session", { pairingCode, channel: "cli" });
  const secret = String(session["approvalSecret"] ?? "");
  const result = await call(
    "POST",
    ACTION[kind](id),
    flagged ? { acknowledgeUntrusted: true } : {},
    { "x-sindri-approval": secret, "idempotency-key": randomUUID() },
  );
  const approvedBy =
    ((result[kind === "pr" ? "pr" : kind] as Record<string, unknown> | undefined)?.[
      "approvedBy"
    ] as string | undefined) ?? String(session["principal"] ?? "");
  return { kind, id, approvedBy };
}
