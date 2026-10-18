import type { Connector } from "@sindri/intake";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../settings.js";
import { makeHarness, type Harness } from "./helpers.js";

const fakeJira: Connector = {
  kind: "jira",
  canHandle: (url) => url.startsWith("https://acme.atlassian.net/browse/"),
  parseUrl: (url) => ({ source: "jira", key: url.split("/").pop() ?? "", url }),
  fetchIssue: (ref) =>
    Promise.resolve({
      source: "jira",
      externalId: ref.key,
      url: ref.url,
      title: "Remote <b>ticket</b>",
      body: "Do the thing<script>alert(1)</script>",
      updated: "2026-01-01T00:00:00Z",
      raw: { secretish: "raw payload" },
    }),
};

let h: Harness;
let projectId: string;
beforeEach(async () => {
  h = await makeHarness({ connectorFactory: () => [fakeJira] });
  projectId = (
    await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "P", repoPath: h.repoDir },
    })
  ).json().project.id;
});
afterEach(async () => {
  await h.close();
});

describe("intakes", () => {
  it("creates a manual intake and returns a sanitized display copy", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: {
        projectId,
        title: "Add export",
        body: "Please <script>x()</script>add CSV export",
      },
    });
    expect(res.statusCode).toBe(201);
    const intake = res.json().intake;
    expect(intake).toMatchObject({ projectId, source: "manual", title: "Add export" });
    // Raw text stays server-side; every string in the response is display-sanitized.
    expect(intake.body).toBe("Please add CSV export");
    expect(intake.display.body).toBe("Please add CSV export");
    expect(intake.snapshot).toBeUndefined();
  });

  it("lists by project and gets detail with comments", async () => {
    const id = (
      await h.call({
        method: "POST",
        url: "/v1/intakes",
        payload: { projectId, title: "A", body: "b" },
      })
    ).json().intake.id;
    const list = await h.call({ method: "GET", url: `/v1/intakes?projectId=${projectId}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().intakes.map((i: { id: string }) => i.id)).toEqual([id]);
    const detail = await h.call({ method: "GET", url: `/v1/intakes/${id}` });
    expect(detail.json().intake.id).toBe(id);
    expect(detail.json().comments).toEqual([]);
    expect((await h.call({ method: "GET", url: "/v1/intakes" })).statusCode).toBe(422);
    expect((await h.call({ method: "GET", url: "/v1/intakes/nope" })).statusCode).toBe(404);
  });

  it("validates input and 404s an unknown project", async () => {
    expect(
      (
        await h.call({
          method: "POST",
          url: "/v1/intakes",
          payload: { projectId, title: "", body: "" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await h.call({
          method: "POST",
          url: "/v1/intakes",
          payload: { projectId: "nope", title: "t", body: "b" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("refuses import with 503 local_only while local-only mode is on (the default)", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/intakes/import",
      payload: { projectId, url: "https://acme.atlassian.net/browse/PROJ-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("local_only");
  });

  it("imports through a configured connector when local-only is off", async () => {
    new SettingsStore(h.db, () => new Date()).put({ ...DEFAULT_SETTINGS, localOnly: false });
    const res = await h.call({
      method: "POST",
      url: "/v1/intakes/import",
      payload: { projectId, url: "https://acme.atlassian.net/browse/PROJ-1" },
    });
    expect(res.statusCode).toBe(201);
    const intake = res.json().intake;
    expect(intake).toMatchObject({ source: "jira", externalId: "PROJ-1" });
    expect(intake.display.title).toBe("Remote ticket");
    expect(JSON.stringify(res.json())).not.toContain("raw payload");
    const none = await h.call({
      method: "POST",
      url: "/v1/intakes/import",
      payload: { projectId, url: "https://example.com/x" },
    });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe("no_connector");
  });

  it("limits a manual intake body to the connector field cap (review m6)", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId, title: "Big", body: "a".repeat(64 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(422);
  });
});
