import { sanitizeForDisplay } from "@sindri/intake";
import type { Provenance, ProvenanceRef, SpecBody } from "./body.js";

export interface RenderInput {
  title: string;
  version: number;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  body: SpecBody;
  provenance: Provenance;
}

const clean = (s: string) => sanitizeForDisplay(s);
const inline = (s: string) =>
  clean(s)
    .replace(/\s*\n\s*/g, " ")
    .trim();

export function refLabel(r: ProvenanceRef): string {
  if ("knowledgeEntryId" in r) return `knowledge:${r.knowledgeEntryId}`;
  if ("taskEvidenceId" in r) return `evidence:${r.taskEvidenceId}`;
  if ("intakeId" in r) return `intake:${r.intakeId}`;
  const range =
    r.startLine !== undefined
      ? `#L${r.startLine}${r.endLine !== undefined ? `-L${r.endLine}` : ""}`
      : "";
  return `document:${r.documentId}${range}`;
}

const sources = (refs: ProvenanceRef[] | undefined) =>
  refs && refs.length ? `_Sources: ${refs.map(refLabel).join(", ")}_` : "_Sources: none_";

/** Render a specification as Markdown. All ticket-derived text is sanitised first. */
export function renderSpec(s: RenderInput): string {
  const b = s.body;
  const p = s.provenance;
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${inline(i)}`) : ["_None._"];
  const out: string[] = [];
  out.push(`# ${inline(s.title)}`, "");
  let meta = `Version ${s.version} · ${s.status}`;
  if (s.approvedBy) meta += ` · approved by ${inline(s.approvedBy)} at ${s.approvedAt ?? "?"}`;
  out.push(`_${meta}_`, "");
  out.push("## Problem", "", clean(b.problem).trim(), "", sources(p.problem), "");
  out.push("## Goals", "", ...list(b.goals), "", sources(p.goals), "");
  out.push("## Non-goals", "", ...list(b.nonGoals), "", sources(p.nonGoals), "");
  out.push("## Constraints", "", ...list(b.constraints), "", sources(p.constraints), "");
  out.push(
    "## Assumptions",
    "",
    ...(b.assumptions.length
      ? b.assumptions.map((a) => `- [${a.risk} risk] ${inline(a.text)}`)
      : ["_None._"]),
    "",
    sources(p.assumptions),
    "",
  );
  out.push("## Acceptance criteria", "");
  if (!b.acceptanceCriteria.length) out.push("_None._");
  for (const ac of b.acceptanceCriteria) {
    out.push(`- **${inline(ac.id)}** (${ac.verification}): ${inline(ac.text)}`);
    out.push(`  ${sources(p.acceptanceCriteria[ac.id])}`);
  }
  out.push("");
  out.push("## Risks", "", ...list(b.risks), "", sources(p.risks), "");
  out.push(
    "## Open questions",
    "",
    ...(b.openQuestions.length
      ? b.openQuestions.map(
          (q) =>
            `- **${inline(q.id)}** (${q.blocking ? "blocking" : "non-blocking"}): ${inline(q.text)}`,
        )
      : ["_None._"]),
    "",
    sources(p.openQuestions),
  );
  return out.join("\n") + "\n";
}
