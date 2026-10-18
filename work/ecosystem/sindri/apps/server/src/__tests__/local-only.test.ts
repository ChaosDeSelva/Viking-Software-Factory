import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../settings.js";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await h?.close();
  h = undefined;
});

const put = (hh: Harness, settings: Record<string, unknown>) =>
  hh.call({ method: "PUT", url: "/v1/settings", payload: { ...DEFAULT_SETTINGS, ...settings } });

describe("local-only mode (audit M8)", () => {
  it("rejects a remote LLM provider while local-only is on", async () => {
    const hh = (h = await makeHarness());
    const res = await put(hh, { provider: "anthropic", localOnly: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("local_only");
    expect((await put(hh, { provider: "null", localOnly: true })).statusCode).toBe(200);
    expect((await put(hh, { provider: "fake", localOnly: true })).statusCode).toBe(200);
    expect((await put(hh, { provider: "anthropic", localOnly: false })).statusCode).toBe(200);
  });

  it("rejects a non-loopback Mimir URL while local-only is on", async () => {
    const hh = (h = await makeHarness());
    const res = await put(hh, { localOnly: true, mimirUrl: "https://mimir.example.com" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("local_only");
    for (const url of ["http://127.0.0.1:7700", "http://localhost:7700", "http://[::1]:7700"])
      expect((await put(hh, { localOnly: true, mimirUrl: url })).statusCode).toBe(200);
    expect(
      (await put(hh, { localOnly: false, mimirUrl: "https://mimir.example.com" })).statusCode,
    ).toBe(200);
  });

  it("uses the null provider for stored remote settings while local-only is on (no egress)", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be used")));
    vi.stubGlobal("fetch", fetchSpy);
    const hh = (h = await makeHarness({
      secrets: { get: () => Promise.resolve("sk-test-not-used") },
    }));
    // A row written before this check existed (or by hand).
    new SettingsStore(hh.db, () => new Date()).put({
      ...DEFAULT_SETTINGS,
      provider: "anthropic",
      apiKeySecret: "anthropic.api-key",
      localOnly: true,
    });
    const projectId = (
      await hh.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "P", repoPath: hh.repoDir },
      })
    ).json().project.id;
    const res = await hh.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId, request: "Add CSV export" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
