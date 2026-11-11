import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_IDS,
  NAV,
  NAV_GROUPS,
  SCREEN_ALIASES,
  docsIndex,
  navScreen,
  getPage,
  getTerm,
  glossary,
  headingAnchors,
  linkTargets,
  pages,
  parseDocHref,
  screenHref,
  screens,
  statusInfo,
  statuses,
  termHref,
} from "./index.js";
import { STATUS_GROUPS } from "./statuses.js";

const anchorsOf = (slug: string): string[] =>
  headingAnchors(getPage(slug)?.markdown ?? "").map((h) => h.anchor);

/** Why `href` does not resolve, or null when it does. */
function brokenDocLink(href: string): string | null {
  if (/^https?:\/\//.test(href)) return null;
  const doc = parseDocHref(href);
  if (!doc) return `not a /docs/<slug>#<anchor> link`;
  if (!getPage(doc.slug)) return `no page ${doc.slug}`;
  if (doc.anchor && !anchorsOf(doc.slug).includes(doc.anchor))
    return `no heading #${doc.anchor} in ${doc.slug}`;
  return null;
}

describe("links", () => {
  it("every link in every page resolves to a page and heading", () => {
    const broken = pages.flatMap((p) =>
      linkTargets(p.markdown)
        .map((href) => [href, brokenDocLink(href)] as const)
        .filter(([, why]) => why !== null)
        .map(([href, why]) => `${p.slug}: ${href} (${why})`),
    );
    expect(broken).toEqual([]);
  });

  it("every link inside glossary text resolves", () => {
    const broken = glossary.flatMap((e) =>
      linkTargets(e.long)
        .filter((href) => brokenDocLink(href) !== null)
        .map((href) => `${e.id}: ${href}`),
    );
    expect(broken).toEqual([]);
  });

  it("every glossary entry's own href resolves", () => {
    expect(glossary.map(termHref).filter((h) => brokenDocLink(h) !== null)).toEqual([]);
  });

  it("every seeAlso names an existing glossary entry, not itself", () => {
    const ids = new Set(glossary.map((e) => e.id));
    const bad = glossary.flatMap((e) =>
      e.seeAlso.filter((id) => !ids.has(id) || id === e.id).map((id) => `${e.id} → ${id}`),
    );
    expect(bad).toEqual([]);
  });

  it("no placeholder is left unrendered", () => {
    expect(pages.filter((p) => p.markdown.includes("{{")).map((p) => p.slug)).toEqual([]);
  });
});

describe("uniqueness", () => {
  it("page slugs are unique", () => {
    const slugs = pages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("glossary ids and terms are unique", () => {
    const ids = glossary.map((e) => e.id);
    const terms = glossary.map((e) => e.term.toLowerCase());
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(terms.filter((t, i) => terms.indexOf(t) !== i)).toEqual([]);
  });

  it("no page has two headings with the same anchor", () => {
    const dupes = pages.flatMap((p) => {
      const anchors = headingAnchors(p.markdown).map((h) => h.anchor);
      return anchors
        .filter((a) => /-\d+$/.test(a) && anchors.includes(a.replace(/-\d+$/, "")))
        .map((a) => `${p.slug}#${a}`);
    });
    expect(dupes).toEqual([]);
  });

  it("screen ids are unique per app", () => {
    for (const app of APP_IDS) {
      const ids = NAV[app].map((s) => s.id);
      expect(new Set(ids).size, app).toBe(ids.length);
    }
  });
});

describe("docs.json", () => {
  it("every per-screen anchor exists in its page", () => {
    const missing = docsIndex.screens
      .filter((s) => !anchorsOf(s.slug).includes(s.anchor))
      .map((s) => `${s.app}.${s.screen} → ${s.href}`);
    expect(missing).toEqual([]);
  });

  it("lists every screen of every app", () => {
    for (const app of APP_IDS)
      for (const s of NAV[app]) expect(screenHref(app, s.id), `${app}.${s.id}`).toBeTruthy();
    expect(docsIndex.screens).toHaveLength(screens.length);
  });

  it("lists every page once, with its headings", () => {
    const listed = docsIndex.sections.flatMap((s) => s.pages.map((p) => p.slug));
    expect(listed.sort()).toEqual(pages.map((p) => p.slug).sort());
    for (const s of docsIndex.sections)
      for (const p of s.pages) expect(p.headings.length, p.slug).toBeGreaterThan(0);
  });

  it("each page starts with its title as the only H1", () => {
    for (const p of pages) {
      const h1 = headingAnchors(p.markdown).filter((h) => h.depth === 1);
      expect(
        h1.map((h) => h.text),
        p.slug,
      ).toEqual([p.title]);
    }
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(docsIndex))).toEqual(docsIndex);
  });
});

/** Screen ids the apps pass to `screenHref` (PageHeader "Learn more", bottom-bar Docs), from their source. */
const APP_SCREEN_KEYS: Readonly<Record<(typeof APP_IDS)[number], readonly string[]>> = {
  sindri: [
    ...["overview", "inbox", "director", "specs", "plans", "runs", "needs-you", "deliveries"],
    ...["knowledge", "autonomy", "project-settings", "projects", "harnesses", "autonomy-all"],
    ...["settings", "run-detail", "delivery-detail"],
  ],
  mimir: [
    ...["overview", "projects", "missions", "mission-detail", "crews", "crew-detail", "agent"],
    ...["reviews", "activity", "settings"],
  ],
  heimdall: [
    ...["overview", "new-work", "pipeline", "crews-agents", "execution-graph", "activity"],
    ...["quality-approvals", "autonomy", "notifications", "projects", "connections", "fleet"],
    "autonomy-all",
  ],
  skidbladnir: ["fleet", "launch", "history"],
};

/** Top-bar tabs and bottom-bar global pages as each app's shell draws them: `label` or `group › label`. */
const SHELLS: Readonly<Record<(typeof APP_IDS)[number], { top: string[]; bottom: string[] }>> = {
  sindri: {
    top: [
      "Overview",
      ...["Intake › Inbox", "Intake › Director", "Define › Specs", "Define › Plans"],
      ...["Execute › Runs", "Execute › Needs you", "Ship & learn › Deliveries"],
      ...["Ship & learn › Knowledge", "Ship & learn › Autonomy", "Project settings"],
    ],
    bottom: ["Projects", "Harnesses", "Autonomy (all)", "Settings", "Docs", "Ask"],
  },
  mimir: {
    top: ["Overview", "Missions", "Crews", "Reviews", "Activity"],
    bottom: ["Projects", "Settings", "Docs", "Ask"],
  },
  heimdall: {
    top: [
      ...["Watch › Overview", "Watch › Pipeline", "Watch › Crews & agents"],
      ...["Watch › Execution graph", "Watch › Activity", "Decide › Quality & approvals"],
      "Decide › Autonomy",
    ],
    bottom: [
      ...["Notifications", "Projects", "Connections", "Fleet", "Autonomy (all)", "Docs", "Ask"],
    ],
  },
  skidbladnir: {
    top: ["Worker fleet", "Launch", "Event history"],
    bottom: ["Setup guide", "Docs", "Ask"],
  },
};

describe("app screens", () => {
  it("every screen key the apps use resolves to a heading", () => {
    const broken = APP_IDS.flatMap((app) =>
      APP_SCREEN_KEYS[app]
        .map((key) => [key, screenHref(app, key)] as const)
        .filter(([, href]) => href === undefined || brokenDocLink(href) !== null)
        .map(([key]) => `${app}.${key}`),
    );
    expect(broken).toEqual([]);
  });

  it("NAV matches each app's top and bottom bar, in order", () => {
    for (const app of APP_IDS) {
      const named = (p: string) =>
        NAV[app]
          .filter((s) => s.placement === p)
          .map((s) => (s.group ? `${s.group} › ${s.label}` : s.label));
      expect({ top: named("top"), bottom: named("bottom") }, app).toEqual(SHELLS[app]);
    }
  });

  it("groups appear in NAV_GROUPS order", () => {
    for (const app of APP_IDS) {
      const used = NAV[app].flatMap((s) => (s.group ? [s.group] : []));
      expect([...new Set(used)], app).toEqual(NAV_GROUPS[app]);
    }
  });

  it("Heimdall's New work is a top-bar button, not a tab", () => {
    expect(navScreen("heimdall", "new-work")?.placement).toBe("action");
  });

  it("aliases resolve to their screen's guide and never shadow a real id", () => {
    for (const app of APP_IDS)
      for (const [alias, id] of Object.entries(SCREEN_ALIASES[app])) {
        expect(
          NAV[app].some((s) => s.id === alias),
          `${app}.${alias}`,
        ).toBe(false);
        expect(screenHref(app, alias), `${app}.${alias}`).toBe(screenHref(app, id));
        expect(screenHref(app, id), `${app}.${id}`).toBeTruthy();
      }
  });

  it("returns undefined for an unknown screen", () => {
    expect(screenHref("mimir", "no-such-screen")).toBeUndefined();
  });
});

describe("glossary", () => {
  it("every short is one line of at most 140 characters", () => {
    const bad = glossary.filter(
      (e) => e.short.length === 0 || e.short.length > 140 || e.short.includes("\n"),
    );
    expect(bad.map((e) => `${e.id} (${e.short.length})`)).toEqual([]);
  });

  it("every entry has the contract shape", () => {
    for (const e of glossary) {
      expect(typeof e.term).toBe("string");
      expect(e.long.length).toBeGreaterThan(0);
      expect(Array.isArray(e.seeAlso)).toBe(true);
    }
  });

  it("covers the audit's terms", () => {
    const required = [
      "Sindri",
      "Mimir",
      "Heimdall",
      "Brokkr",
      "Skidbladnir",
      "Feedback Graph",
      "Codex sandbox",
      "Project",
      "Bootstrap",
      "Index",
      "Repository signals",
      "Execution profile",
      "Checks",
      "Check network",
      "PATH additions",
      "Writable roots",
      "Intake",
      "Inbox",
      "Director",
      "Specification",
      "Spec version",
      "Supersede",
      "Open question",
      "Risk",
      "Blocking",
      "Plan",
      "Dry-run order",
      "Task budget",
      "Budget exceeded",
      "Harness",
      "Manifest",
      "Fixtures",
      "Run",
      "Execution",
      "Mission",
      "Task",
      "Crew",
      "Crew template",
      "Role",
      "Agent kind",
      "Agent session",
      "Runtime",
      "Capabilities",
      "Lease",
      "Verifying",
      "Quality gate",
      "Gate failure",
      "Escalation",
      "Failed attempts",
      "Delivery",
      "Local export",
      "Patch",
      "Trace",
      "Rework",
      "Request changes",
      "Reviewer finding",
      "Severity",
      "Verdict",
      "Knowledge proposal",
      "Valid knowledge",
      "Provenance",
      "Citable passage",
      "Retract",
      "Steward",
      "Autonomy",
      "Decision type",
      "Mode",
      "Accuracy",
      "Notes for the steward",
      "Approval pairing code",
      "Operator code",
      "Operator controls",
      "Read-only session",
      "Supervisor",
      "Drain",
      "Worker",
      "Slot",
      "Lease generation",
      "Epoch",
      "Snapshot",
      "Event stream",
      "Cursor",
      "Usage source",
      "High-risk command",
      "Artifact",
      "Protected branch",
      "Simulation",
      "Maximum lifetime",
      "SSM",
    ];
    expect(required.filter((t) => !getTerm(t))).toEqual([]);
  });
});

describe("statuses", () => {
  it("every registered status has a glossary entry", () => {
    const ids = new Set(glossary.map((e) => e.id));
    expect(statuses.filter((s) => !ids.has(s.term)).map((s) => `${s.app}:${s.value}`)).toEqual([]);
  });

  it("every status value of every app resolves in its own domain", () => {
    for (const s of statuses) {
      const info = statusInfo(s.app, s.value, s.domain);
      expect(info?.term, `${s.app}.${s.domain}.${s.value}`).toBe(s.term);
    }
  });

  it("has every enum value from the four apps' code", () => {
    // Copied from the code on 2026-11-11; a new value needs an entry here and in statuses.ts.
    const code: Record<string, string[]> = {
      "sindri:spec": ["draft", "review", "approved", "superseded"],
      "sindri:plan": ["draft", "review", "approved", "superseded"],
      "sindri:run": [
        "pending",
        "running",
        "awaiting_human",
        "blocked",
        "replan_requested",
        "verified_pending_review",
        "delivered_pending_merge",
        "cancelled",
        "failed",
      ],
      "sindri:delivery": ["built", "delivered_pending_merge"],
      "sindri:requirement": ["satisfied", "unsatisfied", "unverified"],
      "sindri:export": ["requested", "awaiting_approval"],
      "sindri:approval": ["pending", "approved", "rejected", "expired"],
      "sindri:brokkr-verdict": ["passed", "failed", "incomplete", "blocked"],
      "sindri:review-verdict": ["approve", "request_changes"],
      "sindri:severity": ["info", "minor", "major", "critical", "blocking"],
      "sindri:knowledge-proposal": ["proposed", "accepted", "rejected"],
      "sindri:knowledge": ["valid", "superseded", "retracted"],
      "sindri:intake-sync": ["imported", "stale", "conflict"],
      "sindri:escalation": ["block", "ask", "replan"],
      "sindri:steward-decision": [
        "pending",
        "accepted",
        "changed",
        "rejected",
        "applied",
        "rolled_back",
        "expired",
      ],
      "sindri:steward-mode": ["off", "recommend", "auto"],
      "sindri:steward-outcome": ["passed", "failed", "reworked", "unknown"],
      "sindri:steward-guidance": ["proposed", "accepted", "rejected"],
      "sindri:fg-link": ["auto", "override", "none"],
      "mimir:mission": ["draft", "active", "paused", "completed", "cancelled", "failed"],
      "mimir:task": [
        "pending",
        "ready",
        "leased",
        "running",
        "verifying",
        "completed",
        "blocked",
        "failed",
        "cancelled",
      ],
      "mimir:session": [
        "requested",
        "starting",
        "idle",
        "running",
        "waiting",
        "blocked",
        "stopping",
        "stopped",
        "completed",
        "failed",
        "unknown",
      ],
      "mimir:crew": ["configured", "running", "stopped", "archived"],
      "mimir:approval": ["pending", "approved", "rejected", "expired", "cancelled"],
      "mimir:attention": ["approval", "blocked", "stuck", "budget", "unknown"],
      "mimir:budget-alert": ["warning", "exceeded"],
      "mimir:blocked-reason": ["budget_exceeded", "budget_uncertain"],
      "mimir:provenance": ["observed", "derived", "summarized"],
      "mimir:usage": ["measured", "estimated", "unavailable"],
      "mimir:worktree": ["active", "conflicted", "removed"],
      "mimir:command": ["accepted", "running", "succeeded", "failed", "rejected"],
      "mimir:policy": ["allow", "deny", "require_approval"],
      "heimdall:fg-connection": [
        "connected",
        "disabled",
        "not configured",
        "unreachable",
        "not checked",
        "unknown",
      ],
      "heimdall:connection": ["Live", "Connecting", "Reconnecting · data may be delayed"],
      "heimdall:operator": ["Read only", "Unlocked"],
      "heimdall:pairing": ["Paired", "Not paired"],
      "heimdall:overview-attention": ["clear", "needs_attention"],
      "heimdall:supervisor": ["ready", "held", "waiting_external", "blocked"],
      "heimdall:supervisor-message": [
        "pending",
        "dispatching",
        "awaiting_approval",
        "done",
        "failed",
        "uncertain",
      ],
      "heimdall:project": ["active", "archived"],
      "skidbladnir:skid-worker": [
        "provisioning",
        "starting",
        "running",
        "stopping",
        "stopped",
        "terminating",
        "terminated",
        "failed",
        "unknown",
      ],
      "skidbladnir:ssm-command": [
        "Pending",
        "InProgress",
        "Delayed",
        "Success",
        "Failed",
        "Cancelled",
        "Cancelling",
        "TimedOut",
      ],
      "skidbladnir:terminal": ["active", "closed"],
      "sindri:open-question": ["blocking", "non-blocking"],
      "sindri:blocked-reason": ["budget_exceeded"],
      "heimdall:intake": ["received"],
      "heimdall:heimdall-compat": ["in_review", "delivered"],
      "heimdall:intake-sync": ["stale"],
      "skidbladnir:skid-worker-site": ["requested"],
    };
    const missing: string[] = [];
    for (const [key, values] of Object.entries(code)) {
      const [app, domain] = key.split(":") as [(typeof APP_IDS)[number], string];
      for (const value of values) {
        // UI strings can carry a suffix ("Reconnecting · data may be delayed").
        const bare = value.split(" · ")[0] ?? value;
        const d = domain === "skid-worker-site" ? "skid-worker" : domain;
        if (!statusInfo(app, bare, d)) missing.push(`${key}:${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("matches case, spaces and hyphens loosely", () => {
    expect(statusInfo("heimdall", "Not paired")?.label).toBe("Not paired");
    expect(statusInfo("heimdall", "Read-only")?.label).toBe("Read-only");
    expect(statusInfo("skidbladnir", "timedout")?.label).toBe("Timed out");
    expect(statusInfo("sindri", "VERIFIED_PENDING_REVIEW")?.label).toBe(
      "Verified, awaiting review",
    );
  });

  it("prefers the app's main meaning without a domain", () => {
    expect(statusInfo("sindri", "failed")?.domain).toBe("run");
    expect(statusInfo("mimir", "failed")?.domain).toBe("mission");
    expect(statusInfo("sindri", "failed", "gate")?.label).toBe("Failed");
    expect(statusInfo("heimdall", "leased")?.domain).toBe("task");
  });

  it("returns undefined for unknown values instead of throwing", () => {
    expect(statusInfo("mimir", "teleporting")).toBeUndefined();
    expect(statusInfo("sindri", "draft", "no-such-domain")).toBeUndefined();
  });

  it("status groups have unique keys and values", () => {
    const keys = STATUS_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of STATUS_GROUPS) {
      const values = g.values.map((v) => v.value.toLowerCase());
      expect(new Set(values).size, g.key).toBe(values.length);
    }
  });
});

/**
 * Once `@factory/ui` is built next to this package, every status its StatusPill maps must have a
 * meaning here. Its map is read from any export shaped `{ [app]: { [value]: role } }`.
 */
const uiDist = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "factory-ui",
  "dist",
  "index.js",
);
const uiMaps = existsSync(uiDist)
  ? await import(pathToFileURL(uiDist).href).then(
      (mod: Record<string, unknown>) =>
        Object.values(mod).find(
          (v): v is Record<string, Record<string, string>> =>
            typeof v === "object" &&
            v !== null &&
            APP_IDS.every((app) => {
              const inner = (v as Record<string, unknown>)[app];
              return typeof inner === "object" && inner !== null;
            }),
        ),
      () => undefined,
    )
  : undefined;

describe.runIf(uiMaps !== undefined)("@factory/ui status map", () => {
  it("every status the UI maps has a glossary meaning", () => {
    const missing = APP_IDS.flatMap((app) =>
      Object.keys(uiMaps?.[app] ?? {})
        .filter((value) => !statusInfo(app, value))
        .map((value) => `${app}:${value}`),
    );
    expect(missing).toEqual([]);
  });
});
