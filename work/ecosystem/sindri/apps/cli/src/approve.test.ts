import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, type ApproveIo } from "./approve.js";
import { CliError, EXIT_CONFIG } from "./env.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-approve-"));
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "data", "auth-token"), "tok".repeat(20), { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const env = () => ({ HOME: home, SINDRI_DATA_DIR: join(home, "data"), SINDRI_PORT: "7999" });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake server: GETs return `views`, the session mint and the approve POST succeed. */
function fakeFetch(views: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const path = new URL(url).pathname;
    if (method === "GET")
      return Response.json(views[path] ?? {}, { status: views[path] ? 200 : 404 });
    if (path === "/v1/approval-session")
      return Response.json(
        { approvalSecret: "S".repeat(43), principal: "local:me/cli#aps_1", expiresAt: "x" },
        { status: 201 },
      );
    return Response.json({
      spec: { id: "s1", status: "approved", approvedBy: "local:me/cli#aps_1" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const io = (answers: string[], isTTY = true): ApproveIo & { out: string[] } => {
  const out: string[] = [];
  return {
    isTTY,
    out,
    prompt: (q) => {
      out.push(q);
      return Promise.resolve(answers.shift() ?? "");
    },
    write: (t) => void out.push(t),
  };
};

describe("sindri approve (audit M9)", () => {
  it("refuses without a TTY and makes no request", async () => {
    const f = fakeFetch({});
    const err = await approve("spec", "s1", {
      env: env(),
      io: io([], false),
      fetch: f.fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CONFIG);
    expect((err as CliError).message).toMatch(/interactive terminal/);
    expect(f.calls).toEqual([]);
  });

  it("asks for the pairing code and a confirmation, then approves with the approval header", async () => {
    const f = fakeFetch({ "/v1/specs/s1": { spec: { id: "s1", title: "CSV" }, meta: {} } });
    const r = await approve("spec", "s1", {
      env: env(),
      io: io(["ABCDE-FGH23", "yes"]),
      fetch: f.fetch,
    });
    expect(r).toMatchObject({ kind: "spec", id: "s1", approvedBy: "local:me/cli#aps_1" });
    const [, mint, post] = f.calls;
    expect(mint).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7999/v1/approval-session",
      body: { pairingCode: "ABCDE-FGH23", channel: "cli" },
    });
    expect(post).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7999/v1/specs/s1/approve",
    });
    expect(post!.headers["x-sindri-approval"]).toBe("S".repeat(43));
    expect(post!.headers["authorization"]).toBe(`Bearer ${"tok".repeat(20)}`);
    expect(post!.headers["idempotency-key"]).toBeTruthy();
    expect(post!.body).toEqual({});
  });

  it("requires typing acknowledge for a flagged spec, and stops on anything but yes", async () => {
    const flagged = {
      "/v1/specs/s1": { spec: { id: "s1" }, meta: { untrustedInstructionDetected: true } },
    };
    const a = fakeFetch(flagged);
    await approve("spec", "s1", {
      env: env(),
      io: io(["ABCDE-FGH23", "acknowledge", "yes"]),
      fetch: a.fetch,
    });
    expect(a.calls.at(-1)!.body).toEqual({ acknowledgeUntrusted: true });

    const b = fakeFetch(flagged);
    await expect(
      approve("spec", "s1", { env: env(), io: io(["ABCDE-FGH23", "nope"]), fetch: b.fetch }),
    ).rejects.toThrow(/not approved/);
    const c = fakeFetch({ "/v1/plans/p1": { plan: { id: "p1" } } });
    await expect(
      approve("plan", "p1", { env: env(), io: io(["ABCDE-FGH23", "y"]), fetch: c.fetch }),
    ).rejects.toThrow(/not approved/);
    for (const x of [b, c]) expect(x.calls.filter((k) => k.method === "POST")).toEqual([]);
  });

  it("requests a PR for an execution through the same factor", async () => {
    const f = fakeFetch({
      "/v1/executions/e1": { execution: { id: "e1", status: "verified_pending_review" } },
    });
    await approve("pr", "e1", { env: env(), io: io(["ABCDE-FGH23", "yes"]), fetch: f.fetch });
    expect(f.calls.at(-1)).toMatchObject({ url: "http://127.0.0.1:7999/v1/executions/e1/pr" });
  });
});
