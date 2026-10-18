import { describe, expect, it } from "vitest";
import {
  BrokkrHarnessService,
  explainSelection,
  FAKE_HARNESSES,
  FakeHarnessService,
  SelectionSchema,
  type HarnessService,
  type TaskDescriptor,
} from "./index.js";

const task = (over: Partial<TaskDescriptor> = {}): TaskDescriptor => ({
  id: "T-1",
  title: "Add CSV export endpoint",
  description: "Expose GET /reports/export returning CSV; validate query params.",
  ...over,
});

describe("FakeHarnessService", () => {
  const svc: HarnessService = new FakeHarnessService();

  it("lists the built-in-like harnesses with versions, task types and checks", async () => {
    const list = await svc.listHarnesses();
    const names = list.map((h) => `${h.name}@${h.version}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "frontend-react@1.0.0",
        "backend-node@1.0.0",
        "security-baseline@1.0.0",
        "documentation@1.0.0",
        "qa-regression@1.0.0",
      ]),
    );
    const fe = list.find((h) => h.name === "frontend-react" && h.version === "1.0.0");
    expect(fe?.taskTypes).toEqual(expect.arrayContaining(["frontend", "ui"]));
    expect(fe?.skills.required).toContain("accessibility");
    expect(fe?.checks.some((c) => c.id === "typecheck" && c.required)).toBe(true);
  });

  it("resolves harnesses by task type and returns a Brokkr-shaped selection", async () => {
    const sel = await svc.resolve({ task: task({ taskTypes: ["api"] }) });
    expect(() => SelectionSchema.parse(sel)).not.toThrow();
    expect(sel.harnesses.map((h) => h.name)).toEqual(["backend-node"]);
    expect(sel.lock.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sel.lock.harnesses).toEqual([
      { name: "backend-node", version: "1.0.0", digest: expect.stringMatching(/^sha256:/) },
    ]);
    expect(sel.lock.skills.map((s) => s.name)).toEqual(sel.skills.map((s) => s.name).sort());
    expect(sel.rationale.some((r) => r.kind === "harness" && r.name === "backend-node")).toBe(true);
  });

  it("always includes required skills and adds optional ones only when selectors match", async () => {
    const plain = await svc.resolve({ task: task({ taskTypes: ["api"] }) });
    const names = plain.skills.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["api-design", "typescript", "input-validation", "error-handling"]),
    );
    expect(names).not.toContain("auth-review");
    const auth = await svc.resolve({
      task: task({ taskTypes: ["api"], description: "Require auth token on the endpoint" }),
    });
    expect(auth.skills.map((s) => s.name)).toContain("auth-review");
    expect(auth.rationale.some((r) => r.kind === "skill" && !r.selected)).toBe(true);
  });

  it("never hands UI skills to an API-only task", async () => {
    const sel = await svc.resolve({
      task: task({ taskTypes: ["backend", "api"], paths: ["apps/server/src/reports.ts"] }),
    });
    const names = sel.skills.map((s) => s.name);
    for (const ui of ["react-architecture", "accessibility", "tailwind", "component-design"])
      expect(names).not.toContain(ui);
  });

  it("selects several harnesses when a task spans areas", async () => {
    const sel = await svc.resolve({ task: task({ taskTypes: ["ui", "api"] }) });
    expect(sel.harnesses.map((h) => h.name).sort()).toEqual(["backend-node", "frontend-react"]);
  });

  it("resolves a named profile", async () => {
    const sel = await svc.resolve({ task: task(), profile: "backend-strict" });
    expect(sel.harnesses.map((h) => h.name).sort()).toEqual(["backend-node", "security-baseline"]);
  });

  it("pins explicit harness requests to the highest version in range", async () => {
    const caret = await svc.resolve({
      task: task(),
      harnesses: [{ name: "frontend-react", version: "^1.0.0" }],
    });
    expect(caret.harnesses[0]).toMatchObject({ name: "frontend-react", version: "1.1.0" });
    const exact = await svc.resolve({
      task: task(),
      harnesses: [{ name: "frontend-react", version: "1.0.0" }],
    });
    expect(exact.harnesses[0]?.version).toBe("1.0.0");
    expect(exact.lock.digest).not.toBe(caret.lock.digest);
  });

  it("produces a stable lock digest for the same selection", async () => {
    const a = await svc.resolve({ task: task({ taskTypes: ["api"] }) });
    const b = await svc.resolve({ task: task({ id: "T-2", taskTypes: ["api"] }) });
    expect(a.lock.digest).toBe(b.lock.digest);
  });

  it("rejects unknown harnesses, unknown profiles, profile+harnesses together, and no match", async () => {
    await expect(
      svc.resolve({ task: task(), harnesses: [{ name: "nope", version: "*" }] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      svc.resolve({ task: task(), harnesses: [{ name: "frontend-react", version: "^2.0.0" }] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.resolve({ task: task(), profile: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      svc.resolve({
        task: task(),
        profile: "backend-strict",
        harnesses: [{ name: "backend-node", version: "*" }],
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(svc.resolve({ task: task({ taskTypes: ["godot"] }) })).rejects.toMatchObject({
      code: "no_match",
    });
  });

  it("inspects the repo from a configurable fixture", async () => {
    const custom = new FakeHarnessService({
      repoSignals: {
        packageManager: "pnpm",
        frameworks: ["react"],
        scripts: ["lint", "test"],
        hasTsconfig: true,
        testRunners: ["vitest"],
      },
    });
    expect((await custom.inspectRepo()).frameworks).toEqual(["react"]);
  });

  it("supports custom harness fixtures", async () => {
    const only = new FakeHarnessService({
      harnesses: FAKE_HARNESSES.filter((h) => h.name === "documentation"),
    });
    expect((await only.listHarnesses()).map((h) => h.name)).toEqual(["documentation"]);
  });
});

describe("explainSelection", () => {
  it("passes Brokkr's rationale through as readable lines", async () => {
    const sel = await new FakeHarnessService().resolve({ task: task({ taskTypes: ["api"] }) });
    const lines = explainSelection(sel);
    expect(lines.length).toBe(sel.rationale.length);
    expect(lines[0]).toContain(sel.rationale[0]?.reason ?? "");
    expect(lines.some((l) => l.startsWith("harness backend-node"))).toBe(true);
  });
});

describe("BrokkrHarnessService", () => {
  it("resolves the installed Brokkr harness and preserves its full lock", async () => {
    const svc = new BrokkrHarnessService({ cwd: process.cwd() });
    const list = await svc.listHarnesses();
    expect(list.some((h) => h.name === "qa-regression")).toBe(true);
    const selection = await svc.resolve({ task: task(), harnesses: [{ name: "qa-regression", version: "^1" }] });
    expect(selection.lock.lockVersion).toBe(2);
    expect(selection.harnesses[0]?.name).toBe("qa-regression");
    expect((await svc.inspectRepo()).scripts).toContain("test");
  });
});
