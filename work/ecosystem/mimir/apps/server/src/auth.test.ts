import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiErrorBodySchema } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, type TestServer } from "./test-helpers.js";

const servers: TestServer[] = [];
const track = (s: TestServer) => (servers.push(s), s);
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const inject = (s: TestServer, headers: Record<string, string>, url = "/v1/capabilities") =>
  s.app.inject({ method: "GET", url, headers: { ...AUTH, ...headers } });

const code = (res: { json(): unknown }) => ApiErrorBodySchema.parse(res.json()).error.code;

/** Real-socket GET with arbitrary Host/Origin headers. */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("CSRF origin check", () => {
  it("rejects an Origin that is neither a configured server origin nor allowlisted", async () => {
    const s = track(makeServer());
    const res = await inject(s, { origin: "http://evil.test" });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("policy_denied");
  });

  it("rejects Origin: null", async () => {
    const s = track(makeServer());
    const res = await inject(s, { origin: "null" });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("policy_denied");
  });

  it("allows configured server origins, the allowlist, and the web dev server by default", async () => {
    const s = track(
      makeServer({
        publicOrigins: ["http://127.0.0.1:7700", "http://localhost:80"],
        allowedOrigins: ["https://ui.test"],
      }),
    );
    expect((await inject(s, { origin: "https://ui.test" })).statusCode).toBe(200);
    expect(
      (await inject(s, { origin: "http://127.0.0.1:7700", host: "127.0.0.1:7700" })).statusCode,
    ).toBe(200);
    // An explicit allowlist replaces the default dev-server entry.
    expect((await inject(s, { origin: "http://127.0.0.1:5173" })).statusCode).toBe(403);
    const dflt = track(makeServer());
    expect((await inject(dflt, { origin: "http://127.0.0.1:5173" })).statusCode).toBe(200);
  });

  it("never derives the server origin from the Host header (DNS rebinding)", async () => {
    const s = track(makeServer({ publicOrigins: ["http://127.0.0.1:7700"] }));
    const res = await inject(s, { host: "evil.test:7700", origin: "http://evil.test:7700" });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("policy_denied");
  });
});

describe("Host validation", () => {
  it("rejects an unknown Host, even on the public health route", async () => {
    const s = track(makeServer({ publicOrigins: ["http://127.0.0.1:7700"] }));
    for (const url of ["/v1/health", "/v1/capabilities"]) {
      const res = await inject(s, { host: "evil.test:7700" }, url);
      expect(res.statusCode, url).toBe(403);
      expect(code(res)).toBe("policy_denied");
    }
    expect((await inject(s, { host: "127.0.0.1:7700" })).statusCode).toBe(200);
  });

  it("accepts loopback names at the bound port on a real socket and rejects a spoofed Host", async () => {
    const s = track(makeServer({ publicOrigins: [] }));
    await s.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = s.app.server.address() as AddressInfo;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await rawGet(port, "/v1/capabilities", {
        ...AUTH,
        host,
        origin: `http://${host}`,
      });
      expect(res.status, host).toBe(200);
    }
    const spoofed = await rawGet(port, "/v1/capabilities", {
      ...AUTH,
      host: `evil.test:${port}`,
      origin: `http://evil.test:${port}`,
    });
    expect(spoofed.status).toBe(403);
    expect(JSON.parse(spoofed.body)).toMatchObject({ error: { code: "policy_denied" } });
    const wrongPort = await rawGet(port, "/v1/health", { host: `127.0.0.1:${port + 1}` });
    expect(wrongPort.status).toBe(403);
  });
});
