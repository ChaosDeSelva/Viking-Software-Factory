import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

/**
 * Layout: <dir>/allowed (the only allowed root) holding repo `inside`; <dir>/outside holding
 * repo `secret`. Symlinks inside the root point at both.
 */
let server: TestServer;
let tmp: ReturnType<typeof tempGitRepo>;
let allowed: string;
let inside: string;
let secret: string;
beforeEach(() => {
  tmp = tempGitRepo();
  allowed = join(tmp.dir, "allowed");
  inside = join(allowed, "inside");
  secret = join(tmp.dir, "outside", "secret");
  for (const repo of [inside, secret]) {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
  }
  symlinkSync(secret, join(allowed, "link-out"));
  symlinkSync(join(tmp.dir, "outside"), join(allowed, "dir-out"));
  symlinkSync(inside, join(allowed, "link-in"));
  writeFileSync(join(allowed, "file"), "x");
  server = makeServer({ allowedRoots: [allowed] });
});
afterEach(async () => {
  await server.close();
  tmp.cleanup();
});

let n = 0;
const create = (repoPath: string) =>
  server.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { ...AUTH, "content-type": "application/json", "idempotency-key": `k-${n++}` },
    payload: { name: "p", repoPath },
  });

describe("security: repoPath traversal and symlinks", () => {
  it.each([
    ["dot-dot out of the root", () => `${allowed}/../outside/secret`],
    ["dot-dot through an existing repo", () => `${inside}/../../outside/secret`],
    ["symlinked repo pointing outside", () => join(allowed, "link-out")],
    ["symlinked directory pointing outside", () => join(allowed, "dir-out", "secret")],
    ["the filesystem root", () => "/"],
    ["a sibling whose name extends the root", () => `${allowed}-evil`],
  ])("%s → 403 policy_denied, no project", async (_label, path) => {
    if (path().endsWith("-evil")) {
      mkdirSync(path());
      execFileSync("git", ["init", "-q"], { cwd: path() });
    }
    const res = await create(path());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "policy_denied" } });
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
  });

  it.each([
    ["relative path", "allowed/inside", "not_absolute"],
    ["relative dot-dot", "../../etc", "not_absolute"],
    ["missing path", "/definitely/not/here", "not_found"],
    ["NUL byte", "/tmp/a\u0000b", "not_found"],
  ])("%s → 422 validation_failed (%s)", async (_label, repoPath, reason) => {
    const res = await create(repoPath);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "validation_failed", details: { reason } } });
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
  });

  it("a file inside the root → 422 not_a_directory", async () => {
    const res = await create(join(allowed, "file"));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { details: { reason: "not_a_directory" } } });
  });

  it("a symlink inside the root to a repo inside the root is stored by its real path", async () => {
    const res = await create(join(allowed, "link-in"));
    expect(res.statusCode).toBe(201);
    expect((res.json() as { project: { repoPath: string } }).project.repoPath).toBe(inside);
  });

  it("a subdirectory of a repo outside the root is denied even though its top level is resolved", async () => {
    mkdirSync(join(secret, "sub"));
    const res = await create(join(allowed, "link-out", "sub"));
    expect(res.statusCode).toBe(403);
  });
});
