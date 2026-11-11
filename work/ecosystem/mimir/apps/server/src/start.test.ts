import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openEventStore } from "@mimir/core";
import { injectCorruptEventRow, type SqlDb } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "./config.js";
import { startMimir, type StartedMimir } from "./start.js";

const dirs: string[] = [];
const started: StartedMimir[] = [];
afterEach(async () => {
  for (const m of started.splice(0)) await m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Env for a loopback server on a free port with all state under a fresh temp dir. */
function tempEnv(extra: Env = {}): { env: Env; dataDir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-start-")));
  dirs.push(dir);
  const dataDir = join(dir, "data");
  return {
    dataDir,
    env: {
      MIMIR_HOST: "127.0.0.1",
      MIMIR_PORT: "0",
      MIMIR_DATA_DIR: dataDir,
      MIMIR_WORKTREE_ROOT: join(dir, "worktrees"),
      MIMIR_LOG_LEVEL: "silent",
      MIMIR_TICK_MS: "0",
      ...extra,
    },
  };
}

/** The store's single-writer lock is free again: a second open of the same db succeeds. */
function expectStoreReleased(dataDir: string): void {
  const store = openEventStore(join(dataDir, "mimir.db"));
  store.close();
}

describe("startMimir", () => {
  it("boots on a free loopback port with a generated 0600 token and serves the API", async () => {
    const { env, dataDir } = tempEnv();
    const m = await startMimir(env);
    started.push(m);
    expect(m.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(m.url).not.toMatch(/:0$/);
    expect(m.config.runtime).toBe("fake");
    expect(m.auth.source).toBe("generated");
    expect(m.auth.path).toBe(join(dataDir, "auth-token"));
    expect(statSync(join(dataDir, "auth-token")).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dataDir, "auth-token"), "utf8").trim()).toBe(m.auth.token);

    const health = await fetch(`${m.url}/v1/health`);
    expect(health.status).toBe(200);
    const denied = await fetch(`${m.url}/v1/projects`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`${m.url}/v1/projects`, {
      headers: { authorization: `Bearer ${m.auth.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ projects: [] });
  });

  it("close() stops listening and releases the store; a restart reuses the token file", async () => {
    const { env, dataDir } = tempEnv();
    const first = await startMimir(env);
    const url = first.url;
    await first.close();
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
    expectStoreReleased(dataDir);
    const second = await startMimir(env);
    started.push(second);
    expect(second.auth).toEqual({ ...first.auth, source: "file" });
  });

  it("takes the token from MIMIR_AUTH_TOKEN without writing a token file", async () => {
    const token = "e".repeat(40);
    const { env } = tempEnv({ MIMIR_AUTH_TOKEN: token });
    const m = await startMimir(env);
    started.push(m);
    expect(m.auth).toEqual({ token, source: "env", path: null });
    const res = await fetch(`${m.url}/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("runs without a runtime (MIMIR_RUNTIME=none)", async () => {
    const { env } = tempEnv({ MIMIR_RUNTIME: "none" });
    const m = await startMimir(env);
    started.push(m);
    expect(m.runtime).toBeNull();
    const caps = await fetch(`${m.url}/v1/capabilities`, {
      headers: { authorization: `Bearer ${m.auth.token}` },
    });
    expect(((await caps.json()) as { runtime: unknown }).runtime).toBeNull();
  });

  it("brackets an IPv6 loopback host in the URL", async () => {
    const { env } = tempEnv({ MIMIR_HOST: "::1" });
    const m = await startMimir(env);
    started.push(m);
    expect(m.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect((await fetch(`${m.url}/v1/health`)).status).toBe(200);
  });

  it("boots on a log with a corrupt row and reports it as degraded health", async () => {
    const { env, dataDir } = tempEnv();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const seed = openEventStore(join(dataDir, "mimir.db"));
    seed.close();
    const raw = openDatabase(join(dataDir, "mimir.db"));
    injectCorruptEventRow(raw as unknown as SqlDb);
    raw.close();
    const m = await startMimir(env);
    started.push(m);
    const health = (await (await fetch(`${m.url}/v1/health`)).json()) as {
      status: string;
      integrity: { refusedRows: number };
    };
    expect(health.status).toBe("degraded");
    expect(health.integrity.refusedRows).toBe(1);
  });

  it("ssh without a host fails the boot (logging at the default level) and releases the store", async () => {
    const { env, dataDir } = tempEnv({ MIMIR_RUNTIME: "ssh" });
    delete env["MIMIR_LOG_LEVEL"];
    await expect(startMimir(env)).rejects.toThrow();
    expectStoreReleased(dataDir);
  });

  it("an invalid config throws before the data dir is created", async () => {
    const { env, dataDir } = tempEnv({ MIMIR_RUNTIME: "bogus" });
    await expect(startMimir(env)).rejects.toThrow(/Invalid MIMIR_RUNTIME/);
    expect(() => statSync(dataDir)).toThrow();
  });

  // A web root without index.html makes buildServer throw after the runtime was constructed:
  // every runtime choice goes through the failure cleanup (runtime disposed, store closed)
  // without the server ever starting, so no runtime talks to anything.
  it.each(["fake", "cli", "tmux", "ssh", "herdr", "tmux-interactive", "zellij", "fleet", "none"])(
    "runtime %s: a failed boot disposes the runtime and releases the store",
    async (runtime) => {
      const { env, dataDir } = tempEnv({
        MIMIR_RUNTIME: runtime,
        MIMIR_WEB_ROOT: join(tmpdir(), "mimir-start-no-such-web-root"),
        MIMIR_SSH_HOST: "worker.invalid",
        MIMIR_SSH_ROOT: "/srv/mimir",
      });
      await expect(startMimir(env)).rejects.toThrow();
      expectStoreReleased(dataDir);
    },
  );

  it("a remote bind with unreadable TLS files fails before listening and releases the store", async () => {
    const { env, dataDir } = tempEnv({
      MIMIR_HOST: "192.0.2.10",
      MIMIR_ALLOW_REMOTE: "1",
      MIMIR_PUBLIC_ORIGINS: "https://mimir.example:7700",
      MIMIR_TLS_CERT: "/nonexistent/cert.pem",
      MIMIR_TLS_KEY: "/nonexistent/key.pem",
    });
    await expect(startMimir(env)).rejects.toThrow(/ENOENT/);
    expectStoreReleased(dataDir);
  });

  it("a port already in use rejects and releases the store", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    try {
      const { port } = blocker.address() as { port: number };
      const { env, dataDir } = tempEnv({ MIMIR_PORT: String(port) });
      await expect(startMimir(env)).rejects.toThrow(/EADDRINUSE/);
      expectStoreReleased(dataDir);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("serves MIMIR_WEB_ROOT from the API origin (with optional tunables set)", async () => {
    const web = realpathSync(mkdtempSync(join(tmpdir(), "mimir-start-web-")));
    dirs.push(web);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>mimir</title>");
    const { env } = tempEnv({
      MIMIR_WEB_ROOT: web,
      MIMIR_APPROVAL_TTL_MS: "60000",
      MIMIR_CAPACITY_WAIT_MS: "5000",
    });
    const m = await startMimir(env);
    started.push(m);
    expect(m.config).toMatchObject({ approvalTtlMs: 60000, capacityWaitMs: 5000, webRoot: web });
    const page = await fetch(`${m.url}/missions/x`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>mimir</title>");
  });
});
