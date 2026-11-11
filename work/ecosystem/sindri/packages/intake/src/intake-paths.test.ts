import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSindriError, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adfToText,
  ConnectorError,
  JiraConnector,
  LinearConnector,
  MAX_ADF_DEPTH,
  type Connector,
  type IssueSnapshot,
} from "./connectors.js";
import { MAX_ATTACHMENT_BYTES, openIntake } from "./intake.js";
import { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";
import { EnvSecretStore, execFileRunner, FileSecretStore } from "./secrets.js";

const store = new EnvSecretStore({ env: { SINDRI_SECRET_T: "tok" } });
const respond =
  (body: unknown, status = 200): typeof fetch =>
  () =>
    Promise.resolve(Response.json(body, { status }));

describe("adfToText node kinds", () => {
  it("renders breaks, mentions, emoji, cards and numbered lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi" },
            { type: "hardBreak" },
            { type: "mention", attrs: { text: "@ann" } },
            { type: "emoji", attrs: { shortName: ":ok:" } },
            { type: "emoji" },
            { type: "text", text: 5 },
            { type: "inlineCard", attrs: { url: "https://x.test/a" } },
            { type: "blockCard" },
          ],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            { type: "listItem" },
          ],
        },
        { type: "bulletList" },
        { content: [{ type: "text", text: "untyped" }] },
      ],
    };
    expect(adfToText(doc)).toBe("hi\n@ann:ok:https://x.test/a\n1. one\n2. \nuntyped");
  });

  it("keeps text at the depth limit and drops it below", () => {
    const nest = (levels: number) => {
      let node: unknown = { type: "text", text: "deep" };
      for (let i = 0; i < levels; i++) node = { type: "panel", content: [node] };
      return node;
    };
    expect(adfToText(nest(MAX_ADF_DEPTH))).toBe("deep");
    expect(adfToText(nest(MAX_ADF_DEPTH + 1))).toBe("");
  });
});

describe("connector failure paths", () => {
  it("Jira: refuses a base URL that is not https and URLs it cannot handle", () => {
    const opts = { email: "e", apiToken: { store, key: "t" }, fetch: respond({}) };
    expect(() => new JiraConnector({ ...opts, baseUrl: "http://a.atlassian.net" })).toThrow(
      "JiraConnector baseUrl must be an https URL",
    );
    expect(() => new JiraConnector({ ...opts, baseUrl: "not a url" })).toThrow(/https URL/);
    const c = new JiraConnector({ ...opts, baseUrl: "https://a.atlassian.net" });
    expect(() => c.parseUrl("https://other.atlassian.net/browse/P-1")).toThrow(
      new ConnectorError("not a Jira issue URL for a.atlassian.net"),
    );
  });

  it("Jira: stops paging comments when the server reports no total", async () => {
    let calls = 0;
    const c = new JiraConnector({
      baseUrl: "https://a.atlassian.net",
      email: "e",
      apiToken: { store, key: "t" },
      fetch: () => {
        calls++;
        return Promise.resolve(Response.json({ comments: [{ id: null, body: "x" }] }));
      },
    });
    const ref = { source: "jira" as const, key: "P-1", url: "https://a.atlassian.net/browse/P-1" };
    expect((await c.fetchComments(ref)).comments).toEqual([
      { externalId: "", author: "unknown", body: "x", createdAt: "" },
    ]);
    expect(calls).toBe(1);
  });

  it("Linear: refuses other URLs, HTTP errors and missing issues", async () => {
    const ref = {
      source: "linear" as const,
      key: "ENG-1",
      url: "https://linear.app/a/issue/ENG-1",
    };
    const make = (f: typeof fetch) =>
      new LinearConnector({ apiKey: { store, key: "t" }, fetch: f });
    expect(() => make(respond({})).parseUrl("https://linear.app/a/project/x")).toThrow(
      new ConnectorError("not a Linear issue URL"),
    );
    const down = make(respond({}, 503));
    await expect(down.fetchIssue(ref)).rejects.toMatchObject({
      message: "Linear request failed: HTTP 503",
      status: 503,
    });
    await expect(make(respond({ data: { issue: null } })).fetchIssue(ref)).rejects.toThrow(
      "Linear issue ENG-1 not found",
    );
    await expect(
      make(respond({ errors: [{ extensions: { code: "RATELIMITED" } }] })).fetchIssue(ref),
    ).rejects.toThrow("Linear GraphQL error (RATELIMITED)");
  });
});

