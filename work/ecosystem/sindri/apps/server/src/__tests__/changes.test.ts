import { afterEach, describe, expect, it } from "vitest";
import { changeFingerprint } from "../routes/changes.js";
import { makeHarness, TOKEN, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Reads SSE frames until `count` `changed` events have arrived; returns their versions. */
async function changedVersions(res: Response, count: number): Promise<number[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const versions: number[] = [];
  while (versions.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (frame.includes("event: changed") && data)
        versions.push((JSON.parse(data) as { version: number }).version);
    }
  }
  await reader.cancel();
  return versions;
}

describe("GET /v1/changes", () => {
  it("announces once on connect and again after any write to Sindri's data", async () => {
    h = await makeHarness();
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${address}/v1/changes`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const pending = changedVersions(res, 2);
    await new Promise((r) => setTimeout(r, 100));
    h.db.exec(
      "CREATE TABLE IF NOT EXISTS change_probe (x INTEGER); INSERT INTO change_probe VALUES (1)",
    );
    const [first, second] = await pending;
    expect(second).toBeGreaterThan(first!);
  });

  it("does not move without a write", async () => {
    h = await makeHarness();
    const before = changeFingerprint(h.db);
    h.db.prepare("SELECT COUNT(*) FROM schema_migrations").get();
    expect(changeFingerprint(h.db)).toBe(before);
    h.db.exec(
      "CREATE TABLE IF NOT EXISTS change_probe (x INTEGER); INSERT INTO change_probe VALUES (1)",
    );
    expect(changeFingerprint(h.db)).not.toBe(before);
  });

  it("requires the bearer token", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ url: "/v1/changes" });
    expect(res.statusCode).toBe(401);
  });
});
