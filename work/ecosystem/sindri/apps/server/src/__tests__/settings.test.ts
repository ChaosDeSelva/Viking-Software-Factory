import { FakeProvider } from "@sindri/director";
import { openDatabase } from "@sindri/knowledge";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { strFromU8, unzipSync } from "fflate";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoResponder } from "../demo-responder.js";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness({ providerFactory: () => new FakeProvider(demoResponder()) });
});
afterEach(async () => {
  await h.close();
});

describe("settings", () => {
  it("returns defaults with a token location hint", async () => {
    const res = await h.call({ method: "GET", url: "/v1/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      provider: "null",
      localOnly: true,
      model: expect.any(String),
    });
    expect(res.json().tokenLocation).toBe(join(h.dir, "auth-token"));
  });

  it("stores settings with SecretStore handles and never accepts literal secrets", async () => {
    const settings = {
      provider: "anthropic",
      model: "claude-fable-5-1",
      localOnly: false,
      mimirUrl: "http://127.0.0.1:7700",
      brokkrEnabled: false,
      apiKeySecret: "anthropic.api-key",
      connectors: {
        jira: {
          baseUrl: "https://acme.atlassian.net",
          email: "me@acme.test",
          apiTokenSecret: "jira.api-token",
        },
        linear: { apiKeySecret: "linear.api-key" },
      },
    };
    const put = await h.call({ method: "PUT", url: "/v1/settings", payload: settings });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).toEqual(settings);
    expect((await h.call({ method: "GET", url: "/v1/settings" })).json().settings).toEqual(
      settings,
    );

    const literal = await h.call({
      method: "PUT",
      url: "/v1/settings",
      payload: { ...settings, apiKey: "sk-ant-api03-secret" },
    });
    expect(literal.statusCode).toBe(422);
    const tokenAsHandle = await h.call({
      method: "PUT",
      url: "/v1/settings",
      payload: { ...settings, apiKeySecret: "sk-ant-api03-abcdef" },
    });
    expect(tokenAsHandle.statusCode).toBe(422);
    const badProvider = await h.call({
      method: "PUT",
      url: "/v1/settings",
      payload: { ...settings, provider: "openai" },
    });
    expect(badProvider.statusCode).toBe(422);
  });
});

describe("export and delete", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ "README.md": "# Demo\n\nHello export.\n" }, { git: true });
  });
  afterEach(() => repo.cleanup());

  const setup = async () => {
    const p = (
      await h.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Exp", repoPath: repo.path },
      })
    ).json().project;
    await h.call({ method: "POST", url: `/v1/projects/${p.id}/bootstrap`, payload: {} });
    await h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId: p.id, request: "Add CSV export" },
    });
    return p as { id: string; name: string };
  };

  it("exports a zip with a SQLite snapshot and settings without secrets", async () => {
    const p = await setup();
    const res = await h.call({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="sindri-export-.*\.zip"/,
    );
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "settings.json", "sindri.db"]);
    expect(strFromU8(files["sindri.db"]!.slice(0, 15))).toBe("SQLite format 3");
    expect(JSON.parse(strFromU8(files["settings.json"]!))).toMatchObject({ provider: "null" });
    const dbFile = join(h.dir, "exported.db");
    writeFileSync(dbFile, files["sindri.db"]!);
    const copy = openDatabase(dbFile);
    expect(copy.prepare("SELECT id FROM projects").all()).toEqual([{ id: p.id }]);
    copy.close();
  });

  it("deletes a project's data only with the project name as confirmation", async () => {
    const p = await setup();
    const no = await h.call({
      method: "DELETE",
      url: `/v1/projects/${p.id}/data`,
      payload: { confirm: "wrong" },
    });
    expect(no.statusCode).toBe(422);
    expect(no.json().error.code).toBe("confirmation_required");
    const missing = await h.call({
      method: "DELETE",
      url: `/v1/projects/${p.id}/data`,
      payload: {},
    });
    expect(missing.statusCode).toBe(422);
    const ok = await h.call({
      method: "DELETE",
      url: `/v1/projects/${p.id}/data`,
      payload: { confirm: "Exp" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: { projectId: p.id } });
    expect((await h.call({ method: "GET", url: `/v1/projects/${p.id}` })).statusCode).toBe(404);
    for (const table of ["documents", "intakes", "specifications", "director_runs"])
      expect(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(
      (await h.call({ method: "DELETE", url: "/v1/projects/nope/data", payload: { confirm: "x" } }))
        .statusCode,
    ).toBe(404);
  });

  it("refuses to delete a project with immutable task evidence", async () => {
    const p = await setup();
    h.db
      .prepare(
        "INSERT INTO task_evidence (id, project_id, external_ref, kind, payload_json, created_at) VALUES ('ev1', ?, 'x', 'k', '{}', 'now')",
      )
      .run(p.id);
    const res = await h.call({
      method: "DELETE",
      url: `/v1/projects/${p.id}/data`,
      payload: { confirm: "Exp" },
    });
    expect(res.statusCode).toBe(409);
  });
});
