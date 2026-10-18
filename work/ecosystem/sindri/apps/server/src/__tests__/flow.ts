import { FakeProvider } from "@sindri/director";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { expect } from "vitest";
import type { BuildServerOptions } from "../app.js";
import { demoPlanResponder } from "../demo-plan-responder.js";
import { makeHarness, type Harness } from "./helpers.js";

export interface Flow {
  h: Harness;
  repo: TempRepo;
  provider: FakeProvider;
  projectId: string;
  close(): Promise<void>;
}

/** A server with the demo responders (spec + plan), one project on a temp git repo. */
export async function startFlow(opts: Partial<BuildServerOptions> = {}): Promise<Flow> {
  const repo = createTempRepo(
    { "README.md": "# Reports\n\nThe reports page lists invoices and totals.\n" },
    { git: true },
  );
  const provider = new FakeProvider(demoPlanResponder());
  const h = await makeHarness({ providerFactory: () => provider, ...opts });
  const res = await h.call({
    method: "POST",
    url: "/v1/projects",
    payload: { name: "Reports", repoPath: repo.path },
  });
  expect(res.statusCode).toBe(201);
  return {
    h,
    repo,
    provider,
    projectId: res.json().project.id as string,
    async close() {
      await h.close();
      repo.cleanup();
    },
  };
}

/** Draft, answer Q1, submit and approve: returns the approved spec id. */
export async function approvedSpec(f: Flow): Promise<string> {
  const d = await f.h.call({
    method: "POST",
    url: "/v1/director/draft",
    payload: { projectId: f.projectId, request: "Add CSV export to the reports page" },
  });
  expect(d.statusCode).toBe(201);
  const a = await f.h.call({
    method: "POST",
    url: `/v1/specs/${d.json().spec.id}/answer`,
    payload: { questionId: "Q1", answer: "Date and total" },
  });
  expect(a.statusCode).toBe(201);
  const id = a.json().spec.id as string;
  expect(
    (await f.h.call({ method: "POST", url: `/v1/specs/${id}/submit`, payload: {} })).statusCode,
  ).toBe(200);
  expect(
    (
      await f.h.call({
        method: "POST",
        url: `/v1/specs/${id}/approve`,
        payload: {},
        headers: await f.h.approvalHeaders(),
      })
    ).statusCode,
  ).toBe(200);
  return id;
}

/** Propose, submit and approve a plan for an approved spec: returns the plan. */
export async function approvedPlan(f: Flow, specId: string) {
  const p = await f.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
  expect(p.statusCode).toBe(201);
  const id = p.json().plan.id as string;
  expect(
    (await f.h.call({ method: "POST", url: `/v1/plans/${id}/submit`, payload: {} })).statusCode,
  ).toBe(200);
  const ok = await f.h.call({
    method: "POST",
    url: `/v1/plans/${id}/approve`,
    payload: {},
    headers: await f.h.approvalHeaders(),
  });
  expect(ok.statusCode).toBe(200);
  return ok.json().plan as { id: string; version: number; tasks: { id: string }[] };
}
