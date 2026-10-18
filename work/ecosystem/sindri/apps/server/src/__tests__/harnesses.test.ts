import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFlow, type Flow } from "./flow.js";

let f: Flow;
beforeEach(async () => {
  f = await startFlow();
});
afterEach(async () => f.close());

describe("harnesses", () => {
  it("lists harnesses from the fake service while Brokkr is disabled", async () => {
    const res = await f.h.call({ url: "/v1/harnesses" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("fake");
    expect(body.harnesses.map((h: { name: string }) => h.name)).toContain("frontend-react");
  });

  it("inspects one harness with every installed version", async () => {
    const res = await f.h.call({ url: "/v1/harnesses/frontend-react" });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .versions.map((v: { version: string }) => v.version)
        .sort(),
    ).toEqual(["1.0.0", "1.1.0"]);
    expect((await f.h.call({ url: "/v1/harnesses/nope" })).statusCode).toBe(404);
  });

  it("explains a selection for a task", async () => {
    const res = await f.h.call({
      method: "POST",
      url: "/v1/harnesses/explain",
      payload: {
        task: {
          id: "t1",
          title: "CSV button",
          description: "Add a button",
          taskTypes: ["frontend"],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const { selection, explanation } = res.json();
    expect(selection.harnesses[0].name).toBe("frontend-react");
    expect(explanation.some((l: string) => l.startsWith("harness frontend-react"))).toBe(true);
    const bad = await f.h.call({ method: "POST", url: "/v1/harnesses/explain", payload: {} });
    expect(bad.statusCode).toBe(422);
  });

  it("reports repo signals", async () => {
    const res = await f.h.call({ url: `/v1/harnesses/repo-signals?projectId=${f.projectId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().signals).toHaveProperty("frameworks");
  });

  it("uses the installed Brokkr SDK when enabled", async () => {
    const st = (await f.h.call({ url: "/v1/settings" })).json().settings;
    await f.h.call({ method: "PUT", url: "/v1/settings", payload: { ...st, brokkrEnabled: true } });
    const res = await f.h.call({ url: "/v1/harnesses" });
    expect(res.statusCode).toBe(200);
  });

  it("says install, pin and verify are not supported until Brokkr is wired (not silent)", async () => {
    for (const [url, payload] of [
      ["/v1/harnesses/install", { path: "/tmp/h" }],
      ["/v1/harnesses/frontend-react/pin", { version: "1.1.0" }],
      ["/v1/harnesses/frontend-react/verify", {}],
    ] as const) {
      const res = await f.h.call({ method: "POST", url, payload });
      expect(res.statusCode, url).toBe(501);
      expect(res.json().error.code).toBe("not_supported");
      expect(res.json().error.message).toMatch(/Brokkr/);
    }
  });
});
