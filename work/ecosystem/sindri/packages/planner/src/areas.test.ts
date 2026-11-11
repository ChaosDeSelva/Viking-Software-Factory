import { describe, expect, it } from "vitest";
import { deriveWorkAreas, implementationDependencies, urlPaths } from "./areas.js";
import { FAREWELL_ACS, GREET_FIX_ACS } from "./live-plans.test-helpers.js";

const ac = (id: string, text: string) => ({ id, text, verification: "test" as const });

describe("deriveWorkAreas", () => {
  it("classifies acceptance criteria into areas by keyword, in a stable order", () => {
    const areas = deriveWorkAreas({
      acceptanceCriteria: [
        ac("AC-1", "GET /reports/export endpoint returns CSV with status 200"),
        ac("AC-2", "An Export button on the reports page downloads the file"),
        ac("AC-3", "README documents the export limits"),
      ],
    });
    expect(areas.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC-1"]],
      ["frontend", ["AC-2"]],
      ["docs", ["AC-3"]],
    ]);
    expect(areas[0]?.taskTypes).toEqual(["backend", "api"]);
    expect(areas[1]?.reasons.join(" ")).toMatch(/AC-2 mentions "(page|button)"/);
  });

  it("lets one criterion span several areas", () => {
    const areas = deriveWorkAreas({
      acceptanceCriteria: [ac("AC-1", "The settings form saves via the API endpoint")],
    });
    expect(areas.map((a) => a.kind)).toEqual(["backend", "frontend"]);
    expect(areas.every((a) => a.acceptanceCriteria.includes("AC-1"))).toBe(true);
  });

  it("adds areas and paths from impacted repo paths", () => {
    const areas = deriveWorkAreas(
      { acceptanceCriteria: [ac("AC-1", "Exports are capped at 50k rows")] },
      {
        impactedSystems: [
          { area: "apps/server", paths: ["apps/server/src/reports.ts"] },
          { area: "apps/web", paths: ["apps/web/src/Reports.tsx"] },
        ],
      },
    );
    expect(areas.map((a) => a.kind)).toEqual(["backend", "frontend"]);
    expect(areas[0]?.paths).toEqual(["apps/server/src/reports.ts"]);
    expect(areas[1]?.paths).toEqual(["apps/web/src/Reports.tsx"]);
  });

  it("assigns unmatched criteria to path-derived implementation areas", () => {
    const areas = deriveWorkAreas(
      { acceptanceCriteria: [ac("AC-1", "Exports are capped at 50k rows")] },
      { impactedSystems: [{ area: "apps/server", paths: ["apps/server/src/reports.ts"] }] },
    );
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ kind: "backend", acceptanceCriteria: ["AC-1"] });
    expect(areas[0]?.reasons.join(" ")).toMatch(/AC-1.*no area keyword/);
  });

  it("assigns unmatched requirements to implementation even when documentation is requested", () => {
    const toImpl = deriveWorkAreas({
      acceptanceCriteria: [ac("AC-1", "Rows are capped at 50k"), ac("AC-2", "API returns 413")],
    });
    expect(toImpl.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC-2", "AC-1"]],
    ]);
    const toDocs = deriveWorkAreas({
      acceptanceCriteria: [ac("AC-1", "Rows are capped"), ac("AC-2", "Changelog mentions it")],
    });
    expect(toDocs.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC-1"]],
      ["docs", ["AC-2"]],
    ]);
  });

  it("uses the general implementation harness for requirements without area keywords", () => {
    expect(deriveWorkAreas({ acceptanceCriteria: [ac("AC-1", "Rows are capped")] })).toMatchObject([
      { kind: "backend", acceptanceCriteria: ["AC-1"] },
    ]);
  });

  it("keeps an explicitly documentation-only request scoped to documentation", () => {
    expect(
      deriveWorkAreas({ acceptanceCriteria: [ac("AC-1", "Update README examples")] }),
    ).toMatchObject([{ kind: "docs", acceptanceCriteria: ["AC-1"] }]);
  });

  it("gives a security-only ticket an implementation area, so someone builds the fix", () => {
    const areas = deriveWorkAreas({
      acceptanceCriteria: [
        ac("AC-1", "The session secret is rotated on every deploy"),
        ac("AC-2", "The threat model in the documentation covers credential stuffing"),
        ac("AC-3", "The changelog mentions it"),
      ],
    });
    expect(areas.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC-1", "AC-2"]],
      ["security", ["AC-1", "AC-2"]],
      ["docs", ["AC-2", "AC-3"]],
    ]);
    expect(areas[0]!.reasons).toContain("AC-1 matches no implementation area; assigned to backend");
    // A path-derived docs area does not count as implementation either.
    expect(
      deriveWorkAreas(
        { acceptanceCriteria: [ac("AC-1", "No XSS in rendered names")] },
        { impactedSystems: [{ area: "docs", paths: ["docs/security.md"] }] },
      ).map((a) => a.kind),
    ).toEqual(["backend", "security", "docs"]);
    // An implementation area that was derived is left alone.
    expect(
      deriveWorkAreas({
        acceptanceCriteria: [ac("AC-1", "The button escapes input against XSS")],
      }).map((a) => a.kind),
    ).toEqual(["frontend", "security"]);
  });

  it("gives a security-only criterion in a mixed ticket an implementer too", () => {
    const mixed = deriveWorkAreas({
      acceptanceCriteria: [
        ac("AC-1", "An Export button on the reports page downloads the file"),
        ac("AC-2", "The session secret is rotated on every deploy"),
        ac("AC-3", "README documents the export limits"),
      ],
    });
    expect(mixed.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC-2"]],
      ["frontend", ["AC-1"]],
      ["security", ["AC-2"]],
      ["docs", ["AC-3"]],
    ]);
    expect(mixed[0]!.reasons).toEqual(["AC-2 matches no implementation area; assigned to backend"]);
    // An existing implementation area takes it only when it already covers the criterion.
    expect(
      deriveWorkAreas({
        acceptanceCriteria: [
          ac("AC-1", "The API endpoint returns 200"),
          ac("AC-2", "The session secret is rotated on every deploy"),
        ],
      }).map((a) => [a.kind, a.acceptanceCriteria]),
    ).toEqual([
      ["backend", ["AC-1", "AC-2"]],
      ["security", ["AC-2"]],
    ]);
    // The repository says where the work is: the impacted implementation area gets it.
    expect(
      deriveWorkAreas(
        { acceptanceCriteria: [ac("AC-1", "No XSS in rendered names")] },
        { impactedSystems: [{ area: "apps/web", paths: ["apps/web/src/Names.tsx"] }] },
      ).map((a) => [a.kind, a.acceptanceCriteria]),
    ).toEqual([
      ["frontend", ["AC-1"]],
      ["security", ["AC-1"]],
    ]);
  });

  it("ignores impacted paths no rule knows and lists a repeated path once", () => {
    const areas = deriveWorkAreas(
      { acceptanceCriteria: [ac("AC-1", "Rows are capped")] },
      {
        impactedSystems: [
          { area: "a", paths: ["Makefile", "src/server/x.ts"] },
          { area: "b", paths: ["src/server/x.ts"] },
        ],
      },
    );
    expect(areas.map((a) => [a.kind, a.paths])).toEqual([["backend", ["src/server/x.ts"]]]);
  });
});

