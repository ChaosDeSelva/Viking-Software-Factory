import { describe, expect, it } from "vitest";
import { deriveWorkAreas } from "./areas.js";

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
});
