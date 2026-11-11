import { RAW_PAGES } from "./generated/content.js";
import { getTerm, glossary, groupApps, statusTermName, termHref } from "./glossary.js";
import { docHref, headingAnchors } from "./markdown.js";
import {
  APP_NAMES,
  NAV,
  navScreen,
  screenPlace,
  type NavScreen,
  type Placement,
} from "./navigation.js";
import { STATUS_GROUPS } from "./statuses.js";
import {
  APP_IDS,
  type AppId,
  type DocPage,
  type DocsIndex,
  type GlossaryCategory,
} from "./types.js";
import { SECTIONS, screenDoc, screens } from "./screens.js";

function resolveScreen(ref: string): { app: AppId; screen: NavScreen } {
  const [app, id] = ref.split(".") as [AppId, string];
  const screen = APP_IDS.includes(app) ? navScreen(app, id) : undefined;
  if (!screen) throw new Error(`Unknown screen reference {{…:${ref}}}`);
  return { app, screen };
}

const shortName = (s: NavScreen): string =>
  s.placement === "top" && s.group ? `${s.group} › ${s.label}` : s.label;

/** Where a screen is, after its name in running text; tabs and details need no hint. */
const TEXT_SUFFIX: Partial<Record<Placement, string>> = {
  bottom: " (bottom bar)",
  action: " (top-bar button)",
};

function screenText(ref: string): string {
  const { screen } = resolveScreen(ref);
  return `**${shortName(screen)}**${TEXT_SUFFIX[screen.placement] ?? ""}`;
}

function screenLink(ref: string): string {
  const { app, screen } = resolveScreen(ref);
  const doc = screenDoc(app, screen);
  return `[${shortName(screen)}](${docHref(doc.slug, doc.anchor)})`;
}

const PLACE_WORDS: Readonly<Record<Placement, string>> = {
  top: "top bar",
  action: "top-bar button",
  bottom: "bottom bar",
  detail: "opens from a list",
  entry: "before sign-in",
};

function navMap(): string {
  const where = (s: NavScreen): string =>
    s.placement === "top" ? `top bar${s.group ? `, ${s.group}` : ""}` : PLACE_WORDS[s.placement];
  return APP_IDS.map((app) => {
    const rows = NAV[app].map((s) => {
      const doc = screenDoc(app, s);
      return `| [${s.label}](${docHref(doc.slug, doc.anchor)}) | ${where(s)} |`;
    });
    return [`### ${APP_NAMES[app]}`, "", "| Screen | Where |", "|---|---|", ...rows].join("\n");
  }).join("\n\n");
}

/** Groups by the app that owns the thing; groups every app shows go under "All apps". */
const OWNER: Readonly<Record<string, AppId | "shared">> = {
  connection: "shared",
  mission: "mimir",
  task: "mimir",
  session: "mimir",
  crew: "mimir",
  approval: "mimir",
  provenance: "mimir",
  usage: "mimir",
};

