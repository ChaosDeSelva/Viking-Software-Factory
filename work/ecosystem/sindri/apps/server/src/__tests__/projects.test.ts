import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness;
let repo: TempRepo;
beforeEach(async () => {
  h = await makeHarness();
  repo = createTempRepo(
    {
      "README.md": "# Demo\n\nThe widget service renders invoices.\n",
      "docs/guide.md": "# Guide\n\nRun the frobnicator before deploy.\n",
      "package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest" } }),
      ".env": "SECRET=hunter2\n",
    },
    { git: true },
  );
});
afterEach(async () => {
  await h.close();
  repo.cleanup();
});

describe("projects", () => {
  it("creates, lists and gets projects", async () => {
    const created = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Demo", repoPath: repo.path },
    });
    expect(created.statusCode).toBe(201);
    const p = created.json().project;
    expect(p).toMatchObject({ id: expect.any(String), name: "Demo", repoPath: repo.path });
    const list = await h.call({ method: "GET", url: "/v1/projects" });
    expect(list.json().projects.map((x: { id: string }) => x.id)).toEqual([p.id]);
    const got = await h.call({ method: "GET", url: `/v1/projects/${p.id}` });
    expect(got.json().project.name).toBe("Demo");
  });

  it("404s an unknown project", async () => {
    const res = await h.call({ method: "GET", url: "/v1/projects/missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("rejects a repoPath that is not an existing directory", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "X", repoPath: "/definitely/not/here" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses /, the home directory and the Sindri data dir as repoPath", async () => {
    const { homedir } = await import("node:os");
    for (const repoPath of ["/", homedir(), h.dir]) {
      const res = await h.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "X", repoPath },
      });
      expect(res.statusCode, repoPath).toBe(422);
    }
  });

  it("bootstraps a project and searches the index", async () => {
    const p = (
      await h.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "D", repoPath: repo.path },
      })
    ).json().project;
    const boot = await h.call({
      method: "POST",
      url: `/v1/projects/${p.id}/bootstrap`,
      payload: {},
    });
    expect(boot.statusCode).toBe(200);
    const result = boot.json().result;
    expect(result.indexed).toEqual(expect.arrayContaining(["README.md", "docs/guide.md"]));
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ".env" })]),
    );
    const search = await h.call({
      method: "GET",
      url: `/v1/projects/${p.id}/search?q=frobnicator`,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().hits[0]).toMatchObject({ path: "docs/guide.md" });
    const empty = await h.call({ method: "GET", url: `/v1/projects/${p.id}/search?q=` });
    expect(empty.statusCode).toBe(422);
  });

  it("404s bootstrap and search for unknown projects", async () => {
    expect(
      (await h.call({ method: "POST", url: "/v1/projects/nope/bootstrap", payload: {} }))
        .statusCode,
    ).toBe(404);
    expect((await h.call({ method: "GET", url: "/v1/projects/nope/search?q=x" })).statusCode).toBe(
      404,
    );
  });
});
