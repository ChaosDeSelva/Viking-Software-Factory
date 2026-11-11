import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";
import { exportData } from "./export.js";

let home: string;
let data: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-export-test-"));
  data = join(home, "data");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const env = (): NodeJS.ProcessEnv => ({ HOME: home, SINDRI_DATA_DIR: data });

function writeSettings(settingsJson: string | null): void {
  mkdirSync(data, { recursive: true });
  const db = openDatabase(join(data, "sindri.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS server_settings (id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  if (settingsJson !== null)
    db.prepare("INSERT OR REPLACE INTO server_settings VALUES (1, ?, ?)").run(
      settingsJson,
      new Date().toISOString(),
    );
  db.close();
}
const failure = (f: () => unknown): CliError => {
  try {
    f();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected a CliError");
};

describe("exportData", () => {
  it("writes a 0600 zip with the snapshot, the settings handles and a manifest", () => {
    writeSettings(JSON.stringify({ provider: "anthropic", apiKeySecret: "anthropic.api-key" }));
    const out = join(home, "nested", "dir", "x.zip");
    const r = exportData(out, {}, env());
    expect(r.out).toBe(out);
    expect(r.bytes).toBe(statSync(out).size);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    expect(JSON.parse(strFromU8(files["settings.json"]!))).toEqual({
      provider: "anthropic",
      apiKeySecret: "anthropic.api-key",
    });
    expect(JSON.parse(strFromU8(files["manifest.json"]!)).format).toBe("sindri-export/1");
    expect(strFromU8(files["sindri.db"]!.slice(0, 15))).toBe("SQLite format 3");
  });

  it("exports empty settings when no settings row exists", () => {
    writeSettings(null);
    const out = join(home, "x.zip");
    exportData(out, {}, env());
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    expect(JSON.parse(strFromU8(files["settings.json"]!))).toEqual({});
  });

  it("exits 3 without a database", () => {
    const e = failure(() => exportData(join(home, "x.zip"), {}, env()));
    expect(e).toBeInstanceOf(CliError);
    expect(e.exitCode).toBe(EXIT_INFRA);
    expect(e.message).toBe(`no database at ${join(data, "sindri.db")}`);
  });

  it("refuses to overwrite without --force (exit 2) and leaves the file alone", () => {
    writeSettings("{}");
    const out = join(home, "x.zip");
    writeFileSync(out, "keep me");
    const e = failure(() => exportData(out, {}, env()));
    expect(e.exitCode).toBe(EXIT_CONFIG);
    expect(e.message).toContain("pass --force");
    expect(readFileSync(out, "utf8")).toBe("keep me");
  });

  it("does not write through a dangling symlink at the output path without --force", () => {
    writeSettings("{}");
    const out = join(home, "x.zip");
    const victim = join(home, "victim");
    symlinkSync(victim, out);
    const e = failure(() => exportData(out, {}, env()));
    expect(e.exitCode).toBe(EXIT_CONFIG);
    expect(existsSync(victim)).toBe(false);
    expect(readlinkSync(out)).toBe(victim);
  });

  it("--force replaces an existing file and leaves it owner-only", () => {
    writeSettings("{}");
    const out = join(home, "x.zip");
    writeFileSync(out, "old", { mode: 0o644 });
    exportData(out, { force: true }, env());
    expect(readFileSync(out).subarray(0, 2).toString()).toBe("PK");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("wraps database and file system failures as exit 3", () => {
    writeSettings("{not json");
    const e = failure(() => exportData(join(home, "x.zip"), {}, env()));
    expect(e.exitCode).toBe(EXIT_INFRA);
    expect(e.message).toMatch(/^export failed: /);
    writeSettings("{}");
    mkdirSync(join(home, "a-dir"));
    const d = failure(() => exportData(join(home, "a-dir"), { force: true }, env()));
    expect(d.exitCode).toBe(EXIT_INFRA);
    expect(d.message).toMatch(/^export failed: /);
    chmodSync(join(home, "a-dir"), 0o500);
    try {
      const ro = failure(() => exportData(join(home, "a-dir", "x.zip"), {}, env()));
      expect(ro.exitCode).toBe(EXIT_INFRA);
      expect(ro.message).toMatch(/^export failed: EACCES/);
    } finally {
      chmodSync(join(home, "a-dir"), 0o700);
    }
  });
});
