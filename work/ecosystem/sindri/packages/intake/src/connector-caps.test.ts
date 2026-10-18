import { createReplayFetch } from "@sindri/testing";
import { describe, expect, it } from "vitest";
import {
  JiraConnector,
  LinearConnector,
  LINEAR_GRAPHQL_URL,
  MAX_FIELD_CHARS,
  MAX_IMPORTED_COMMENTS,
} from "./connectors.js";
import { EnvSecretStore } from "./secrets.js";

const JIRA = "https://acme.atlassian.net";
const BIG = "a".repeat(100_000);
const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("connector field caps (audit M5)", () => {
  it("caps Jira title, body, comment author and body at MAX_FIELD_CHARS", async () => {
    expect(MAX_FIELD_CHARS).toBe(64 * 1024);
    const replay = createReplayFetch([
      {
        url: `${JIRA}/rest/api/3/issue/PROJ-1`,
        body: {
          key: "PROJ-1",
          fields: { summary: BIG, description: adf(BIG), updated: "2026-10-01T00:00:00.000+0000" },
        },
      },
      {
        url: `${JIRA}/rest/api/3/issue/PROJ-1/comment`,
        body: {
          startAt: 0,
          total: 1,
          comments: [{ id: "1", author: { displayName: BIG }, body: adf(BIG), created: "t" }],
        },
      },
    ]);
    const store = new EnvSecretStore({ env: { SINDRI_SECRET_JIRA_TOKEN: "x" } });
    const c = new JiraConnector({
      baseUrl: JIRA,
      email: "pat@acme.test",
      apiToken: { store, key: "jira.token" },
      fetch: replay.fetch,
    });
    const ref = c.parseUrl(`${JIRA}/browse/PROJ-1`);
    const issue = await c.fetchIssue(ref);
    expect(issue.title.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(issue.body.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(issue.body.startsWith("aaaa")).toBe(true);
    const [comment] = (await c.fetchComments(ref)).comments;
    expect(comment!.author.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(comment!.body.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
  });

  it("caps Linear fields and comment count", async () => {
    const replay = createReplayFetch([
      {
        method: "POST",
        url: LINEAR_GRAPHQL_URL,
        match: (r) => (r.body ?? "").includes("SindriIssueComments"),
        body: {
          data: {
            issue: {
              id: "x",
              comments: {
                nodes: Array.from({ length: MAX_IMPORTED_COMMENTS + 100 }, (_, i) => ({
                  id: String(i),
                  body: BIG,
                  createdAt: "t",
                  user: { name: BIG },
                })),
              },
            },
          },
        },
      },
      {
        method: "POST",
        url: LINEAR_GRAPHQL_URL,
        body: {
          data: {
            issue: {
              id: "x",
              identifier: "ENG-1",
              title: BIG,
              description: BIG,
              url: "https://linear.app/acme/issue/ENG-1",
              updatedAt: "t",
            },
          },
        },
      },
    ]);
    const store = new EnvSecretStore({ env: { SINDRI_SECRET_LINEAR_KEY: "lin" } });
    const c = new LinearConnector({ apiKey: { store, key: "linear.key" }, fetch: replay.fetch });
    const ref = c.parseUrl("https://linear.app/acme/issue/ENG-1");
    const issue = await c.fetchIssue(ref);
    expect(issue.title.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(issue.body.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    const { comments } = await c.fetchComments(ref);
    expect(comments).toHaveLength(MAX_IMPORTED_COMMENTS);
    for (const cm of comments) {
      expect(cm.body.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
      expect(cm.author.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    }
  });
});
