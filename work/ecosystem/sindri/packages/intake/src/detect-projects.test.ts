import { describe, expect, it } from "vitest";
import { detectProjects } from "./detect-projects.js";

const projects = [
  { id: "p-app", name: "invoice-app", repoPath: "/code/invoice-app" },
  { id: "p-docs", name: "DocsSite", repoPath: "/code/docs-site" },
  { id: "p-api", name: "billing", repoPath: "/code/billing-api", aliases: ["the ledger"] },
  { id: "p-ui", name: "frontend", repoPath: "/code/frontend" },
  { id: "p-x", name: "ab", repoPath: "/code/ab" },
];

describe("detectProjects", () => {
  it("finds projects by name, folder name and alias, however they are spelled, most mentioned first", () => {
    const text = [
      "We need the invoice app to call billing, and the Invoice-App team owns it.",
      "Update the docs site too (DocsSite, or docs_site on disk).",
      "Talk to the ledger people, and to the invoice_app folks.",
    ].join("\n");
    const found = detectProjects(text, projects);
    expect(found.map((f) => f.projectId)).toEqual(["p-app", "p-docs", "p-api"]);
    expect(found[0]).toMatchObject({ name: "invoice-app", mentions: 3 });
    expect(found[2]!.matched).toEqual(expect.arrayContaining(["billing", "the ledger"]));
  });

  it("matches whole words only, and ignores names too short to mean anything", () => {
    const found = detectProjects("The rebilling job and the abacus; ab testing.", projects);
    expect(found).toEqual([]);
  });

  it("marks an everyday word as weak so it is suggested, not assumed", () => {
    const [ui] = detectProjects("The frontend shows the totals.", projects);
    expect(ui).toMatchObject({ projectId: "p-ui", weak: true });
    const [app] = detectProjects("The invoice-app shows the totals.", projects);
    expect(app).toMatchObject({ projectId: "p-app", weak: false });
  });
});
