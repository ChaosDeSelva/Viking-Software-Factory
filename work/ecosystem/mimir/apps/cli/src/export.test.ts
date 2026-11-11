import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./env.js";
import { exportMission } from "./export.js";

const MISSION = "msn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-export-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("exportMission pagination", () => {
  it("terminates and exports every event across several pages", () => {
    const data = join(home, "data");
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
      Array.from({ length: 1201 }, (_, i) => ({
        ...base,
        streamId: i % 2 ? MISSION : "other",
        type: "task.created" as const,
        ...(i % 2 ? { missionId: MISSION as never } : {}),
        payload: { i },
      })),
    );
    store.close();
    const out = join(home, "out.json");
    const r = exportMission(MISSION, out, {}, { ...process.env, MIMIR_DATA_DIR: data });
    expect(r.count).toBe(600);
    const file = JSON.parse(readFileSync(out, "utf8")) as { events: { payload: { i: number } }[] };
    expect(file.events.map((e) => e.payload.i)).toEqual(
      Array.from({ length: 600 }, (_, k) => 2 * k + 1),
    );
  }, 10_000);
});

describe("exportMission", () => {
  let data: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    data = join(home, "data");
    env = { HOME: home, MIMIR_DATA_DIR: data };
  });

  const seed = (payloads: Record<string, unknown>[]): void => {
    mkdirSync(data, { recursive: true });
    const store = openEventStore(join(data, "mimir.db"));
    const now = new Date().toISOString();
    store.appendMany(
      payloads.map((payload) => ({
        occurredAt: now,
        observedAt: now,
        source: "mimir",
        provenance: "observed" as const,
        streamId: MISSION,
        type: "task.created" as const,
        missionId: MISSION as never,
        payload,
      })),
    );
    store.close();
  };

  const cliError = (fn: () => unknown): CliError => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      return e as CliError;
    }
    throw new Error("expected a CliError");
  };

  it("writes a 0600 file with redacted payloads and reports what it wrote", () => {
    seed([{ note: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end" }, { n: 2 }]);
    const out = join(home, "deep", "er", "out.json");
    const r = exportMission(MISSION, out, {}, env);
    expect(r).toEqual({ missionId: MISSION, out, count: 2 });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text.endsWith("\n")).toBe(true);
    const file = JSON.parse(text) as {
      missionId: string;
      exportedAt: string;
      events: { type: string; payload: unknown }[];
    };
    expect(file.missionId).toBe(MISSION);
    expect(new Date(file.exportedAt).toISOString()).toBe(file.exportedAt);
    expect(file.events.map((e) => e.type)).toEqual(["task.created", "task.created"]);
    expect(file.events[1]?.payload).toEqual({ n: 2 });
  });

  it("exports an empty list for a mission without events", () => {
    seed([{ n: 1 }]);
    const out = join(home, "none.json");
    const r = exportMission("msn_01ARZ3NDEKTSV4RRFFQ69G5FAA", out, {}, env);
    expect(r.count).toBe(0);
    expect((JSON.parse(readFileSync(out, "utf8")) as { events: unknown[] }).events).toEqual([]);
  });

  it("fails with exit 3, writing nothing, when there is no event store", () => {
    const out = join(home, "out.json");
    const e = cliError(() => exportMission(MISSION, out, {}, env));
    expect(e.exitCode).toBe(3);
    expect(e.message).toBe(`no event store at ${join(data, "mimir.db")}`);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses to overwrite an existing file (exit 2) and leaves it untouched", () => {
    seed([{ n: 1 }]);
    const out = join(home, "out.json");
    writeFileSync(out, "precious");
    const e = cliError(() => exportMission(MISSION, out, {}, env));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("--force");
    expect(readFileSync(out, "utf8")).toBe("precious");
  });

  it("does not write through a dangling symlink at the output path", () => {
    seed([{ n: 1 }]);
    const out = join(home, "link.json");
    const target = join(home, "elsewhere.json");
    symlinkSync(target, out);
    const e = cliError(() => exportMission(MISSION, out, {}, env));
    expect(e.exitCode).toBe(3);
    expect(readdirSync(home).sort()).toEqual(["data", "link.json"]);
  });

  it("overwrites with force, and the result is 0600 even if the old file was not", () => {
    seed([{ n: 1 }]);
    const out = join(home, "out.json");
    writeFileSync(out, "old", { mode: 0o644 });
    const r = exportMission(MISSION, out, { force: true }, env);
    expect(r.count).toBe(1);
    expect((JSON.parse(readFileSync(out, "utf8")) as { events: unknown[] }).events).toHaveLength(1);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("fails with exit 3 when the store cannot be opened", () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "mimir.db"), "this is not a database, ".repeat(200));
    const out = join(home, "out.json");
    const e = cliError(() => exportMission(MISSION, out, {}, env));
    expect(e.exitCode).toBe(3);
    expect(e.message).toMatch(/^export failed: /);
    expect(readdirSync(home)).toEqual(["data"]);
  });

  it("fails with exit 3 when the output path is a directory", () => {
    seed([{ n: 1 }]);
    const out = join(home, "dir");
    mkdirSync(out);
    const e = cliError(() => exportMission(MISSION, out, { force: true }, env));
    expect(e.exitCode).toBe(3);
    expect(e.message).toMatch(/^export failed: /);
  });

  it("reads process.env by default", () => {
    seed([{ n: 1 }]);
    vi.stubEnv("MIMIR_DATA_DIR", data);
    const out = join(home, "env.json");
    expect(exportMission(MISSION, out).count).toBe(1);
  });
});
