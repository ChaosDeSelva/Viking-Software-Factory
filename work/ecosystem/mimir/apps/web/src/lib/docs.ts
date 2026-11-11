/** Glue between routes and @factory/docs: which doc section explains the current screen. */
import { getPage, glossary, parseDocHref, screenHref, slugify, termHref } from "@factory/docs";
import type { GlossaryEntry as UiGlossaryEntry } from "@factory/ui";
import { matchPath } from "react-router";
import type { ScreenId } from "../components/Screen.js";

/** Route patterns to docs screen ids (NAV mimir) and page titles. Most specific first. */
const ROUTES: readonly { path: string; screen: ScreenId; title: string }[] = [
  { path: "/", screen: "overview", title: "Overview" },
  { path: "/projects", screen: "projects", title: "Projects" },
  { path: "/missions", screen: "missions", title: "Missions" },
  { path: "/missions/:id", screen: "mission-detail", title: "Mission" },
  { path: "/crews", screen: "crews", title: "Crews" },
  { path: "/crews/:id", screen: "crew-detail", title: "Crew" },
  { path: "/agents/:sessionId", screen: "agent", title: "Agent" },
  { path: "/reviews", screen: "reviews", title: "Reviews" },
  { path: "/activity", screen: "activity", title: "Activity" },
  { path: "/settings", screen: "settings", title: "Settings" },
  { path: "/docs", screen: "docs", title: "Docs" },
  { path: "/docs/:slug", screen: "docs", title: "Docs" },
];

export function routeFor(pathname: string): { screen: ScreenId; title: string } | null {
  const hit = ROUTES.find((r) => matchPath({ path: r.path, end: true }, pathname));
  return hit ? { screen: hit.screen, title: hit.title } : null;
}

/** Document title part for a path ("Not found" for unknown routes). */
export function titleForPath(pathname: string): string {
  return routeFor(pathname)?.title ?? "Not found";
}

export const DOCS_HOME = "/docs/finding-your-way";

/** Docs link for a screen; the docs home when the screen has no section. */
export function docsHrefFor(screen: ScreenId | undefined): string {
  return (screen && screen !== "docs" && screenHref("mimir", screen)) || DOCS_HOME;
}

/** The markdown under a screen's heading in its docs page (up to the next heading of that level). */
export function screenSection(
  screen: ScreenId,
): { title: string; markdown: string; href: string } | null {
  const href = screenHref("mimir", screen);
  const ref = href ? parseDocHref(href) : null;
  const page = ref ? getPage(ref.slug) : undefined;
  if (!href || !ref || !page || !ref.anchor) return null;
  const lines = page.markdown.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (start < 0 && slugify(m[2]!) === ref.anchor) {
      start = i;
      level = m[1]!.length;
    } else if (start >= 0 && m[1]!.length <= level) {
      return {
        title: m2title(lines[start]!),
        markdown: lines
          .slice(start + 1, i)
          .join("\n")
          .trim(),
        href,
      };
    }
  }
  return start < 0
    ? null
    : {
        title: m2title(lines[start]!),
        markdown: lines
          .slice(start + 1)
          .join("\n")
          .trim(),
        href,
      };
}

const m2title = (line: string) => line.replace(/^#+\s+/, "");

/** Glossary entries in the shape @factory/ui's GlossaryProvider takes (aliases become terms too). */
export const GLOSSARY: readonly UiGlossaryEntry[] = glossary.flatMap((g) => {
  const entry = { term: g.term, short: g.short, long: g.long, seeAlso: g.seeAlso };
  return [entry, ...g.aliases.map((a) => ({ ...entry, term: a }))];
});

const byTerm = new Map(
  glossary.flatMap((g) => [g.term, ...g.aliases].map((t) => [t.toLowerCase(), g])),
);

/** Docs link for an InfoHint's "Read more". */
export function glossaryHref(term: string): string {
  const entry = byTerm.get(term.toLowerCase());
  return entry ? termHref(entry) : `/docs/glossary#${slugify(term)}`;
}