describe("intake edge paths", () => {
  let dir: string;
  let db: SqliteDatabase;
  let projectId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intake-paths-"));
    const k = openKnowledge(":memory:");
    db = k.db;
    projectId = k.projects.create({ name: "p", repoPath: "/r" }).id;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses attachments when no attachments directory is configured", () => {
    const intake = openIntake(db);
    expect(() =>
      intake.createManual({
        projectId,
        title: "t",
        body: "",
        attachments: [{ name: "a", content: "x" }],
      }),
    ).toThrow("attachmentsDir must be configured to store attachments");
    expect(intake.list(projectId)).toEqual([]);
    expect(intake.deleteUnreferencedBlobs([join(dir, "x")])).toBe(0);
  });

  it("refuses an attachment over the size limit and stores nothing", () => {
    const intake = openIntake(db, { attachmentsDir: join(dir, "att") });
    let error: unknown;
    try {
      intake.createManual({
        projectId,
        title: "t",
        body: "",
        attachments: [{ name: "big.bin", content: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) }],
      });
    } catch (e) {
      error = e;
    }
    expect(isSindriError(error) && error.code).toBe("validation_failed");
    expect(String(error)).toMatch(/attachment too large: big\.bin/);
    expect(intake.list(projectId)).toEqual([]);
    expect(existsSync(join(dir, "att"))).toBe(false);
  });

  it("stores an attachment whose name is only a path as 'attachment'", () => {
    const intake = openIntake(db, { attachmentsDir: join(dir, "att") });
    const r = intake.createManual({
      projectId,
      title: "t",
      body: "",
      attachments: [
        { name: "..", content: "a" },
        { name: "dir\\..\\", content: "b" },
      ],
    });
    expect(intake.attachments(r.id).map((a) => a.name)).toEqual(["attachment", "attachment"]);
  });

  it("sanitizes display text on read for rows stored without it", () => {
    const intake = openIntake(db);
    const r = intake.createManual({ projectId, title: "<b>T</b>", body: "<i>B</i>" });
    const c = intake.annotate(r.id, { author: "<u>me</u>", body: "<s>note</s>" });
    // Rows written by a writer that predates the display columns.
    db.prepare("UPDATE intakes SET display_title = NULL, display_body = NULL").run();
    db.prepare("UPDATE intake_comments SET display_author = NULL, display_body = NULL").run();
    expect(intake.get(r.id)?.display).toEqual({ title: "T", body: "B" });
    expect(intake.comments(r.id)).toMatchObject([
      { id: c.id, display: { author: "me", body: "note" } },
    ]);
  });

  it("backfills display text of old rows, also when the snapshot has no body", () => {
    const intake = openIntake(db);
    const r = intake.createManual({ projectId, title: "<b>T</b>", body: "x" });
    db.prepare(
      "UPDATE intakes SET display_title = NULL, display_body = NULL, raw_snapshot_json = ?",
    ).run(JSON.stringify({ title: "<b>T</b>", updated: "", url: null, raw: null }));
    openIntake(db);
    expect(
      db.prepare("SELECT display_title, display_body FROM intakes WHERE id = ?").get(r.id),
    ).toEqual({ display_title: "T", display_body: "" });
  });

  it("imports an issue without a remote payload and adopts a pending snapshot without comments", async () => {
    let updated = "1";
    const connector: Connector = {
      kind: "jira",
      canHandle: () => true,
      parseUrl: (url) => ({ source: "jira", key: "P-1", url }),
      fetchIssue: (): Promise<IssueSnapshot> =>
        Promise.resolve({
          source: "jira",
          externalId: "P-1",
          url: "https://x.test/P-1",
          title: `v${updated}`,
          body: "b",
          updated,
          raw: undefined,
        }),
    };
    const intake = openIntake(db, { connectors: [connector] });
    const first = await intake.importFromUrl("https://x.test/P-1", { projectId });
    expect(first.snapshot.raw).toBeUndefined();
    expect(first.permissions.comments).toBe(false);
    updated = "2";
    const stale = await intake.importFromUrl("https://x.test/P-1", { projectId });
    expect(stale.syncState).toBe("stale");
    const resolved = intake.resolveSync(stale.id, { take: "remote" });
    expect(resolved).toMatchObject({ title: "v2", syncState: "imported" });
    expect(intake.comments(stale.id)).toEqual([]);
  });

  it("opens and closes its own database from a path", () => {
    const own = openIntake(join(dir, "own.db"));
    expect(own.list("p")).toEqual([]);
    own.close();
    expect(() => own.list("p")).toThrow();
  });
});

