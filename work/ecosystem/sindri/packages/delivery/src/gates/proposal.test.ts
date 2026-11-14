import { describe, expect, it } from "vitest";
import { checkFindings, checkProposal, mermaidBlocks, PROPOSAL_GATES } from "./proposal.js";

const SECTIONS = [
  "Why",
  "Goal",
  "Out of scope",
  "What exists today",
  "What we're borrowing",
  "Ground rules",
  "Decisions to settle",
  "Tickets",
  "Demo plan",
  "Exit criteria",
  "Risks",
  "Sources",
];
const diagram = (kind: string) => ["```mermaid", `${kind}`, "  A --> B", "```"].join("\n");
const goodProposal = [
  "# Reports page plan",
  "Four weeks, demo every Friday.",
  ...SECTIONS.flatMap((t) => {
    if (t === "Goal")
      return [`## ${t}`, "Ship it.", diagram("flowchart LR"), diagram("sequenceDiagram")];
    if (t === "Tickets")
      return [
        `## ${t}`,
        diagram("gantt"),
        diagram("flowchart TD"),
        "### Ticket 0 (spike): settle the approach",
        "- Decide where it runs",
        "### Ticket 1: list and read",
        "- [ ] Gate the tool (S, app)",
      ];
    return [`## ${t}`, "Text [1]."];
  }),
].join("\n\n");
const goodAppendix = [
  "## Findings by project",
  "### app",
  "Routes [1].",
  "## Open questions",
  "None.",
  "## Sources",
  "[1] src/routes.ts:10",
].join("\n");

describe("proposal gates", () => {
  it("passes a proposal with every section, a spike, four diagrams and its appendix", () => {
    expect(checkProposal({ proposal: goodProposal, engineering: goodAppendix })).toEqual([]);
  });

  it("fails when either document is missing", () => {
    expect(checkProposal({ proposal: null, engineering: goodAppendix })).toEqual([
      { gateId: PROPOSAL_GATES.documents, reason: "proposal_missing" },
    ]);
    expect(checkProposal({ proposal: goodProposal, engineering: null })).toEqual([
      { gateId: PROPOSAL_GATES.documents, reason: "engineering_missing" },
    ]);
  });

  it("names missing or out-of-order sections", () => {
    const out = goodProposal.replace("## Risks", "## Hazards");
    expect(checkProposal({ proposal: out, engineering: goodAppendix })).toContainEqual({
      gateId: PROPOSAL_GATES.sections,
      reason: "section_missing:Risks",
    });
    const swapped = goodProposal
      .replace("## Why", "## TMP")
      .replace("## Goal", "## Why")
      .replace("## TMP", "## Goal");
    expect(
      checkProposal({ proposal: swapped, engineering: goodAppendix }).some(
        (f) => f.reason === "section_out_of_order:Goal",
      ),
    ).toBe(true);
  });

  it("wants Ticket 0 as a spike and a ticket with checkbox subtasks", () => {
    const noSpike = goodProposal.replace("Ticket 0 (spike)", "Ticket 0");
    expect(checkProposal({ proposal: noSpike, engineering: goodAppendix })).toContainEqual({
      gateId: PROPOSAL_GATES.tickets,
      reason: "ticket0_not_a_spike",
    });
    const noBoxes = goodProposal.replace("- [ ] Gate the tool", "- Gate the tool");
    expect(checkProposal({ proposal: noBoxes, engineering: goodAppendix })).toContainEqual({
      gateId: PROPOSAL_GATES.tickets,
      reason: "no_subtasks",
    });
  });

  it("counts diagrams and refuses a block that is not a diagram", () => {
    expect(mermaidBlocks(goodProposal).map((b) => b.kind)).toEqual([
      "flowchart",
      "sequenceDiagram",
      "gantt",
      "flowchart",
    ]);
    const three = goodProposal.replace(diagram("gantt"), "");
    expect(checkProposal({ proposal: three, engineering: goodAppendix })).toContainEqual({
      gateId: PROPOSAL_GATES.diagrams,
      reason: "too_few_diagrams:3",
    });
    const bad = goodProposal.replace("sequenceDiagram", "not a diagram");
    expect(checkProposal({ proposal: bad, engineering: goodAppendix })).toContainEqual({
      gateId: PROPOSAL_GATES.diagrams,
      reason: "unknown_diagram:2",
    });
  });

  it("checks a project's findings for the research sections", () => {
    const findings =
      "## Answer\nA [1].\n## Findings\nF.\n## Open questions\nNone.\n## Sources\n[1] a.ts:1";
    expect(checkFindings(findings)).toEqual([]);
    expect(checkFindings(null)).toEqual([
      { gateId: PROPOSAL_GATES.findings, reason: "findings_missing" },
    ]);
    expect(checkFindings("## Answer\nA.")).toContainEqual({
      gateId: PROPOSAL_GATES.findings,
      reason: "section_missing:Findings",
    });
  });
});
