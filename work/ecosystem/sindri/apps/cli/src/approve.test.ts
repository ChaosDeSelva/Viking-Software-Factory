import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve, type ApproveIo } from "./approve.js";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";

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

const unexpected = (): never => {
  throw new Error("expected a rejection");
};
const asCliError = (e: unknown) => e as CliError;

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

  it("requires typing acknowledge for a flagged plan too", async () => {
    const flagged = { "/v1/plans/p1": { plan: { id: "p1", untrustedInstructionDetected: true } } };
    const a = fakeFetch(flagged);
    await approve("plan", "p1", {
      env: env(),
      io: io(["ABCDE-FGH23", "acknowledge", "yes"]),
      fetch: a.fetch,
    });
    expect(a.calls.at(-1)!.body).toEqual({ acknowledgeUntrusted: true });
    const b = fakeFetch(flagged);
    await expect(
      approve("plan", "p1", { env: env(), io: io(["ABCDE-FGH23", "yes"]), fetch: b.fetch }),
    ).rejects.toThrow(/not approved/);
    expect(b.calls.filter((k) => k.method === "POST")).toEqual([]);
  });

  it("requests a PR for an execution through the same factor", async () => {
    const f = fakeFetch({
      "/v1/executions/e1": { execution: { id: "e1", status: "verified_pending_review" } },
    });
    await approve("pr", "e1", { env: env(), io: io(["ABCDE-FGH23", "yes"]), fetch: f.fetch });
    expect(f.calls.at(-1)).toMatchObject({ url: "http://127.0.0.1:7999/v1/executions/e1/pr" });
  });

  it("approves a plan, and falls back to the session principal for approvedBy", async () => {
    const f = fakeFetch({ "/v1/plans/p1": { plan: { id: "p1", title: "Plan" } } });
    const r = await approve("plan", "p1", {
      env: env(),
      io: io(["ABCDE-FGH23", "yes"]),
      fetch: f.fetch,
    });
    expect(f.calls.at(-1)).toMatchObject({ url: "http://127.0.0.1:7999/v1/plans/p1/approve" });
    expect(r.approvedBy).toBe("local:me/cli#aps_1");
  });

  it("encodes the id into one path segment", async () => {
    const f = fakeFetch({});
    await approve("spec", "a/../b?c", { env: env(), io: io([]), fetch: f.fetch }).catch(
      () => undefined,
    );
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7999/v1/specs/a%2F..%2Fb%3Fc");
  });

  it("refuses an empty or dot-segment id, which would resolve to another route", async () => {
    for (const id of ["", ".", ".."]) {
      const f = fakeFetch({});
      const err = await approve("pr", id, {
        env: env(),
        io: io(["ABCDE-FGH23", "yes"]),
        fetch: f.fetch,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT_CONFIG);
      expect(f.calls).toEqual([]);
    }
  });

  it("strips terminal control characters from the server-supplied title", async () => {
    const f = fakeFetch({
      "/v1/specs/s1": {
        spec: { id: "s1", title: "CSV\u001b[2K\r\nThis spec is safe\u0007\u009b" },
        meta: {},
      },
    });
    const t = io(["ABCDE-FGH23", "yes"]);
    await approve("spec", "s1", { env: env(), io: t, fetch: f.fetch });
    expect(t.out[0]).toBe("About to approve spec s1: CSV[2KThis spec is safe\n");
  });

  it("exits 2 when the config or the token cannot be read", async () => {
    const f = fakeFetch({});
    const noToken = await approve("spec", "s1", {
      env: { ...env(), SINDRI_DATA_DIR: join(home, "missing") },
      io: io([]),
      fetch: f.fetch,
    }).then(unexpected, asCliError);
    expect(noToken.exitCode).toBe(EXIT_CONFIG);
    expect(noToken.message).toMatch(/^cannot reach the Sindri server: .*auth-token/);
    const badPort = await approve("spec", "s1", {
      env: { ...env(), SINDRI_PORT: "x" },
      io: io([]),
      fetch: f.fetch,
    }).then(unexpected, asCliError);
    expect(badPort.message).toContain("Invalid SINDRI_PORT");
    expect(f.calls).toEqual([]);
  });

  it("uses https and brackets an IPv6 host from the config", async () => {
    const f = fakeFetch({});
    await approve("spec", "s1", {
      env: { ...env(), SINDRI_HOST: "::1", SINDRI_TLS_CERT: "c", SINDRI_TLS_KEY: "k" },
      io: io([]),
      fetch: f.fetch,
    }).catch(() => undefined);
    expect(f.calls[0]!.url).toBe("https://[::1]:7999/v1/specs/s1");
  });

  it("exits 3 when the server is unreachable or answers with an error", async () => {
    const down = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const unreachable = await approve("spec", "s1", {
      env: env(),
      io: io([]),
      fetch: down,
    }).then(unexpected, asCliError);
    expect(unreachable.exitCode).toBe(EXIT_INFRA);
    expect(unreachable.message).toBe("cannot reach the Sindri server at http://127.0.0.1:7999");

    const missing = await approve("spec", "nope", {
      env: env(),
      io: io([]),
      fetch: fakeFetch({}).fetch,
    }).then(unexpected, asCliError);
    expect(missing.exitCode).toBe(EXIT_INFRA);
    expect(missing.message).toBe("GET /v1/specs/nope failed (404 error): ");

    const coded = (async () =>
      Response.json(
        { error: { code: "conflict", message: "already approved" } },
        { status: 409 },
      )) as typeof fetch;
    const conflict = await approve("spec", "s1", {
      env: env(),
      io: io([]),
      fetch: coded,
    }).then(unexpected, asCliError);
    expect(conflict.message).toBe("GET /v1/specs/s1 failed (409 conflict): already approved");

    const html = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
    const proxy = await approve("spec", "s1", { env: env(), io: io([]), fetch: html }).then(
      unexpected,
      asCliError,
    );
    expect(proxy.message).toBe("GET /v1/specs/s1 failed (502 error): ");
  });

  it("stops before approving when the pairing code is rejected, and never prints the secret", async () => {
    const calls: string[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v1/approval-session")
        return Response.json(
          { error: { code: "approval_denied", message: "wrong pairing code" } },
          { status: 403 },
        );
      return Response.json({ spec: { id: "s1" } });
    }) as typeof fetch;
    const t = io(["WRONG-CODE1", "yes"]);
    const err = await approve("spec", "s1", { env: env(), io: t, fetch: f }).then(
      unexpected,
      asCliError,
    );
    expect(err.message).toContain("403 approval_denied");
    expect(calls).toEqual(["GET /v1/specs/s1", "POST /v1/approval-session"]);
    expect(t.out.join("") + err.message).not.toContain("tok".repeat(20));
  });

  it("sends an empty approval header and reports no approver for a malformed session reply", async () => {
    const calls: Record<string, string>[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      calls.push(headers);
      return new URL(String(input)).pathname === "/v1/specs/s1"
        ? Response.json({ spec: { id: "s1" } })
        : Response.json({});
    }) as typeof fetch;
    const r = await approve("spec", "s1", { env: env(), io: io(["C", "yes"]), fetch: f });
    expect(r.approvedBy).toBe("");
    expect(calls.at(-1)!["x-sindri-approval"]).toBe("");
  });

  it("defaults to process.env and the global fetch against a real loopback server", async () => {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "spec not found" } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    vi.stubEnv("HOME", home);
    vi.stubEnv("SINDRI_DATA_DIR", join(home, "data"));
    vi.stubEnv("SINDRI_PORT", String(port));
    try {
      const err = await approve("spec", "s9", { io: io([]) }).then(unexpected, asCliError);
      expect(err.message).toBe("GET /v1/specs/s9 failed (404 not_found): spec not found");
      expect(seen).toEqual([`GET /v1/specs/s9 Bearer ${"tok".repeat(20)}`]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise((r) => srv.close(r));
    }
  });
});