describe("sanitizeForDisplay edge cases", () => {
  it("closes a block with whitespace before the `>` of its end tag", () => {
    expect(sanitizeForDisplay("a<script>x</script \t\n\r\f>b")).toBe("ab");
    expect(sanitizeForDisplay("a<style>x</style y>b")).toBe("a");
  });

  it("keeps a lone `-` after a `<` that is not a comment opener", () => {
    expect(sanitizeForDisplay("a <x- b")).toBe("a ");
    expect(sanitizeForDisplay("1 <-- 2")).toBe("1 <-- 2");
    expect(sanitizeForDisplay("a <!x- b")).toBe("a ");
  });

  it("does not split a surrogate pair at the length cap", () => {
    const input = "a".repeat(MAX_DISPLAY_CHARS - 1) + "\u{1F600}" + "tail";
    const out = sanitizeForDisplay(input);
    expect(out.endsWith("a\n[truncated]")).toBe(true);
    expect(out).toHaveLength(MAX_DISPLAY_CHARS - 1 + "\n[truncated]".length);
  });
});

describe("secret store defaults and the command runner", () => {
  it("reads SINDRI_SECRET_ variables from the process environment by default", async () => {
    const name = "SINDRI_SECRET_SWEEP_TEST_KEY";
    process.env[name] = "v";
    try {
      expect(await new EnvSecretStore().get("sweep.test-key")).toBe("v");
    } finally {
      delete process.env[name];
    }
    expect(await new EnvSecretStore({ env: { SINDRI_SECRET_X: "" } }).get("x")).toBeUndefined();
  });

  it("runs a binary without a shell and reports its exit code", async () => {
    const node = process.execPath;
    expect(await execFileRunner(node, ["-e", "process.stdout.write('ok $HOME')"])).toEqual({
      code: 0,
      stdout: "ok $HOME",
    });
    expect(await execFileRunner(node, ["-e", "process.exit(44)"])).toMatchObject({ code: 44 });
    expect(await execFileRunner(join(tmpdir(), "no-such-binary-sindri"), [])).toEqual({
      code: 1,
      stdout: "",
    });
  });

  it("rejects a secrets file without KDF parameters as unsupported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sindri-secrets-fmt-"));
    try {
      const path = join(dir, "s.enc");
      writeFileSync(path, JSON.stringify({ v: 1, cipher: "aes-256-gcm" }));
      const s = new FileSecretStore({ path, passphrase: "p" });
      await expect(s.get("x")).rejects.toThrow("unsupported secrets file format");
      expect(readFileSync(path, "utf8")).toContain("aes-256-gcm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
