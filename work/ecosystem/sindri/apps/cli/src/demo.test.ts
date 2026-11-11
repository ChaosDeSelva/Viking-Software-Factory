import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demo } from "./demo.js";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";

/** Lets a test swap writeDemoRepo; the real one runs otherwise. */
const repoOverride = vi.hoisted(() => ({
  fn: undefined as undefined | ((root: string) => unknown),
}));
vi.mock("@sindri/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sindri/server")>();
  return {
    ...real,
    writeDemoRepo: (root: string, o: { failingTest?: boolean }) =>
      repoOverride.fn ? repoOverride.fn(root) : real.writeDemoRepo(root, o),
  };
});

let home: string;
let data: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-demo-test-"));
  data = join(home, "data");
});
afterEach(() => {
  repoOverride.fn = undefined;
  rmSync(home, { recursive: true, force: true });
});
const envFor = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  SINDRI_DATA_DIR: data,
  SINDRI_SECRET_STORE: "env",
  ...extra,
});
const rejection = async (p: Promise<unknown>): Promise<CliError> => {
  const e = await p.then(
    () => new Error("expected a rejection"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
};

describe("demo", () => {
  it("creates the repo, project, bootstrap index and intake through the API", async () => {
    const dir = join(home, "d");
    const r = await demo({ dir, failingTest: true }, envFor());
    expect(r.repoPath).toBe(join(dir, "repo"));
    expect(r.failingTest).toBe("test/planted.test.js");
    expect(r.bootstrap.indexed).toBeGreaterThan(3);
    expect(r.bootstrap.skipped).toBeGreaterThanOrEqual(0);
    expect(r.url).toBe(`http://127.0.0.1:7800/#/inbox?project=${r.projectId}`);
    const db = openDatabase(join(data, "sindri.db"));
    try {
      expect(
        db.prepare("SELECT title FROM intakes WHERE id = ?").get(r.intakeId) as { title: string },
      ).toEqual({ title: "Add CSV export to the reports page" });
    } finally {
      db.close();
    }
  }, 120_000);

  it("defaults to a fresh temp dir, without a failing test, and honours TLS and IPv6 config", async () => {
    const r = await demo(
      {},
      envFor({ SINDRI_HOST: "::1", SINDRI_TLS_CERT: "c.pem", SINDRI_TLS_KEY: "k.pem" }),
    );
    try {
      expect(dirname(dirname(r.repoPath))).toBe(tmpdir());
      expect(r.failingTest).toBeNull();
      expect(r.url).toMatch(/^https:\/\/\[::1\]:7800\/#\/inbox\?project=/);
    } finally {
      rmSync(dirname(r.repoPath), { recursive: true, force: true });
    }
  }, 120_000);

  it("accepts an existing empty --dir and refuses a non-empty one with exit 2", async () => {
    const dir = join(home, "full");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "");
    const e = await rejection(demo({ dir }, envFor()));
    expect(e.exitCode).toBe(EXIT_CONFIG);
    expect(e.message).toBe(`${dir} is not empty; pick a new --dir`);
    expect(existsSync(data)).toBe(false);
  });

  it("exits 2 on a bad config before touching anything", async () => {
    const e = await rejection(demo({ dir: join(home, "d") }, envFor({ SINDRI_PORT: "0" })));
    expect(e.exitCode).toBe(EXIT_CONFIG);
    expect(e.message).toBe("Invalid SINDRI_PORT: 0");
    expect(existsSync(join(home, "d"))).toBe(false);
  });

  it("exits 3 with the API error when a request fails", async () => {
    repoOverride.fn = (root) => ({
      repoPath: join(root, "no-such-repo"),
      ticketPath: join(root, "ticket.json"),
      failingTest: null,
    });
    const e = await rejection(demo({ dir: join(home, "d") }, envFor()));
    expect(e.exitCode).toBe(EXIT_INFRA);
    expect(e.message).toMatch(/^demo: POST \/v1\/projects failed \(4\d\d\): /);
  });

  it("wraps an unexpected failure as exit 3", async () => {
    repoOverride.fn = () => {
      throw new Error("disk full");
    };
    const e = await rejection(demo({ dir: join(home, "d") }, envFor()));
    expect(e.exitCode).toBe(EXIT_INFRA);
    expect(e.message).toBe("demo failed: disk full");
  });
});
