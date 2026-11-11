import { RAW_PAGES } from "./generated/content.js";
import { getTerm, glossary, groupApps, statusTermName, termHref } from "./glossary.js";
import { docHref, headingAnchors, slugify } from "./markdown.js";
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
  type ScreenRef,
} from "./types.js";

export const SECTIONS: readonly {
  id: string;
  title: string;
  pages: readonly { slug: string; title: string; summary: string }[];
}[] = [
  {
    id: "start",
    title: "Start here",
    pages: [
      {
        slug: "how-the-factory-works",
        title: "How the factory works",
        summary: "Which program does what, and how a request becomes a verified change.",
      },
      {
        slug: "ticket-to-delivery",
        title: "From ticket to delivery",
        summary: "Every step of one piece of work, with the screen to use at each step.",
      },
      {
        slug: "finding-your-way",
        title: "Finding your way",
        summary: "Top bar, bottom bar, every screen, Docs, Ask and shortcuts.",
      },
    ],
  },
  {
    id: "screens",
    title: "Screens",
    pages: [
      {
        slug: "sindri-screens",
        title: "Sindri screens",
        summary: "Planning, runs and deliveries.",
      },
      {
        slug: "mimir-screens",
        title: "Mimir screens",
        summary: "Missions, tasks, crews and agents.",
      },
      {
        slug: "heimdall-screens",
        title: "Heimdall screens",
        summary: "The dashboard over Sindri and Mimir.",
      },
      {
        slug: "skidbladnir-screens",
        title: "Skidbladnir screens",
        summary: "Disposable worker machines.",
      },
    ],
  },
  {
    id: "operate",
    title: "Operating",
    pages: [
      {
        slug: "operator-guide",
        title: "Operator guide",
        summary: "Sign-in, approvals, escalations, budgets, export, change requests, autonomy.",
      },
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        summary: "Token rejected, reconnecting, budget blocked, merge conflicts, Feedback Graph.",
      },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    pages: [
      {
        slug: "statuses",
        title: "Statuses",
        summary: "Every status in every app, in plain words.",
      },
      { slug: "glossary", title: "Glossary", summary: "Every term the apps use." },
    ],
  },
];

/** Bottom-bar help items are documented once, on the navigation page. */
const SHARED_SCREENS: Readonly<Record<string, string>> = {
  docs: "finding-your-way",
  ask: "finding-your-way",
};

export function screenDoc(app: AppId, screen: NavScreen): { slug: string; anchor: string } {
  return { slug: SHARED_SCREENS[screen.id] ?? `${app}-screens`, anchor: slugify(screen.label) };
}

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
    return { ...p, section: section.id, markdown: render(raw) };
  }),
);

export function getPage(slug: string): DocPage | undefined {
  return pages.find((p) => p.slug === slug);
}

export const screens: readonly ScreenRef[] = APP_IDS.flatMap((app) =>
  NAV[app].map((s) => {
    const doc = screenDoc(app, s);
    return {
      app,
      screen: s.id,
      title: s.label,
      placement: s.placement,
      group: s.group,
      slug: doc.slug,
      anchor: doc.anchor,
      href: docHref(doc.slug, doc.anchor),
    };
  }),
);

/**
 * `/docs/<slug>#<anchor>` for a screen's guide, for the PageHeader "Learn more" link. Accepts the
 * aliases in SCREEN_ALIASES; undefined for an unknown id.
 */
export function screenHref(app: AppId, screenId: string): string | undefined {
  const id = navScreen(app, screenId)?.id;
  return id === undefined ? undefined : screens.find((s) => s.app === app && s.screen === id)?.href;
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
