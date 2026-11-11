export type AppId = "sindri" | "mimir" | "heimdall" | "skidbladnir";

export const APP_IDS: readonly AppId[] = ["sindri", "mimir", "heimdall", "skidbladnir"];

export type GlossaryCategory =
  "product" | "planning" | "execution" | "delivery" | "autonomy" | "fleet" | "access" | "status";

export interface GlossaryEntry {
  /** Stable id; also the anchor on the glossary page (`/docs/glossary#<id>`). */
  id: string;
  term: string;
  /** Tooltip text: one plain sentence, at most 140 characters. */
  short: string;
  /** Markdown. Links use `/docs/<slug>#<anchor>`. */
  long: string;
  /** Glossary ids. */
  seeAlso: string[];
  category: GlossaryCategory;
  /** Other spellings people search for, raw enum values included. */
  aliases: string[];
}

/** One status value one app can show, and the glossary entry that explains it. */
export interface StatusRef {
  app: AppId;
  /** What the status belongs to, e.g. `run`, `task`, `worker`. */
  domain: string;
  /** The raw value as the API sends it. */
  value: string;
  /** Human label for a pill. */
  label: string;
  /** Glossary id. */
  term: string;
}

export interface Heading {
  depth: number;
  text: string;
  anchor: string;
}

export interface DocPage {
  slug: string;
  title: string;
  section: string;
  summary: string;
  markdown: string;
  /** `markdown` without its leading `# Title` line, for pages that show the title as their own H1. */
  body: string;
}

export interface ScreenRef {
  app: AppId;
  /** Stable screen id used by the apps, e.g. `runs`. */
  screen: string;
  /** The label the screen has in the navigation. */
  title: string;
  /** Where it lives: a project tab, a top-bar button, a global bottom-bar item, a detail view, or sign-in. */
  placement: "top" | "action" | "bottom" | "detail" | "entry";
  /** Top-bar group label, when the tab is in one. */
  group: string | null;
  slug: string;
  anchor: string;
  /** `/docs/<slug>#<anchor>` */
  href: string;
}

export interface DocsIndex {
  version: string;
  base: string;
  sections: {
    id: string;
    title: string;
    pages: { slug: string; title: string; summary: string; href: string; headings: Heading[] }[];
  }[];
  screens: ScreenRef[];
}
