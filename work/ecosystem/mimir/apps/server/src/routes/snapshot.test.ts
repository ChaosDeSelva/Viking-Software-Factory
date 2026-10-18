import { openEventStore } from "@mimir/core";
import { SnapshotResponseSchema } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, eventInput, makeServer, type TestServer } from "../test-helpers.js";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe("GET /v1/snapshot", () => {
  it("requires auth", async () => {
    const s = makeServer();
    servers.push(s);
    expect((await s.app.inject({ method: "GET", url: "/v1/snapshot" })).statusCode).toBe(401);
  });

  it("is rebuilt from the store on boot and follows new events, with a consistent cursor", async () => {
    const store = openEventStore(":memory:");
    const before = store.append(eventInput());
    const s = makeServer({}, store);
    servers.push(s);
    const get = async () =>
      SnapshotResponseSchema.parse(
        (await s.app.inject({ method: "GET", url: "/v1/snapshot", headers: AUTH })).json(),
      );
    const first = await get();
    expect(first.missions.map((m) => m.id)).toEqual([before.missionId]);
    expect(first.cursor).toBe(store.latestCursor());

    const after = store.append(eventInput());
    const second = await get();
    expect(second.missions.map((m) => m.id)).toEqual([before.missionId, after.missionId]);
    expect(second.cursor).toBe(store.latestCursor());
  });
});
