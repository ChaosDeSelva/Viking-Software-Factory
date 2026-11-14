/**
 * Checks of a proposal plan's documents: each project's findings, and the writer's proposal and
 * engineering appendix (`@sindri/mimir-client` briefs them). Pure functions over the documents'
 * text; the gate runner reads the recorded artifacts and reports what these return.
 */
import {
  ENGINEERING_DOCUMENT,
  ENGINEERING_SECTION_TITLES,
  PROPOSAL_DOCUMENT,
  PROPOSAL_SECTION_TITLES,
  RESEARCH_DOCUMENT,
  RESEARCH_SECTION_TITLES,
} from "@sindri/mimir-client";
import type { GateFailure } from "./brokkr-report.js";

export const PROPOSAL_GATES = {
  findings: "proposal-findings",
  documents: "proposal-documents",
  sections: "proposal-sections",
  tickets: "proposal-tickets",
  diagrams: "proposal-diagrams",
} as const;

export const PROPOSAL_FILE = PROPOSAL_DOCUMENT;
export const ENGINEERING_FILE = ENGINEERING_DOCUMENT;
export const FINDINGS_FILE = RESEARCH_DOCUMENT;

const PROPOSAL_SECTIONS = PROPOSAL_SECTION_TITLES;
const ENGINEERING_SECTIONS = ENGINEERING_SECTION_TITLES;
const FINDINGS_SECTIONS = RESEARCH_SECTION_TITLES;
/** At least an architecture flowchart, one request's sequence, the weeks and the dependencies. */
export const MIN_DIAGRAMS = 4;

/** Mermaid's diagram keywords (the first word of a diagram). */
const DIAGRAM_KINDS = new Set([
  "flowchart",
  "graph",
  "sequenceDiagram",
  "gantt",
  "stateDiagram",
  "stateDiagram-v2",
  "classDiagram",
  "erDiagram",
  "journey",
  "pie",
  "timeline",
  "mindmap",
  "quadrantChart",
  "gitGraph",
]);

/** `## Title` headings in order; a heading may carry a number ("## 8. Tickets"). */
function h2s(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(?:\d+[.)]\s*)?(.+?)\s*$/gm)].map((m) => m[1]!.trim());
}

function sectionFailures(markdown: string, wanted: readonly string[], gateId: string) {
  const found = h2s(markdown).map((h) => h.toLowerCase());
  const failures: GateFailure[] = [];
  let last = -1;
  for (const title of wanted) {
    const at = found.indexOf(title.toLowerCase());
    if (at < 0) failures.push({ gateId, reason: `section_missing:${title}` });
    else if (at < last) failures.push({ gateId, reason: `section_out_of_order:${title}` });
    else last = at;
  }
  return failures;
}

/** The ```mermaid blocks of a document, with their diagram keyword (null when there is none). */
export function mermaidBlocks(markdown: string): { kind: string | null; body: string }[] {
  return [...markdown.matchAll(/^```mermaid[ \t]*\n([\s\S]*?)^```/gm)].map((m) => {
    const body = m[1]!;
    const first = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("%%"));
    const word = first?.split(/\s+/)[0] ?? "";
    return { kind: DIAGRAM_KINDS.has(word) ? word : null, body };
  });
}

/** A project's findings: the research document's sections. */
export function checkFindings(markdown: string | null): GateFailure[] {
  if (!markdown) return [{ gateId: PROPOSAL_GATES.findings, reason: "findings_missing" }];
  return sectionFailures(markdown, FINDINGS_SECTIONS, PROPOSAL_GATES.findings);
}

/** The writer's two documents. */
export function checkProposal(docs: {
  proposal: string | null;
  engineering: string | null;
}): GateFailure[] {
  const failures: GateFailure[] = [];
  if (!docs.proposal)
    failures.push({ gateId: PROPOSAL_GATES.documents, reason: "proposal_missing" });
  if (!docs.engineering)
    failures.push({ gateId: PROPOSAL_GATES.documents, reason: "engineering_missing" });
  if (failures.length) return failures;
  const proposal = docs.proposal!;
  failures.push(...sectionFailures(proposal, PROPOSAL_SECTIONS, PROPOSAL_GATES.sections));
  failures.push(
    ...sectionFailures(docs.engineering!, ENGINEERING_SECTIONS, PROPOSAL_GATES.sections).map(
      (f) => ({ ...f, reason: f.reason.replace("section_", "appendix_section_") }),
    ),
  );
  const ticket0 = /^#{2,4}\s*Ticket 0\b(.*)$/im.exec(proposal);
  if (!ticket0) failures.push({ gateId: PROPOSAL_GATES.tickets, reason: "no_ticket0" });
  else if (!/spike/i.test(ticket0[1]!))
    failures.push({ gateId: PROPOSAL_GATES.tickets, reason: "ticket0_not_a_spike" });
  if (!/^\s*[-*] \[[ xX]\] /m.test(proposal))
    failures.push({ gateId: PROPOSAL_GATES.tickets, reason: "no_subtasks" });
  const diagrams = mermaidBlocks(proposal);
  diagrams.forEach((d, i) => {
    if (d.kind === null)
      failures.push({ gateId: PROPOSAL_GATES.diagrams, reason: `unknown_diagram:${i + 1}` });
  });
  if (diagrams.length < MIN_DIAGRAMS)
    failures.push({
      gateId: PROPOSAL_GATES.diagrams,
      reason: `too_few_diagrams:${diagrams.length}`,
    });
  return failures;
}
