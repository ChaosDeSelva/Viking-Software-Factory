import { afterEach, beforeEach, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness;
let url: string;
beforeEach(async () => {
  h = await makeHarness();
  const project = (
    await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Engine", repoPath: h.repoDir },
    })
  ).json().project;
  url = `/v1/projects/${project.id}/decision-log`;
});
afterEach(async () => {
  await h.close();
});

it("replays proposal writes and keeps a downloadable history behind the project credentials", async () => {
  const payload = {
    title: "Storage",
    decision: "Use SQLite",
    rationale: "One portable file",
    source: "spec:private-source",
  };
  expect((await h.app.inject({ url })).statusCode).toBe(401);
  const post = { method: "POST" as const, url, payload, key: "create-choice" };
  const first = await h.call(post);
  expect(first.statusCode).toBe(201);
  expect((await h.call(post)).json()).toEqual(first.json());
  const action = {
    method: "POST" as const,
    url: `${url}/${first.json().id}/decision`,
    payload: { decision: "accepted" },
  };
  expect((await h.call(action)).statusCode).toBe(403);
  expect((await h.call({ ...action, headers: await h.approvalHeaders() })).statusCode).toBe(200);
  const log = (await h.call({ url })).json();
  expect(log.entries).toHaveLength(1);
  expect(log.entries[0]).toMatchObject({
    ...payload,
    status: "accepted",
    exportBlockedReason: null,
    history: [{ status: "proposed" }, { status: "accepted" }],
  });
  const download = await h.call({ url: url + ".md" });
  expect(download.headers["content-type"]).toMatch(/text\/markdown/);
  expect(download.body).toEqual(log.markdown);
  await h.call({
    method: "POST",
    url,
    payload: { ...payload, title: "Local cache", decision: "Read /Users/alice/cache" },
  });
  const latest = (await h.call({ url })).json();
  expect(latest.entries[1].exportBlockedReason).toMatch(/statement contains a private reference/);
  expect((await h.call({ url: "/v1/projects/absent/decision-log" })).statusCode).toBe(404);
});