function ownerOf(key: string): AppId | "shared" {
  return OWNER[key] ?? groupApps(key)[0] ?? "shared";
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function statusTables(): string {
  const owners: (AppId | "shared")[] = [...APP_IDS, "shared"];
  return owners
    .map((owner) => {
      const groups = STATUS_GROUPS.filter((g) => ownerOf(g.key) === owner);
      const title = owner === "shared" ? "All apps" : APP_NAMES[owner];
      const body = groups.map((g) => {
        const concept = getTerm(g.concept);
        const shownIn = groupApps(g.key).map((a) => APP_NAMES[a]);
        const head = [
          `### ${capitalize(g.noun)} status`,
          "",
          `Shown in: ${shownIn.join(", ")}.${concept ? ` About: [${concept.term}](${termHref(concept)}).` : ""}`,
        ];
        const values = g.values.flatMap((v) => [
          "",
          `#### ${statusTermName(g, v)}`,
          "",
          `\`${v.value}\` · ${v.more ? `${v.short} ${v.more}` : v.short}`,
        ]);
        return [...head, ...values].join("\n");
      });
      return [`## ${title}`, "", ...body.flatMap((b) => [b, ""])].join("\n").trimEnd();
    })
    .join("\n\n");
}

const CATEGORY_TITLES: readonly [GlossaryCategory, string][] = [
  ["product", "The programs"],
  ["planning", "Planning"],
  ["execution", "Execution"],
  ["delivery", "Delivery and review"],
  ["autonomy", "Autonomy and the steward"],
  ["access", "Access and sign-in"],
  ["fleet", "Fleet and workers"],
];

function glossaryBody(): string {
  return CATEGORY_TITLES.map(([category, title]) => {
    const entries = glossary
      .filter((e) => e.category === category)
      .sort((a, b) => a.term.localeCompare(b.term));
    const body = entries.map((e) => {
      const parts = [`### ${e.term}`, "", e.long];
      if (e.aliases.length) parts.push("", `Also called: ${e.aliases.join(", ")}.`);
      const see = e.seeAlso
        .map((id) => getTerm(id))
        .filter((x) => x !== undefined)
        .map((x) => `[${x.term}](${termHref(x)})`);
      if (see.length) parts.push("", `See also: ${see.join(", ")}.`);
      return parts.join("\n");
    });
    return [`## ${title}`, "", body.join("\n\n")].join("\n");
  }).join("\n\n");
}

/** Replaces `{{screen:…}}`, `{{screenlink:…}}`, `{{place:…}}`, `{{label:…}}` and block placeholders. */
export function render(markdown: string): string {
  return markdown
    .replace(/\{\{nav-map\}\}/g, () => navMap())
    .replace(/\{\{status-tables\}\}/g, () => statusTables())
    .replace(/\{\{glossary\}\}/g, () => glossaryBody())
    .replace(
      /\{\{(screen|screenlink|place|label):([a-z0-9.-]+)\}\}/g,
      (_, kind: string, ref: string) => {
        if (kind === "screen") return screenText(ref);
        if (kind === "screenlink") return screenLink(ref);
        const { app, screen } = resolveScreen(ref);
        return kind === "place" ? screenPlace(app, screen) : screen.label;
      },
    );
}

export const pages: readonly DocPage[] = SECTIONS.flatMap((section) =>
  section.pages.map((p) => {
    const raw = RAW_PAGES[p.slug];
    if (raw === undefined) throw new Error(`content/${p.slug}.md is missing`);
    const markdown = render(raw);
    return { ...p, section: section.id, markdown, body: markdown.replace(/^\s*#\s.*\n+/, "") };
  }),
);

export function getPage(slug: string): DocPage | undefined {
  return pages.find((p) => p.slug === slug);
}

export const docsIndex: DocsIndex = {
  version: "0.1.1",
  base: "/docs",
  sections: SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    pages: section.pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      href: docHref(p.slug),
      headings: headingAnchors(getPage(p.slug)?.markdown ?? ""),
    })),
  })),
  screens: [...screens],
};

export interface DocsSearchHit {
  key: string;
  title: string;
  /** The page a heading is on, or a page's summary. */
  where: string;
  href: string;
}

interface SearchEntry {
  hit: DocsSearchHit;
  text: string;
}

let searchIndex:
  { titles: SearchEntry[]; headings: SearchEntry[]; bodies: SearchEntry[] } | undefined;

/** Lowercased once on first search: the pages never change at run time. */
function index() {
  searchIndex ??= {
    titles: pages.map((p) => ({
      hit: { key: p.slug, title: p.title, where: p.summary, href: docHref(p.slug) },
      text: p.title.toLowerCase(),
    })),
    headings: pages.flatMap((p) =>
      headingAnchors(p.markdown)
        .filter((h) => h.depth > 1)
        .map((h) => ({
          hit: {
            key: `${p.slug}#${h.anchor}`,
            title: h.text,
            where: p.title,
            href: docHref(p.slug, h.anchor),
          },
          text: h.text.toLowerCase(),
        })),
    ),
    bodies: pages.map((p) => ({
      hit: { key: p.slug, title: p.title, where: p.summary, href: docHref(p.slug) },
      text: `${p.title} ${p.summary} ${p.markdown}`.toLowerCase(),
    })),
  };
  return searchIndex;
}

/**
 * Pages whose title matches, then matching headings, then pages that mention every word.
 * Title matches come first so a page like Statuses is never crowded out by its own headings.
 */
export function searchDocs(query: string, limit = 20): DocsSearchHit[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length === 0) return [];
  const { titles, headings, bodies } = index();
  const seen = new Set<string>();
  const out: DocsSearchHit[] = [];
  for (const e of [...titles, ...headings, ...bodies]) {
    if (out.length >= limit) break;
    if (seen.has(e.hit.key) || !words.every((w) => e.text.includes(w))) continue;
    seen.add(e.hit.key);
    out.push(e.hit);
  }
  return out;
}
