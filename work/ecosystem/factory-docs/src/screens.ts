// Docs sections and where each screen is explained. Kept apart from pages.ts so an app that only
// links to docs does not bundle the page text.
import { docHref, slugify } from "./markdown.js";
import { NAV, navScreen, type NavScreen } from "./navigation.js";
import { APP_IDS, type AppId, type ScreenRef } from "./types.js";

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
    id: "work",
    title: "Research and reviews",
    pages: [
      {
        slug: "research",
        title: "Research questions",
        summary: "Ask a question, get a cited document, accept or reject it. Skills and guidance.",
      },
      {
        slug: "pr-reviews",
        title: "PR reviews",
        summary: "Import a GitHub pull request, edit the review, post it once.",
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
        summary:
          "Sign-in, approvals, escalations, budgets, export, change requests, research and reviews, autonomy.",
      },
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        summary:
          "Token rejected, reconnecting, budget blocked, merge conflicts, lessons, research and PR reviews.",
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
