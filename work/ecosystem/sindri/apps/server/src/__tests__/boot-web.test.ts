import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { secretStoreFor, startServer } from "../boot.js";
import { serveWeb } from "../web.js";
import { makeHarness } from "./helpers.js";

it("serves the SPA and assets while rejecting unsafe and missing paths", async () => {
  const h = await makeHarness();
  const root = join(h.dir, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "assets/app.js"), "app()");
  writeFileSync(join(root, "blob.bin"), "bytes");
  writeFileSync(join(h.dir, "outside"), "secret");
  symlinkSync(join(h.dir, "outside"), join(root, "escape.txt"));
  serveWeb(h.app, root);
  try {
    for (const url of ["/", "/knowledge?tab=1"]) {
      const r = await h.app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("app");
      expect(r.headers["cache-control"]).toBe("no-cache");
    }
    const asset = await h.app.inject({ url: "/assets/app.js" });
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["content-type"]).toContain("javascript");
    expect((await h.app.inject({ url: "/blob.bin" })).headers["content-type"]).toBe(
      "application/octet-stream",
    );
    for (const url of ["/missing.js", "/assets", "/escape.txt", "/.secret", "/%00"]) {
      expect((await h.app.inject({ url })).statusCode, url).toBe(404);
    }
    expect((await h.app.inject({ url: "/%2e%2e/outside" })).body).not.toContain("secret");
    expect((await h.app.inject({ url: "/v1/projects" })).statusCode).toBe(401);
    expect((await h.call({ url: "/v1/missing" })).statusCode).toBe(404);
    rmSync(join(root, "index.html"));
    expect((await h.app.inject({ url: "/other" })).statusCode).toBe(404);
  } finally {
    await h.close();
  }
});

it("boots a real listener with persisted credentials and closes cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sindri-boot-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const addr = probe.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const port = addr.port;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  const env = { SINDRI_DATA_DIR: dir, SINDRI_PORT: String(port), SINDRI_SECRET_STORE: "env" };
  writeFileSync(join(dir, "index.html"), "booted");
  const options = {
    logLevel: "silent",
    webDist: dir,
    overrides: { resumeOnReady: false, approval: { pairingCode: "TESTC-0DE23" } },
  };
  try {
    const server = await startServer(env, options);
    try {
      expect(server.url).toBe(`http://127.0.0.1:${port}`);
      expect(await (await fetch(server.url)).text()).toBe("booted");
      expect((await fetch(`${server.url}/v1/projects`)).status).toBe(401);
      const token = readFileSync(server.tokenPath, "utf8").trim();
      expect(
        (
          await fetch(`${server.url}/v1/projects`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200);
      await expect(startServer(env, options)).rejects.toThrow();
    } finally {
      await server.close();
    }
    const again = await startServer(env, {
      logLevel: options.logLevel,
      overrides: options.overrides,
    });
    await again.close();
    expect(secretStoreFor({})).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
