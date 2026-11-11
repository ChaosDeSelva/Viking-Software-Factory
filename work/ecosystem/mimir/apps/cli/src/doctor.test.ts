import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor, parseVersion, versionAtLeast, type DoctorCheck } from "./doctor.js";

let home: string;
let bin: string;
let data: string;
let env: NodeJS.ProcessEnv;
const realVersions = Object.getOwnPropertyDescriptor(process, "versions")!;

/** A fake tool on the test PATH that prints `out` and exits with `code`. */
const tool = (name: string, out: string, code = 0): void =>
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${out}"\nexit ${code}\n`, { mode: 0o755 });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-doctor-"));
  bin = join(home, "bin");
  data = join(home, "data");
  mkdirSync(bin);
  tool("pnpm", "12.1.0");
  tool("git", "git version 2.45.1");
  tool("herdr", "herdr 0.9.2");
  tool("gh", "gh version 2.60.0 (2026-01-01)\nhttps://example.invalid/release");
  tool("claude", "2.0.0 (Claude Code)");
  tool("codex", "codex-cli 1.2.3");
  // Only the fake tools are on PATH, so nothing installed on this machine is ever run.
  env = { PATH: bin, HOME: home, MIMIR_DATA_DIR: data };
});
afterEach(() => {
  Object.defineProperty(process, "versions", realVersions);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const byName = (checks: DoctorCheck[], name: string): DoctorCheck =>
  checks.find((c) => c.name === name) as DoctorCheck;

const withNodeVersion = (node: string): void => {
  Object.defineProperty(process, "versions", {
    ...realVersions,
    value: { ...process.versions, node },
  });
};

describe("parseVersion", () => {
  it("finds the first dotted version, defaulting a missing patch to 0", () => {
    expect(parseVersion("git version 2.45.1")).toEqual([2, 45, 1]);
    expect(parseVersion("v12.3")).toEqual([12, 3, 0]);
    expect(parseVersion("herdr 0.10.0-rc.1 (protocol 22)")).toEqual([0, 10, 0]);
  });
  it("returns null when there is no version", () => {
    expect(parseVersion("unknown")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("7")).toBeNull();
  });
});

describe("versionAtLeast", () => {
  it("compares major, then minor, then patch numerically", () => {
    expect(versionAtLeast([2, 38, 0], [2, 38, 0])).toBe(true);
    expect(versionAtLeast([2, 38, 1], [2, 38, 0])).toBe(true);
    expect(versionAtLeast([2, 37, 9], [2, 38, 0])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 38, 0])).toBe(true);
    expect(versionAtLeast([1, 99, 99], [2, 0, 0])).toBe(false);
    expect(versionAtLeast([0, 10, 0], [0, 9, 0])).toBe(true);
    expect(versionAtLeast([0, 9, 0], [0, 9, 1])).toBe(false);
  });
});