describe("urlPaths", () => {
  it("finds endpoint paths without query strings, and ignores file paths and full URLs", () => {
    expect(urlPaths(FAREWELL_ACS[0]!.text)).toEqual(["/farewell"]);
    expect(urlPaths(FAREWELL_ACS[1]!.text)).toEqual(["/api/greeter/farewell"]);
    expect(urlPaths(FAREWELL_ACS[4]!.text)).toEqual([]);
    expect(urlPaths("The page served at / has a button")).toEqual([]);
    expect(urlPaths("see `/docs/guide.md` and services/greeter/server.mjs")).toEqual([]);
    expect(urlPaths('POST "/Users/{id}/" and GET /api/greeter/...')).toEqual(["/users/{id}"]);
    expect(urlPaths("GET /login?next=/health redirects")).toEqual(["/login"]);
  });
});

describe("implementationDependencies", () => {
  it("orders frontend after backend when a frontend criterion calls an endpoint the backend adds (live farewell plan)", () => {
    const spec = { acceptanceCriteria: FAREWELL_ACS };
    const areas = deriveWorkAreas(spec);
    expect(areas.map((a) => [a.kind, a.acceptanceCriteria])).toEqual([
      ["backend", ["AC1", "AC2", "AC5", "AC6"]],
      ["frontend", ["AC2", "AC3", "AC4", "AC5"]],
    ]);
    const deps = implementationDependencies(spec, areas);
    expect(deps).toEqual([{ area: "frontend", dependsOn: "backend", reasons: expect.any(Array) }]);
    expect(deps[0]!.reasons).toContain(
      "AC2 (frontend) calls /api/greeter/farewell, which AC1 (backend) names as /farewell",
    );
  });

  it("keeps implementation tasks parallel when the frontend calls no endpoint the backend names (live greet fix)", () => {
    const spec = { acceptanceCriteria: GREET_FIX_ACS };
    const areas = deriveWorkAreas(spec);
    expect(areas.find((a) => a.kind === "frontend")?.acceptanceCriteria).toEqual(["AC5"]);
    expect(implementationDependencies(spec, areas)).toEqual([]);
  });

  it("matches whole segments of another criterion only, and needs both implementation areas", () => {
    const spec = {
      acceptanceCriteria: [
        ac("AC-1", "GET /farewell endpoint returns 200"),
        ac("AC-2", "The page button calls /api/xfarewell"),
      ],
    };
    expect(implementationDependencies(spec, deriveWorkAreas(spec))).toEqual([]);
    // One criterion in both areas does not order the tasks against itself.
    const shared = { acceptanceCriteria: [ac("AC-1", "The form saves via POST /api/settings")] };
    expect(deriveWorkAreas(shared).map((a) => a.kind)).toEqual(["backend", "frontend"]);
    expect(implementationDependencies(shared, deriveWorkAreas(shared))).toEqual([]);
    // Generic probe endpoints and query values name nothing a backend task adds for the page.
    const generic = {
      acceptanceCriteria: [
        ac("AC-1", "GET /health endpoint returns 200"),
        ac("AC-2", "The page status badge polls /api/health"),
        ac("AC-3", "The page button links to /login?next=/farewell"),
        ac("AC-4", "GET /farewell endpoint returns 200"),
      ],
    };
    expect(deriveWorkAreas(generic).map((a) => a.kind)).toEqual(["backend", "frontend"]);
    expect(implementationDependencies(generic, deriveWorkAreas(generic))).toEqual([]);
    const backendOnly = { acceptanceCriteria: [ac("AC-1", "GET /farewell returns 200")] };
    expect(implementationDependencies(backendOnly, deriveWorkAreas(backendOnly))).toEqual([]);
  });
});
