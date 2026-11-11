import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKnowledge } from "@sindri/knowledge";
import { adfToText, JiraConnector, LinearConnector, type IssueRef } from "./connectors.js";
import { openIntake } from "./intake.js";
import { sanitizeForDisplay } from "./sanitize.js";
import { EnvSecretStore, FileSecretStore } from "./secrets.js";

describe("sanitizeForDisplay: a stray `<` never shields a tag", () => {
  it("removes a tag whose attributes hold a bare `<` before the closing `>`", () => {
    // A browser ends this tag at the first `>`: the `<` is just another attribute name.
    for (const evil of [
      "<img src=x onerror=alert(1) < b > more>",
      "x <a href=1 < 2>y",
      "<svg onload=alert(1) <>",
      "<iframe src=evil < >inner</iframe>",
    ]) {
      const out = sanitizeForDisplay(evil);
      expect(out, evil).not.toMatch(/<\s*\/?\s*[a-z!]/i);
      expect(out, evil).not.toContain("alert(1)");
    }
    expect(sanitizeForDisplay("x <a href=1 < 2>y")).toBe("x y");
  });

  it("drops an unterminated tag that is followed by a stray `<`", () => {
    expect(sanitizeForDisplay("keep <img src=x onerror=alert(1) < ")).toBe("keep ");
    expect(sanitizeForDisplay("keep <iframe src=evil < 3 <")).toBe("keep ");
  });

  it("still keeps comparisons and stray brackets that are not tags", () => {
    expect(sanitizeForDisplay("a < b > c")).toBe("a < b > c");
    expect(sanitizeForDisplay("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(sanitizeForDisplay("a << b >> c <")).toBe("a << b >> c <");
    expect(sanitizeForDisplay("x <> y </> z")).toBe("x <> y </> z");
  });

  it("still removes a tag that reassembles once a block right after a `<` is removed", () => {
    expect(sanitizeForDisplay("<<script> > </script>img src=x onerror=alert(1)>")).toBe("");
    expect(sanitizeForDisplay("a</<style> > </style>b>c")).toBe("ac");
  });
});

// Every load and save derives a scrypt key; a dozen in a row outlast the default timeout on a
// busy machine.
describe("FileSecretStore: keys are data, never object members", { timeout: 60_000 }, () => {
  let dir: string;
  let store: FileSecretStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sindri-secrets-sweep-"));
    store = new FileSecretStore({ path: join(dir, "secrets.json"), passphrase: "correct horse" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports names inherited from Object.prototype as absent", async () => {
    await store.set("jira.api-token", "tok");
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(await store.get(key), key).toBeUndefined();
  });

  it("stores and deletes a secret named __proto__ like any other", async () => {
    await store.set("__proto__", "v1");
    expect(await store.get("__proto__")).toBe("v1");
    expect(await store.keys()).toEqual(["__proto__"]);
    await store.delete("__proto__");
    expect(await store.keys()).toEqual([]);
  });

  it("keeps every secret when writes overlap", async () => {
    await store.set("a", "1");
    await Promise.all([store.set("b", "2"), store.set("c", "3"), store.delete("a")]);
    expect(await store.keys()).toEqual(["b", "c"]);
    // A second handle on the same file takes part in the same ordering.
    const other = new FileSecretStore({
      path: join(dir, "secrets.json"),
      passphrase: "correct horse",
    });
    await Promise.all([store.set("d", "4"), other.set("e", "5")]);
    expect(await other.keys()).toEqual(["b", "c", "d", "e"]);
  });

  it("keeps working after a failed write", async () => {
    await store.set("a", "1");
    const wrong = new FileSecretStore({ path: join(dir, "secrets.json"), passphrase: "nope" });
    await expect(wrong.set("b", "2")).rejects.toThrow(/cannot decrypt/);
    await store.set("c", "3");
    expect(await store.keys()).toEqual(["a", "c"]);
  });
});

describe("connectors: remote fields of the wrong type never reach the snapshot", () => {
  const store = new EnvSecretStore({ env: { SINDRI_SECRET_T: "tok" } });
  const respond = (body: unknown): typeof fetch =>
    (() => Promise.resolve(Response.json(body))) as typeof fetch;

  it("Jira: non-string summary, updated, status, comment author and date become text", async () => {
    const ref: IssueRef = { source: "jira", key: "P-1", url: "https://a.atlassian.net/browse/P-1" };
    const make = (body: unknown) =>
      new JiraConnector({
        baseUrl: "https://a.atlassian.net",
        email: "e@a.test",
        apiToken: { store, key: "t" },
        fetch: respond(body),
      });
    const snap = await make({
      key: 7,
      fields: { summary: 123, updated: { at: 1 }, status: { name: ["x"] }, description: 9 },
    }).fetchIssue(ref);
    expect(snap).toMatchObject({ externalId: "P-1", title: "", body: "", updated: "" });
    expect(snap.status).toBeUndefined();
    expect(sanitizeForDisplay(snap.title)).toBe("");

    const { comments } = await make({
      comments: [{ id: 5, author: { displayName: { evil: true } }, body: null, created: 12 }],
    }).fetchComments(ref);
    expect(comments).toEqual([{ externalId: "5", author: "unknown", body: "", createdAt: "" }]);
  });

  it("Jira: an answer that is not an object is treated as an empty issue", async () => {
    const ref: IssueRef = { source: "jira", key: "P-1", url: "https://a.atlassian.net/browse/P-1" };
    const c = new JiraConnector({
      baseUrl: "https://a.atlassian.net",
      email: "e@a.test",
      apiToken: { store, key: "t" },
      fetch: respond(null),
    });
    expect(await c.fetchIssue(ref)).toMatchObject({ externalId: "P-1", title: "", body: "" });
    expect((await c.fetchComments(ref)).comments).toEqual([]);
  });

  it("Linear: non-string title, description, url, state and comment fields become text", async () => {
    const ref: IssueRef = {
      source: "linear",
      key: "ENG-1",
      url: "https://linear.app/a/issue/ENG-1",
    };
    const make = (body: unknown) =>
      new LinearConnector({ apiKey: { store, key: "t" }, fetch: respond(body) });
    const snap = await make({
      data: {
        issue: {
          id: "i",
          identifier: 4,
          title: { a: 1 },
          description: 5,
          url: false,
          updatedAt: 1,
          state: { name: 2 },
        },
      },
    }).fetchIssue(ref);
    expect(snap).toMatchObject({
      externalId: "ENG-1",
      url: ref.url,
      title: "",
      body: "",
      updated: "",
    });
    expect(snap.status).toBeUndefined();

    const { comments } = await make({
      data: {
        issue: { comments: { nodes: [{ id: 1, body: [], createdAt: {}, user: { name: 3 } }] } },
      },
    }).fetchComments(ref);
    expect(comments).toEqual([{ externalId: "1", author: "unknown", body: "", createdAt: "" }]);
  });

  it("Linear: an answer that is not an object is a connector error, not a crash", async () => {
    const ref: IssueRef = {
      source: "linear",
      key: "ENG-1",
      url: "https://linear.app/a/issue/ENG-1",
    };
    const c = new LinearConnector({ apiKey: { store, key: "t" }, fetch: respond(null) });
    await expect(c.fetchIssue(ref)).rejects.toThrow("Linear GraphQL error (UNKNOWN)");
  });
});

describe("adfToText: untrusted document structure", () => {
  it("reads content that is not a list as empty instead of throwing", () => {
    for (const type of ["paragraph", "bulletList", "listItem"])
      expect(
        adfToText({
          type: "doc",
          content: [
            { type, content: "x" },
            { type: "text", text: "ok" },
          ],
        }),
        type,
      ).toBe("ok");
  });

  it("does not overflow the stack on deeply nested nodes", () => {
    let node: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 100_000; i++) node = { type: "blockquote", content: [node] };
    expect(() => adfToText(node)).not.toThrow();
    expect(adfToText({ type: "doc", content: [{ type: "text", text: "a" }, node] })).toMatch(/^a/);
  });
});

describe("deleteUnreferencedBlobs: a blob referenced under another spelling of its path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intake-blob-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is kept while any intake references the same content", () => {
    const k = openKnowledge(":memory:");
    const a = k.projects.create({ name: "a", repoPath: "/r" }).id;
    const b = k.projects.create({ name: "b", repoPath: "/r" }).id;
    // The same directory, configured once through a symlink (macOS: /var -> /private/var).
    symlinkSync(dir, join(dir, "link"));
    const viaLink = openIntake(k.db, { attachmentsDir: join(dir, "link", "att") });
    const direct = openIntake(k.db, { attachmentsDir: join(dir, "att") });
    const blob = { name: "x.txt", content: "shared" };
    direct.createManual({ projectId: a, title: "t", body: "", attachments: [blob] });
    viaLink.createManual({ projectId: b, title: "t", body: "", attachments: [blob] });
    const paths = direct.attachmentPaths(a);
    k.db.prepare("DELETE FROM projects WHERE id = ?").run(a);
    expect(direct.deleteUnreferencedBlobs(paths)).toBe(0);
    const [stored] = viaLink.attachmentPaths(b);
    expect(readFileSync(stored!, "utf8")).toBe("shared");
    k.db.close();
  });
});
