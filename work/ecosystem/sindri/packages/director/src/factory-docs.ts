import {
  getTerm,
  glossary as factoryGlossary,
  headingAnchors,
  pages,
  type GlossaryEntry as FactoryGlossaryEntry,
} from "@factory/docs";
import { rankDocs, type DocHit, type DocsSource, type GlossaryEntry } from "./guide.js";

/** Longest section text kept per hit; the prompt caps each block again. */
const MAX_SECTION_CHARS = 2000;
const MAX_HITS = 8;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Splits a page at its headings, skipping fenced code exactly like `headingAnchors` so the n-th
 * heading found here is the n-th anchor there. The text before the first `##` is the page intro.
 */
function sections(page: (typeof pages)[number]): DocHit[] {
  const anchors = headingAnchors(page.markdown);
  const out: DocHit[] = [];
  let cur: { slug: string; title: string; lines: string[] } = {
    slug: page.slug,
    title: page.title,
    lines: [page.summary],
  };
  const flush = () => {
    const text = cur.lines.join("\n").trim();
    if (text) out.push({ slug: cur.slug, title: cur.title, text: cap(text) });
  };
  let fenced = false;
  let n = 0;
  for (const line of page.markdown.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (!m) {
      cur.lines.push(line);
      continue;
    }
    const h = anchors[n++];
    // The H1 is the page title: its body stays in the intro.
    if (!h || h.depth === 1) continue;
    flush();
    cur = { slug: `${page.slug}#${h.anchor}`, title: `${page.title} › ${h.text}`, lines: [line] };
  }
  flush();
  return out;
}

const cap = (s: string) =>
  s.length > MAX_SECTION_CHARS ? `${s.slice(0, MAX_SECTION_CHARS - 1)}…` : s;

const toGuide = (e: FactoryGlossaryEntry): GlossaryEntry => ({
  term: e.term,
  short: e.short,
  long: e.long,
  seeAlso: e.seeAlso,
});

const normalize = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

let index: { hits: DocHit[]; statusByRaw: Map<string, FactoryGlossaryEntry> } | undefined;

/** Built once per process: the docs are static. */
function load() {
  if (index) return index;
  const hits = pages.flatMap(sections);
  // Concepts the glossary page does not already carry as a section (same slug, same block id);
  // the ~200 status entries are reached through `glossary()` and the statuses page.
  const slugs = new Set(hits.map((h) => h.slug));
  for (const e of factoryGlossary)
    if (e.category !== "status" && !slugs.has(`glossary#${e.id}`))
      hits.push({ slug: `glossary#${e.id}`, title: `Glossary › ${e.term}`, text: cap(e.long) });
  // Multi-word raw status values (`not_paired`, `budget_exceeded`) that mean one thing only;
  // single words like `draft` or `none` are ambiguous or too common to resolve on their own.
  const counts = new Map<string, number>();
  const statuses = factoryGlossary.filter((e) => e.category === "status");
  for (const e of statuses) for (const a of e.aliases) counts.set(a, (counts.get(a) ?? 0) + 1);
  const statusByRaw = new Map<string, FactoryGlossaryEntry>();
  for (const e of statuses)
    for (const a of e.aliases)
      if (a.includes("_") && counts.get(a) === 1) statusByRaw.set(a.toLowerCase(), e);
  index = { hits, statusByRaw };
  return index;
}

/**
 * The Guide's docs from `@factory/docs`. Search ranks page sections (slug `<page>#<anchor>`,
 * title `Page › Heading`) and glossary concepts (slug `glossary#<id>`) by keyword. Glossary
 * lookup is case-insensitive by id, term or alias, plus unambiguous multi-word raw status values.
 */
export function createFactoryDocs(): DocsSource {
  const { hits, statusByRaw } = load();
  return {
    empty: hits.length === 0,
    search: (query) => rankDocs(hits, query).slice(0, MAX_HITS),
    glossary(term) {
      if (!term.trim()) return undefined;
      const e = getTerm(term) ?? statusByRaw.get(normalize(term));
      return e && toGuide(e);
    },
  };
}
