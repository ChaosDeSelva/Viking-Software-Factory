import { describe, expect, it } from "vitest";
import type { DeliveryReport } from "../report/delivery-report.js";
import { evidenceCatalog } from "./knowledge-updater.js";

describe("evidenceCatalog", () => {
  it("lists each id once, skipping tasks without a Brokkr report and reviews without a file", () => {
    const report = {
      id: "dlv_1",
      tasks: [{ planTaskId: "docs", brokkr: null }],
      testResults: [{ eventId: "evt_run", command: "pnpm test", passed: true }],
      reviews: [{ planTaskId: "impl", verdict: "approve", findings: [], reviewArtifactId: null }],
      screenshots: [],
      changedFiles: [
        { artifactId: "art_cf", path: "a.ts", planTaskId: "impl", status: "added" },
        { artifactId: "art_cf", path: "b.ts", planTaskId: "impl", status: "modified" },
      ],
      rollback: { branches: [], commits: [], note: "" },
      summary: { sentences: [{ text: "Tests ran.", citations: ["evt_run"] }], stripped: [] },
    } as unknown as DeliveryReport;
    const catalog = evidenceCatalog(report);
    expect([...catalog.keys()]).toEqual(["evt_run", "art_cf"]);
    // The first source of an id wins; a summary citation does not replace the test run.
    expect(catalog.get("evt_run")?.kind).toBe("test.run_completed");
    expect(catalog.get("art_cf")).toEqual({
      kind: "changed-files",
      payload: { deliveryId: "dlv_1", files: ["a.ts", "b.ts"] },
    });
  });
});
