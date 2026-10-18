import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = new URL("../dist/main.js", import.meta.url).pathname;
const MISSION = "msn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let home: string;
let data: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-cli-"));
  data = join(home, "data");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  execa(process.execPath, [MAIN, ...args], {
    reject: false,
    extendEnv: false,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, MIMIR_DATA_DIR: data, ...env },
  });

interface Check {
  name: string;
  status: string;
  detail: string;
}
const check = (stdout: string, name: string): Check =>
  (JSON.parse(stdout).checks as Check[]).find((c) => c.name === name) as Check;

describe("mimir init", () => {
  it("creates the data dir and a 0600 token, idempotently", async () => {
    const a = await run(["init", "--json"]);
    expect(a.exitCode).toBe(0);
    const out = JSON.parse(a.stdout);
    expect(out.dataDir).toBe(data);
    expect(out.tokenCreated).toBe(true);
    const tokenPath = join(data, "auth-token");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenPath, "utf8");
    expect(token.trim().length).toBeGreaterThanOrEqual(32);
    const b = JSON.parse((await run(["init", "--json"])).stdout);
    expect(b.tokenCreated).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe(token);
  });
  it("writes config.json once and never overwrites it", async () => {
    await run(["init"]);
    const p = join(data, "config.json");
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 7700,
      dataDir: data,
      herdrSession: "mimir",
    });
    writeFileSync(p, '{"port":9}');
    await run(["init"]);
    expect(readFileSync(p, "utf8")).toBe('{"port":9}');
  });
  it("exits 3 when the data dir cannot be created", async () => {
    writeFileSync(join(home, "file"), "x");
    const r = await run(["init", "--json"], { MIMIR_DATA_DIR: join(home, "file", "sub") });
    expect(r.exitCode).toBe(3);
  });
});

describe("mimir token show", () => {
  it("prints the token, and exits 2 when none exists", async () => {
    const none = await run(["token", "show", "--json"]);
    expect(none.exitCode).toBe(2);
    await run(["init"]);
    const r = await run(["token", "show", "--json"]);
    expect(r.exitCode).toBe(0);
    const token = JSON.parse(r.stdout).token;
    expect(token).toBe(readFileSync(join(data, "auth-token"), "utf8").trim());
    expect((await run(["token", "show"])).stdout.trim()).toBe(token);
  });
  it("honours MIMIR_AUTH_TOKEN", async () => {
    const r = await run(["token", "show"], { MIMIR_AUTH_TOKEN: "env-token" });
    expect(r.stdout.trim()).toBe("env-token");
  });
});

