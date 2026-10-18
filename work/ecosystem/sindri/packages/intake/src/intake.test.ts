import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { createReplayFetch, type ReplayRoute } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JiraConnector, LinearConnector } from "./connectors.js";
import { openIntake, type Intake } from "./intake.js";
import { EnvSecretStore } from "./secrets.js";

const fixture = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));

const JIRA = "https://acme.atlassian.net";
const JIRA_URL = `${JIRA}/browse/PROJ-123`;
const LINEAR_URL = "https://linear.app/acme/issue/ENG-42/retry-webhook-deliveries-with-backoff";
const JIRA_TOKEN = "ATATT3x-jira-token-should-never-persist";
const LINEAR_KEY = "lin_api_linear-key-should-never-persist";

describe("intake", () => {
  let db: SqliteDatabase;
  let dir: string;
  let projectId: string;
  let issueFixture: string;
  let now: Date;
  let intake: Intake;
  let routes: ReplayRoute[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sindri-intake-"));
    db = openDatabase(join(dir, "sindri.db"));
    projectId = openKnowledge(db).projects.create({ name: "demo", repoPath: dir }).id;
    issueFixture = "jira/issue-PROJ-123.json";
    now = new Date("2026-10-01T00:00:00Z");
    const store = new EnvSecretStore({
      env: { SINDRI_SECRET_JIRA_TOKEN: JIRA_TOKEN, SINDRI_SECRET_LINEAR_KEY: LINEAR_KEY },
    });
    routes = [
      { url: `${JIRA}/rest/api/3/issue/PROJ-123`, body: {} },
      {
        url: `${JIRA}/rest/api/3/issue/PROJ-123/comment`,
        body: fixture("jira/comments-PROJ-123.json"),
      },
      {
        method: "POST",
        url: "https://api.linear.app/graphql",
        match: (r) => r.body?.includes("SindriIssue(") ?? false,
        body: fixture("linear/issue-ENG-42.json"),
      },
      {
        method: "POST",
        url: "https://api.linear.app/graphql",
        match: (r) => r.body?.includes("SindriIssueComments(") ?? false,
        body: fixture("linear/comments-ENG-42.json"),
      },
    ];
    // Jira issue route resolves the current fixture lazily so tests can "change" the remote.
    const replay = createReplayFetch(routes);
    const lazyFetch: typeof fetch = (input, init) => {
      (routes[0] as ReplayRoute).body = fixture(issueFixture);
      return replay.fetch(input, init);
    };
    intake = openIntake(db, {
      connectors: [
        new JiraConnector({
          baseUrl: JIRA,
          email: "pat@acme.test",
          apiToken: { store, key: "jira.token" },
          fetch: lazyFetch,
        }),
        new LinearConnector({ apiKey: { store, key: "linear.key" }, fetch: lazyFetch }),
      ],
      attachmentsDir: join(dir, "attachments"),
      now: () => now,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("createManual", () => {
    it("stores free text with attachments", () => {
      const rec = intake.createManual({
        projectId,
        title: "Dark mode",
        body: "Please add dark mode.",
        attachments: [{ name: "../../etc/mock.png", content: Buffer.from([1, 2, 3]) }],
      });
      expect(rec).toMatchObject({
        source: "manual",
        externalId: null,
        title: "Dark mode",
        body: "Please add dark mode.",
        syncState: "imported",
      });
      const [att] = intake.attachments(rec.id);
      expect(att).toMatchObject({ name: "mock.png", bytes: 3 });
      expect(att?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(att && existsSync(att.path)).toBe(true);
      expect(att?.path.startsWith(join(dir, "attachments"))).toBe(true);
      expect(intake.get(rec.id)).toEqual(rec);
      expect(intake.list(projectId)).toEqual([rec]);
    });

    it("validates input", () => {
      expect(() => intake.createManual({ projectId, title: " ", body: "x" })).toThrow(/title/);
      expect(() => intake.createManual({ projectId: "nope", title: "t", body: "x" })).toThrow(
        /project/,
      );
    });
  });

  describe("importFromUrl", () => {
    it("dispatches Jira URLs and stores the raw snapshot, comments and permissions", async () => {
      const rec = await intake.importFromUrl(JIRA_URL, { projectId });
      expect(rec).toMatchObject({
        source: "jira",
        externalId: "PROJ-123",
        externalUrl: JIRA_URL,
        title: "Add CSV export to the reports page",
        syncState: "imported",
        importedAt: "2026-10-01T00:00:00.000Z",
        permissions: { comments: true, attachments: false },
      });
      expect(rec.snapshot.raw).toEqual(fixture("jira/issue-PROJ-123.json"));
      expect(rec.snapshot.updated).toBe("2026-09-30T10:15:00.000+0000");
      expect(intake.comments(rec.id).map((c) => [c.author, c.origin])).toEqual([
        ["Pat Product", "remote"],
        ["Dana Dev", "remote"],
      ]);
    });

    it("dispatches Linear URLs", async () => {
      const rec = await intake.importFromUrl(LINEAR_URL, { projectId });
      expect(rec).toMatchObject({ source: "linear", externalId: "ENG-42", syncState: "imported" });
      expect(intake.comments(rec.id)).toHaveLength(1);
    });

    it("rejects URLs no connector handles", async () => {
      await expect(
        intake.importFromUrl("https://evil.atlassian.net/browse/PROJ-1", { projectId }),
      ).rejects.toThrow(/no connector/i);
      await expect(intake.importFromUrl("not a url", { projectId })).rejects.toThrow(
        /no connector/i,
      );
    });

    it("never persists credentials", async () => {
      await intake.importFromUrl(JIRA_URL, { projectId });
      await intake.importFromUrl(LINEAR_URL, { projectId });
      db.pragma("wal_checkpoint(TRUNCATE)");
      const dump = readFileSync(join(dir, "sindri.db")).toString("latin1");
      expect(dump).toContain("PROJ-123");
      expect(dump).not.toContain(JIRA_TOKEN);
      expect(dump).not.toContain(LINEAR_KEY);
      expect(dump).not.toContain(Buffer.from(`pat@acme.test:${JIRA_TOKEN}`).toString("base64"));
    });

    it("re-import with unchanged remote keeps state imported", async () => {
      const a = await intake.importFromUrl(JIRA_URL, { projectId });
      const b = await intake.importFromUrl(JIRA_URL, { projectId });
      expect(b.id).toBe(a.id);
      expect(b.syncState).toBe("imported");
      expect(intake.list(projectId)).toHaveLength(1);
    });

    it("marks stale when remote updated differs, keeping the original snapshot", async () => {
      const a = await intake.importFromUrl(JIRA_URL, { projectId });
      issueFixture = "jira/issue-PROJ-123-updated.json";
      const b = await intake.importFromUrl(JIRA_URL, { projectId });
      expect(b.syncState).toBe("stale");
      expect(b.title).toBe(a.title);
      expect(b.pendingSnapshot?.title).toBe("Add CSV and XLSX export to the reports page");
      const resolved = intake.resolveSync(b.id, { take: "remote" });
      expect(resolved).toMatchObject({
        syncState: "imported",
        title: "Add CSV and XLSX export to the reports page",
        pendingSnapshot: null,
      });
    });

    it("marks conflict when remote changed and local annotations changed too", async () => {
      const a = await intake.importFromUrl(JIRA_URL, { projectId });
      now = new Date("2026-10-02T00:00:00Z");
      intake.annotate(a.id, { author: "jacob", body: "Scope: CSV only for v1." });
      issueFixture = "jira/issue-PROJ-123-updated.json";
      const b = await intake.importFromUrl(JIRA_URL, { projectId });
      expect(b.syncState).toBe("conflict");
      expect(b.title).toBe("Add CSV export to the reports page");
      const kept = intake.resolveSync(b.id, { take: "local" });
      expect(kept).toMatchObject({ syncState: "imported", title: a.title, pendingSnapshot: null });
      expect(intake.comments(a.id).filter((c) => c.origin === "local")).toHaveLength(1);
    });

    it("M12: resolving a conflict with take:'local' sticks on the next re-import", async () => {
      const a = await intake.importFromUrl(JIRA_URL, { projectId });
      now = new Date("2026-10-02T00:00:00Z");
      intake.annotate(a.id, { author: "jacob", body: "local scope note" });
      issueFixture = "jira/issue-PROJ-123-updated.json";
      expect((await intake.importFromUrl(JIRA_URL, { projectId })).syncState).toBe("conflict");
      now = new Date("2026-10-03T00:00:00Z");
      intake.resolveSync(a.id, { take: "local" });
      const again = await intake.importFromUrl(JIRA_URL, { projectId });
      expect(again.syncState).toBe("imported");
      expect(again.title).toBe(a.title);
    });

    it("can skip importing comments when not authorised", async () => {
      const rec = await intake.importFromUrl(JIRA_URL, { projectId, importComments: false });
      expect(rec.permissions).toEqual({ comments: false, attachments: false });
      expect(intake.comments(rec.id)).toEqual([]);
    });
  });

  it("exposes sanitizeForDisplay and stores ticket text untouched", async () => {
    const rec = await intake.importFromUrl(JIRA_URL, { projectId });
    expect(rec.body).toContain("<script>alert('pwned')</script>");
    const safe = intake.sanitizeForDisplay(rec.body);
    expect(safe).not.toContain("<script");
    expect(safe).toContain("Users need to export the reports table as CSV.");
  });
});
