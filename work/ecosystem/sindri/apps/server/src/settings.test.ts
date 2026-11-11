import { openDatabase, applyMigrations } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { SERVER_MIGRATIONS } from "./schema.js";
import { DEFAULT_SETTINGS, effectiveProvider, SettingsSchema, SettingsStore } from "./settings.js";

describe("settings", () => {
  it("refuses URLs that do not parse or are not http(s), and secret values as key names", () => {
    const parse = (over: Record<string, unknown>) =>
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...over }).success;
    expect(parse({ mimirUrl: "not a url" })).toBe(false);
    expect(parse({ mimirUrl: "file:///etc/passwd" })).toBe(false);
    expect(parse({ mimirUrl: "http://127.0.0.1:7700" })).toBe(true);
    expect(parse({ apiKeySecret: "sk-ant-123" })).toBe(false);
    expect(parse({ apiKeySecret: "anthropic.api-key" })).toBe(true);
  });

  it("falls back to the defaults for a stored row that no longer validates", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, "server", SERVER_MIGRATIONS);
    db.prepare(
      "INSERT INTO server_settings (id, settings_json, updated_at) VALUES (1, ?, '2026-01-01')",
    ).run(JSON.stringify({ provider: "gone" }));
    expect(new SettingsStore(db, () => new Date()).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("runs a remote provider only with local-only off", () => {
    expect(effectiveProvider({ ...DEFAULT_SETTINGS, provider: "anthropic" })).toBe("null");
    expect(
      effectiveProvider({ ...DEFAULT_SETTINGS, provider: "anthropic", localOnly: false }),
    ).toBe("anthropic");
  });
});
