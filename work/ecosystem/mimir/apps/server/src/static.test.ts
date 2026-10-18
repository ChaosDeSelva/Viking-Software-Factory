import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, type TestServer } from "./test-helpers.js";

let dir: string;
let webRoot: string;
const servers: TestServer[] = [];
const serve = (): TestServer => {
  const s = makeServer({ webRoot });
  servers.push(s);
  return s;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-static-")));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>mimir</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "app.css"), "body{}");
  writeFileSync(join(webRoot, "logo.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.txt"), "TOP-SECRET");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("web app serving", () => {
  it("serves index.html at / with no-cache", async () => {
    const res = await serve().app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>mimir</title>");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each([
    ["/assets/app.js", "text/javascript"],
    ["/assets/app.css", "text/css"],
    ["/logo.svg", "image/svg+xml"],
  ])("serves %s as %s", async (url, type) => {
    const res = await serve().app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(type);
  });

  it("marks hashed assets immutable", async () => {
    const res = await serve().app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for extensionless client routes", async () => {
    const res = await serve().app.inject({ method: "GET", url: "/missions/msn_123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>mimir</title>");
  });

  it("404s a missing file that has an extension, instead of returning HTML", async () => {
    const res = await serve().app.inject({ method: "GET", url: "/assets/gone.js" });
    expect(res.statusCode).toBe(404);
  });

  it("never lists directories (serves the app shell instead)", async () => {
    const res = await serve().app.inject({ method: "GET", url: "/assets/" });
    expect(res.body).not.toContain("app.js");
    expect(res.body).toContain("<title>mimir</title>");
  });

  it("answers HEAD without a body", async () => {
    const res = await serve().app.inject({ method: "HEAD", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%00", "/%zz"])(
    "does not escape the web root via %s",
    async (url) => {
      const res = await serve().app.inject({ method: "GET", url });
      expect(res.body).not.toContain("TOP-SECRET");
    },
  );

  it("does not follow a symlink out of the web root", async () => {
    symlinkSync(join(dir, "secret.txt"), join(webRoot, "leak.txt"));
    const res = await serve().app.inject({ method: "GET", url: "/leak.txt" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("TOP-SECRET");
  });

  it("leaves the API untouched: /v1 still needs a token and unknown /v1 routes 404 as JSON", async () => {
    const { app } = serve();
    expect((await app.inject({ method: "GET", url: "/v1/missions" })).statusCode).toBe(401);
    const missing = await app.inject({ method: "GET", url: "/v1/nope", headers: AUTH });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    expect((await app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(200);
  });

  it("keeps the Host check on static files", async () => {
    const res = await serve().app.inject({
      method: "GET",
      url: "/",
      headers: { host: "evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects non-GET methods outside the API", async () => {
    const res = await serve().app.inject({ method: "POST", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("serves nothing when no web root is configured", async () => {
    const s = makeServer();
    servers.push(s);
    expect((await s.app.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
  });
});