describe("doctor", () => {
  it("is healthy when every required tool is present and recent, in a fixed check order", () => {
    const r = doctor(env);
    expect(r.checks.map((c) => c.name)).toEqual([
      "node",
      "pnpm",
      "git",
      "herdr",
      "herdr-socket",
      "gh",
      "claude",
      "codex",
      "data-dir",
    ]);
    expect(r.ok).toBe(true);
    expect(byName(r.checks, "node")).toMatchObject({ status: "ok", required: true });
    expect(byName(r.checks, "pnpm")).toMatchObject({ status: "ok", detail: "12.1.0" });
    expect(byName(r.checks, "git")).toMatchObject({ status: "ok", detail: "2.45.1 (>= 2.38.0)" });
    expect(byName(r.checks, "herdr")).toMatchObject({ status: "ok", detail: "0.9.2 (>= 0.9.0)" });
    // Only the first output line is shown.
    expect(byName(r.checks, "gh")).toMatchObject({
      status: "ok",
      detail: "gh version 2.60.0 (2026-01-01)",
      required: false,
    });
    expect(byName(r.checks, "data-dir")).toMatchObject({
      status: "ok",
      detail: `${data} writable`,
    });
  });

  it("fails when Node is older than 25", () => {
    withNodeVersion("24.9.0");
    const r = doctor(env);
    expect(byName(r.checks, "node")).toMatchObject({ status: "fail", detail: "24.9.0 (>= 25)" });
    expect(r.ok).toBe(false);
  });

  it("fails when the Node version cannot be parsed", () => {
    withNodeVersion("unknown");
    const r = doctor(env);
    expect(byName(r.checks, "node").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("fails on a missing required tool and only warns on a missing optional one", () => {
    rmSync(join(bin, "gh"));
    rmSync(join(bin, "claude"));
    rmSync(join(bin, "codex"));
    const optional = doctor(env);
    for (const name of ["gh", "claude", "codex"]) {
      expect(byName(optional.checks, name)).toMatchObject({
        status: "warn",
        detail: `${name} not found on PATH`,
      });
    }
    expect(optional.ok).toBe(true);

    rmSync(join(bin, "pnpm"));
    const required = doctor(env);
    expect(byName(required.checks, "pnpm")).toMatchObject({
      status: "fail",
      detail: "pnpm not found on PATH",
    });
    expect(required.ok).toBe(false);
  });

  it("treats a tool that exits non-zero as unavailable", () => {
    tool("git", "git version 2.45.1", 1);
    const r = doctor(env);
    expect(byName(r.checks, "git").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("fails a required tool that is too old, naming both versions", () => {
    tool("git", "git version 2.37.9");
    const r = doctor(env);
    expect(byName(r.checks, "git")).toMatchObject({
      status: "fail",
      detail: "2.37.9 is older than required 2.38.0",
    });
    expect(r.ok).toBe(false);
  });

  it("fails a required tool whose version cannot be parsed", () => {
    tool("herdr", "herdr development build");
    const r = doctor(env);
    expect(byName(r.checks, "herdr")).toMatchObject({
      status: "fail",
      detail: 'cannot parse version from "herdr development build"',
    });
    expect(r.ok).toBe(false);
  });

  it("warns, without failing, when the herdr socket is absent and reports it when present", () => {
    const sock = join(home, ".config/herdr/sessions/mimir/herdr.sock");
    const absent = doctor(env);
    expect(byName(absent.checks, "herdr-socket")).toMatchObject({
      status: "warn",
      required: false,
      detail: `session "mimir" not running (${sock} absent)`,
    });
    expect(absent.ok).toBe(true);
    mkdirSync(join(home, ".config/herdr/sessions/mimir"), { recursive: true });
    writeFileSync(sock, "");
    const present = byName(doctor(env).checks, "herdr-socket");
    expect(present.status).toBe("ok");
    expect(present.detail).toContain(sock);
  });

  it("checks the nearest existing ancestor of a data dir that does not exist yet", () => {
    const r = doctor({ ...env, MIMIR_DATA_DIR: join(home, "a", "b", "c") });
    expect(byName(r.checks, "data-dir").status).toBe("ok");
  });

  it("fails when the data dir is not writable", () => {
    mkdirSync(data, { mode: 0o500 });
    try {
      const r = doctor(env);
      expect(byName(r.checks, "data-dir")).toMatchObject({
        status: "fail",
        detail: `${data} not writable`,
      });
      expect(r.ok).toBe(false);
    } finally {
      chmodSync(data, 0o700);
    }
  });

  it("fails when the data dir, or one of its ancestors, is a file", () => {
    const file = join(home, "file");
    writeFileSync(file, "x");
    for (const dir of [file, join(file, "sub")]) {
      const r = doctor({ ...env, MIMIR_DATA_DIR: dir });
      expect(byName(r.checks, "data-dir")).toMatchObject({
        status: "fail",
        detail: `${dir} not writable`,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("reads process.env by default, and the OS home when HOME is empty", () => {
    vi.stubEnv("PATH", bin);
    vi.stubEnv("HOME", home);
    vi.stubEnv("MIMIR_DATA_DIR", data);
    expect(doctor().ok).toBe(true);
    // os.homedir() follows the stubbed process HOME, so the real home is not consulted.
    const r = doctor({ PATH: bin, HOME: "", MIMIR_DATA_DIR: data });
    expect(byName(r.checks, "herdr-socket").detail).toContain(
      join(home, ".config/herdr/sessions/mimir/herdr.sock"),
    );
  });
});
