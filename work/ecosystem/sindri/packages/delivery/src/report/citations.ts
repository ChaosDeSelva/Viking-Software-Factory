import { detectInjection } from "@sindri/director";

/** Inline citation syntax the summary model must use: `[ref:<event or artifact id>]`. */
export const CITATION = /\[ref:([A-Za-z0-9_.:-]+)\]/g;
const ONLY_CITATIONS = /^(?:\s*\[ref:[A-Za-z0-9_.:-]+\]\s*)+$/;

export interface CitedSentence {
  text: string;
  citations: string[];
}

export interface StrippedSentence {
  text: string;
  reason: "uncited" | "unknown_citation" | "injection";
}

export interface CitationCheck {
  kept: CitedSentence[];
  stripped: StrippedSentence[];
}

/** Sentences split on `.`, `!`, `?` and newlines; a fragment of only citations joins the previous one. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (!s) continue;
      if (ONLY_CITATIONS.test(s) && out.length > 0) out[out.length - 1] += ` ${s}`;
      else out.push(s);
    }
  }
  return out;
}

/**
 * Keeps only sentences that cite at least one id, all of them in `known`, and carry no injected
 * instruction. Everything else is stripped and flagged, never silently passed through.
 */
export function validateCitations(text: string, known: ReadonlySet<string>): CitationCheck {
  const kept: CitedSentence[] = [];
  const stripped: StrippedSentence[] = [];
  for (const sentence of splitSentences(text)) {
    const citations = [...sentence.matchAll(CITATION)].map((m) => m[1]!);
    if (citations.length === 0) stripped.push({ text: sentence, reason: "uncited" });
    else if (citations.some((c) => !known.has(c))) {
      stripped.push({ text: sentence, reason: "unknown_citation" });
    } else if (detectInjection(sentence).detected) {
      stripped.push({ text: sentence, reason: "injection" });
    } else kept.push({ text: sentence, citations });
  }
  return { kept, stripped };
}
