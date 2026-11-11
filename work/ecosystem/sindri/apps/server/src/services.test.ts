import { JiraConnector, LinearConnector } from "@sindri/intake";
import { openDatabase } from "@sindri/knowledge";
import type { Director } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { connectorsFromSettings, createServices } from "./services.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const secrets = { get: () => Promise.resolve(undefined) };

describe("connectorsFromSettings", () => {
  it("builds Jira and Linear connectors from configured handles, none without a SecretStore", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      connectors: {
        jira: { baseUrl: "https://x.atlassian.net", email: "a@b.c", apiTokenSecret: "jira.token" },
        linear: { apiKeySecret: "linear.key" },
      },
    };
    const built = connectorsFromSettings(settings, secrets);
    expect(built.map((c) => c.constructor)).toEqual([JiraConnector, LinearConnector]);
    expect(connectorsFromSettings(settings)).toEqual([]);
    expect(connectorsFromSettings(DEFAULT_SETTINGS, secrets)).toEqual([]);
    expect(
      connectorsFromSettings(
        { ...DEFAULT_SETTINGS, connectors: { linear: { apiKeySecret: "linear.key" } } },
        secrets,
      ).map((c) => c.constructor),
    ).toEqual([LinearConnector]);
  });
});

describe("createServices", () => {
  it("uses a fixed director when given one", () => {
    const director = {
      draftSpec: () => Promise.reject(new Error("unused")),
    } as unknown as Director;
    const s = createServices({ db: openDatabase(":memory:"), director });
    expect(s.director()).toBe(director);
  });

  it("rebuilds the director only when the provider settings change", () => {
    const s = createServices({ db: openDatabase(":memory:"), secrets });
    const a = s.director();
    expect(s.director()).toBe(a);
    s.settings.put({ ...s.settings.get(), provider: "fake" });
    expect(s.director()).not.toBe(a);
  });

  it("plans in the working checkout without a data directory, whatever commit is asked for", async () => {
    const s = createServices({ db: openDatabase(":memory:") });
    expect(s.dataDir).toBeNull();
    const ws = await s.planningWorkspace(
      { id: "prj_1", repoPath: "/repo" },
      { commit: "a".repeat(40), alsoStartsFrom: ["b".repeat(40)] },
    );
    expect(ws).toMatchObject({ path: "/repo", label: expect.stringContaining("working checkout") });
  });
});