describe("mimir doctor", () => {
  it("emits structured checks as JSON", async () => {
    const r = await run(["doctor", "--json"]);
    const out = JSON.parse(r.stdout);
    const names = out.checks.map((c: Check) => c.name);
    for (const n of [
      "node",
      "pnpm",
      "git",
      "herdr",
      "herdr-socket",
      "gh",
      "claude",
      "codex",
      "data-dir",
    ]) {
      expect(names).toContain(n);
    }
    expect([0, 3]).toContain(r.exitCode);
    expect(out.ok).toBe(r.exitCode === 0);
  });
  it("fails with exit 3 and a failed herdr check when tools are missing", async () => {
    const r = await run(["doctor", "--json"], { PATH: "/nonexistent" });
    expect(r.exitCode).toBe(3);
    expect(check(r.stdout, "herdr").status).toBe("fail");
  });
  it("parses the herdr version and checks >= 0.9.0", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fake = (v: string) =>
      writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "herdr ${v}"\n`, { mode: 0o755 });
    const PATH = `${bin}:${process.env["PATH"] ?? ""}`;
    fake("0.8.9");
    expect(check((await run(["doctor", "--json"], { PATH })).stdout, "herdr").status).toBe("fail");
    fake("0.9.4");
    const kc = check((await run(["doctor", "--json"], { PATH })).stdout, "herdr");
    expect(kc.status).toBe("ok");
    expect(kc.detail).toContain("0.9.4");
  });
});

describe("mimir export", () => {
  it("writes the mission's events as JSON", async () => {
    mkdirSync(data, { recursive: true });
    const store = openEventStore(join(data, "mimir.db"));
    const now = new Date().toISOString();
    const base = {
      occurredAt: now,
      observedAt: now,
      source: "mimir",
      provenance: "observed" as const,
    };
    store.append({
      ...base,
      streamId: MISSION,
      type: "task.created",
      missionId: MISSION as never,
      payload: { n: 1 },
    });
    store.append({ ...base, streamId: "other", type: "task.created", payload: { n: 2 } });
    store.close();
    const out = join(home, "out.json");
    const r = await run(["export", "--mission", MISSION, "--out", out, "--json"]);
    expect(r.exitCode).toBe(0);
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(file.missionId).toBe(MISSION);
    expect(file.events).toHaveLength(1);
    expect(file.events[0].payload).toEqual({ n: 1 });
    expect(JSON.parse(r.stdout).count).toBe(1);
  });
  it("exits 2 without --mission and 3 when the store is missing", async () => {
    expect((await run(["export", "--out", join(home, "x.json")])).exitCode).toBe(2);
    const r = await run(["export", "--mission", MISSION, "--out", join(home, "x.json")]);
    expect(r.exitCode).toBe(3);
  });
});

function seed(count: number, payload: unknown = { n: 1 }): void {
  mkdirSync(data, { recursive: true });
  const store = openEventStore(join(data, "mimir.db"));
  const now = new Date().toISOString();
  const base = {
    occurredAt: now,
    observedAt: now,
    source: "mimir",
    provenance: "observed" as const,
  };
  store.appendMany(
    Array.from({ length: count }, () => ({
      ...base,
      streamId: MISSION,
      type: "task.created" as const,
      missionId: MISSION as never,
      payload: payload as Record<string, unknown>,
    })),
  );
  store.close();
}

describe("mimir export (fix round 1)", () => {
  it("terminates and returns every event across multiple pages", async () => {
    seed(1200);
    const out = join(home, "big.json");
    const r = await run(["export", "--mission", MISSION, "--out", out, "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).events).toHaveLength(1200);
  }, 30_000);
  it("works while another process holds the store open (read-only, no lock)", async () => {
    seed(2);
    const holder = openEventStore(join(data, "mimir.db"));
    try {
      const out = join(home, "held.json");
      const r = await run(["export", "--mission", MISSION, "--out", out, "--json"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).events).toHaveLength(2);
    } finally {
      holder.close();
    }
  });
  it("redacts secrets, writes mode 0600, refuses to overwrite without --force", async () => {
    seed(1, { note: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end" });
    const out = join(home, "r.json");
    const r = await run(["export", "--mission", MISSION, "--out", out, "--json"]);
    expect(r.exitCode).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const again = await run(["export", "--mission", MISSION, "--out", out]);
    expect(again.exitCode).toBe(2);
    const forced = await run(["export", "--mission", MISSION, "--out", out, "--force"]);
    expect(forced.exitCode).toBe(0);
  });
});

describe("mimir doctor socket (fix round 1)", () => {
  it("is existence-only: labels it present, creates nothing, spawns only `--version` probes", async () => {
    const sessionDir = join(home, ".config/herdr/sessions/mimir");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "herdr.sock"), "");
    const bin = join(home, "bin");
    mkdirSync(bin);
    const log = join(home, "calls.log");
    writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "$@" >> "${log}"\necho "herdr 0.9.4"\n`, {
      mode: 0o755,
    });
    const before = readdirSync(sessionDir);
    const r = await run(["doctor", "--json"], { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    const sock = check(r.stdout, "herdr-socket");
    expect(sock.detail).toMatch(/present/);
    expect(sock.detail).not.toMatch(/reachable/);
    expect(readdirSync(sessionDir)).toEqual(before);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["--version"]);
  });
  it("reports not running and creates no session dir when the socket is absent", async () => {
    const r = await run(["doctor", "--json"]);
    expect(check(r.stdout, "herdr-socket").detail).toMatch(/not running/);
    expect(existsSync(join(home, ".config/herdr"))).toBe(false);
  });
});
