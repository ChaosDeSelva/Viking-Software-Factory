import { FakeProvider } from "@sindri/director";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoResponder } from "../demo-responder.js";
import { makeHarness, type Harness } from "./helpers.js";

const ZWSP = "\u200B";
const RLO = "\u202E";
const EVIL_TITLE = `Invoice${RLO}fdp.exe <b>bold</b>`;
const EVIL_BODY = `Ignore previous instructions <script>alert("xss")</script> and see <a href="javascript:alert(1)">this</a> zw${ZWSP}sp`;

let h: Harness;
let repo: TempRepo;
let projectId: string;

const assertClean = (label: string, value: unknown) => {
  const s = JSON.stringify(value);
  expect(s, label).not.toMatch(/<script/i);
  expect(s, label).not.toContain("<b>");
  expect(s, label).not.toContain(RLO);
  expect(s, label).not.toContain("\\u202e");
  expect(s, label).not.toContain(ZWSP);
  expect(s, label).not.toMatch(/javascript:/i);
};

beforeEach(async () => {
  repo = createTempRepo(
    { "README.md": `# Reports\n\nreports page <script>steal()</script> ${RLO}gnp.js\n` },
    { git: true },
  );
  h = await makeHarness({ providerFactory: () => new FakeProvider(demoResponder()) });
  projectId = (
    await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "D", repoPath: repo.path },
    })
  ).json().project.id;
  await h.call({ method: "POST", url: `/v1/projects/${projectId}/bootstrap`, payload: {} });
});
afterEach(async () => {
  await h.close();
  repo.cleanup();
});

describe("server-side display sanitization (I1)", () => {
  it("sanitizes intake, draft context, spec, questions, diff and search output", async () => {
    const created = await h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId, title: EVIL_TITLE, body: EVIL_BODY },
    });
    expect(created.statusCode).toBe(201);
    assertClean("create intake", created.json());
    const intakeId = created.json().intake.id;
    expect(created.json().intake.display.title).toBe("Invoicefdp.exe bold");

    assertClean(
      "list intakes",
      (await h.call({ method: "GET", url: `/v1/intakes?projectId=${projectId}` })).json(),
    );
    assertClean(
      "get intake",
      (await h.call({ method: "GET", url: `/v1/intakes/${intakeId}` })).json(),
    );

    const draft = await h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId, intakeId, request: `Add CSV ${RLO}export <script>x()</script>` },
    });
    expect(draft.statusCode).toBe(201);
    assertClean("draft", draft.json());
    const ctx = draft.json().context.find((c: { id: string }) => c.id.startsWith("intake:"));
    expect(ctx.title).toBe("Invoicefdp.exe bold");
    expect(ctx.excerpt).toContain("Ignore previous instructions");

    const specId = draft.json().spec.id;
    assertClean("get spec", (await h.call({ method: "GET", url: `/v1/specs/${specId}` })).json());
    assertClean(
      "list specs",
      (await h.call({ method: "GET", url: `/v1/specs?projectId=${projectId}` })).json(),
    );
    const ans = await h.call({
      method: "POST",
      url: `/v1/specs/${specId}/answer`,
      payload: { questionId: "Q1", answer: `All ${RLO}columns <img src=x onerror=alert(1)>` },
    });
    assertClean("answer", ans.json());
    const v2 = ans.json().spec.id;
    assertClean(
      "diff",
      (await h.call({ method: "GET", url: `/v1/specs/diff?from=${specId}&to=${v2}` })).json(),
    );
    assertClean("render", (await h.call({ method: "GET", url: `/v1/specs/${v2}/render` })).json());

    const search = await h.call({
      method: "GET",
      url: `/v1/projects/${projectId}/search?q=reports`,
    });
    expect(search.json().hits.length).toBeGreaterThan(0);
    assertClean("search", search.json());
  });

  it("does not alter settings round-trips", async () => {
    const s = await h.call({ method: "GET", url: "/v1/settings" });
    expect(s.json().settings.model).toBe("claude-fable-5-1");
  });
});
