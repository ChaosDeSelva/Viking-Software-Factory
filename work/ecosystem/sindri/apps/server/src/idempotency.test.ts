import { applyMigrations, openDatabase } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { CommandStore, hashRequest } from "./idempotency.js";
import { SERVER_MIGRATIONS } from "./schema.js";

function store() {
  const db = openDatabase(":memory:");
  applyMigrations(db, "server", SERVER_MIGRATIONS);
  return { db, commands: new CommandStore(db, () => new Date(0)) };
}

describe("CommandStore", () => {
  it("hashes a request by its canonical body, so key order does not matter", () => {
    expect(hashRequest("POST", "/v1/x", { a: 1, b: [{ d: 2, c: 3 }] })).toBe(
      hashRequest("POST", "/v1/x", { b: [{ c: 3, d: 2 }], a: 1 }),
    );
    expect(hashRequest("POST", "/v1/x", undefined)).toBe(hashRequest("POST", "/v1/x", null));
  });

  it("replays a completed row that stored no status or body as 200 with an empty body", () => {
    const { db, commands } = store();
    expect(commands.begin("k", "POST", "/v1/x", {})).toBeNull();
    // A row completed by an older server that kept no status or response.
    db.prepare("UPDATE commands SET state = 'done' WHERE idempotency_key = 'k'").run();
    expect(commands.begin("k", "POST", "/v1/x", {})).toEqual({
      statusCode: 200,
      contentType: null,
      body: "",
    });
  });

  it("releases only a pending reservation and clears pending rows at startup", () => {
    const { commands } = store();
    commands.begin("done", "POST", "/v1/x", {});
    commands.complete("done", { statusCode: 201, contentType: null, body: "{}" }, "prj_1");
    commands.release("done");
    expect(commands.begin("done", "POST", "/v1/x", {})?.statusCode).toBe(201);
    commands.begin("open", "POST", "/v1/y", {});
    expect(commands.clearPending()).toBe(1);
    expect(commands.begin("open", "POST", "/v1/y", {})).toBeNull();
    expect(commands.purgeProject("prj_1")).toBe(1);
  });
});
