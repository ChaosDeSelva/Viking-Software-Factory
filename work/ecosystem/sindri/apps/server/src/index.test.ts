import { openDatabase } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { buildServer, PACKAGE_NAME } from "./index.js";

describe("@sindri/server", () => {
  it("exports buildServer serving GET /v1/health", async () => {
    expect(PACKAGE_NAME).toBe("@sindri/server");
    const db = openDatabase(":memory:");
    const app = buildServer({ db, authToken: "x".repeat(64) });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
    db.close();
  });
});
