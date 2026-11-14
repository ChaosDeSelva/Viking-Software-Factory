/**
 * Which registered projects a pasted text (a call transcript, notes) talks about, so a plan
 * request can suggest them. Suggestions only: the operator confirms the list.
 */
import { basename } from "node:path";

export interface DetectableProject {
  id: string;
  name: string;
  repoPath: string;
  /** Other names people use for the project (project settings `aliases`). */
  aliases?: readonly string[] | undefined;
}

export interface DetectedProject {
  projectId: string;
  name: string;
  /** How often the text names it, under any of its names. */
  mentions: number;
  /** The names it was found under, as the project knows them. */
  matched: string[];
  /** Named only by an everyday engineering word ("frontend"), so worth a second look. */
  weak: boolean;
}

/** Single words that are as likely to mean the thing as the project. */
const GENERIC = new Set(
  (
    "admin api app apps backend cli client common core dashboard data docs frontend infra " +
    "infrastructure internal lib mobile platform scripts sdk server service shared site tools " +
    "ui utils web website worker"
  ).split(" "),
);

/** `invoice-app`, `InvoiceApp`, `invoice_app` → ["invoice", "app"]. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s\-_.]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectProjects(
  text: string,
  projects: readonly DetectableProject[],
): DetectedProject[] {
  const found: (DetectedProject & { first: number })[] = [];
  for (const p of projects) {
    const terms = [...new Set([p.name, basename(p.repoPath), ...(p.aliases ?? [])])];
    const positions = new Set<number>();
    const matched: string[] = [];
    let weak = true;
    for (const term of terms) {
      const parts = words(term);
      // Two letters name nothing reliably ("ab", "ui").
      if (parts.join("").length < 3) continue;
      // Parts may be joined by a space, a hyphen, an underscore or nothing (camel case).
      const re = new RegExp(`\\b${parts.map(escape).join("[\\s\\-_]?")}\\b`, "gi");
      let hit = false;
      for (const m of text.matchAll(re)) {
        positions.add(m.index);
        hit = true;
      }
      if (!hit) continue;
      matched.push(term);
      if (!(parts.length === 1 && GENERIC.has(parts[0]!))) weak = false;
    }
    if (positions.size)
      found.push({
        projectId: p.id,
        name: p.name,
        mentions: positions.size,
        matched,
        weak,
        first: Math.min(...positions),
      });
  }
  return found
    .sort((a, b) => b.mentions - a.mentions || a.first - b.first)
    .map((d) => ({
      projectId: d.projectId,
      name: d.name,
      mentions: d.mentions,
      matched: d.matched,
      weak: d.weak,
    }));
}
