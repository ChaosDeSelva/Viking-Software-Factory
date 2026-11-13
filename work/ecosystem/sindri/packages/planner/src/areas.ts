/**
 * Deterministic work-area derivation from acceptance criteria and impacted repo paths.
 * Areas only decide which Brokkr task types the planner asks about; Brokkr picks harnesses.
 */
export const AREA_KINDS = ["backend", "frontend", "security", "docs"] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

/** Brokkr task types requested for each area. */
export const AREA_TASK_TYPES: Record<AreaKind, string[]> = {
  backend: ["backend", "api"],
  frontend: ["frontend", "ui"],
  security: ["security"],
  docs: ["docs"],
};

const KEYWORDS: Record<AreaKind, string[]> = {
  backend: [
    "api",
    "endpoint",
    "server",
    "database",
    "db",
    "migration",
    "query",
    "request",
    "response",
    "http",
    "status",
    "persist",
    "auth",
    "validation",
    "webhook",
    "get",
    "post",
    "put",
    "delete",
  ],
  frontend: [
    "ui",
    "page",
    "screen",
    "button",
    "form",
    "component",
    "view",
    "display",
    "layout",
    "responsive",
    "modal",
    "dashboard",
    "click",
    "accessibility",
    "a11y",
    "keyboard",
    "css",
    "mobile",
    "desktop",
  ],
  security: [
    "security",
    "secret",
    "credential",
    "permission",
    "vulnerability",
    "threat",
    "xss",
    "csrf",
    "injection",
    "encrypt",
  ],
  docs: ["readme", "docs", "documentation", "documents", "changelog", "release notes", "guide"],
};

const PATH_RULES: [AreaKind, RegExp][] = [
  ["docs", /(^|\/)docs?\/|\.mdx?$/i],
  ["frontend", /(^|\/)(web|ui|frontend|client|components?|pages?)(\/|$)|\.(tsx|jsx|css|scss)$/i],
  ["backend", /(^|\/)(server|api|backend|routes?|migrations?|db)(\/|$)/i],
];

export interface AreaInput {
  acceptanceCriteria: { id: string; text: string }[];
}

export interface RepoIndex {
  /** Same shape as the director's `RepoAnalysis.impactedSystems`. */
  impactedSystems?: { area: string; paths: string[] }[];
}

export interface WorkArea {
  kind: AreaKind;
  taskTypes: string[];
  acceptanceCriteria: string[];
  paths: string[];
  reasons: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keywordHit = (kind: AreaKind, text: string) =>
  KEYWORDS[kind].find((k) => new RegExp(`(^|[^a-z0-9])${escape(k)}([^a-z0-9]|$)`, "i").test(text));

const IMPLEMENTATION: AreaKind[] = ["backend", "frontend"];

/** Path words that put a changed file in the security area, besides the security keywords. */
const SECURITY_PATH =
  /(^|[^a-z0-9])(auth[a-z]*|login|logout|session|sessions|token|tokens|oauth|jwt|password|passwords|crypto|cipher|permissions?|acl|rbac|csp|cors|sanitiz[a-z]*|secrets?|credentials?|security|\.env)([^a-z0-9]|$)/i;

/**
 * Changed paths that touch authentication, secrets or other security areas: a security keyword
 * (as for acceptance criteria) or a security path word such as `auth`, `session` or `token`.
 */
export function securitySensitivePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => SECURITY_PATH.test(p) || keywordHit("security", p) !== undefined);
}

export function deriveWorkAreas(spec: AreaInput, repoIndex: RepoIndex = {}): WorkArea[] {
  const areas = new Map<AreaKind, WorkArea>();
  const area = (kind: AreaKind) => {
    let a = areas.get(kind);
    if (!a) {
      a = {
        kind,
        taskTypes: [...AREA_TASK_TYPES[kind]],
        acceptanceCriteria: [],
        paths: [],
        reasons: [],
      };
      areas.set(kind, a);
    }
    return a;
  };

  const unmatched: string[] = [];
  /** Criteria that mention something other than documentation: someone has to build them. */
  const toBuild: string[] = [];
  for (const c of spec.acceptanceCriteria) {
    let hit = false;
    for (const kind of AREA_KINDS) {
      const word = keywordHit(kind, c.text);
      if (!word) continue;
      hit = true;
      if (kind !== "docs" && !toBuild.includes(c.id)) toBuild.push(c.id);
      const a = area(kind);
      a.acceptanceCriteria.push(c.id);
      a.reasons.push(`${c.id} mentions "${word}"`);
    }
    if (!hit) unmatched.push(c.id);
  }

  const fromPaths = new Set<AreaKind>();
  for (const sys of repoIndex.impactedSystems ?? [])
    for (const p of sys.paths) {
      const rule = PATH_RULES.find(([, re]) => re.test(p));
      if (!rule) continue;
      const a = area(rule[0]);
      fromPaths.add(rule[0]);
      if (!a.paths.includes(p)) {
        a.paths.push(p);
        a.reasons.push(`impacted path ${p}`);
      }
    }

  if (unmatched.length > 0) {
    const pathImpl = IMPLEMENTATION.filter((k) => fromPaths.has(k));
    const impl = IMPLEMENTATION.filter((k) => areas.has(k));
    const targets =
      pathImpl.length > 0
        ? pathImpl
        : impl.length > 0
          ? impl.slice(0, 1)
          : (["backend"] as AreaKind[]);
    for (const kind of targets) {
      const a = area(kind);
      for (const id of unmatched) {
        a.acceptanceCriteria.push(id);
        a.reasons.push(`${id} has no area keyword; assigned to ${kind}`);
      }
    }
  }

  // Security and docs areas only review and document, so every criterion that asks for more than
  // documentation needs an implementer too, also when other criteria already have one. It goes
  // where the repository says the work is, else to backend.
  const uncovered = toBuild.filter(
    (id) => !IMPLEMENTATION.some((k) => areas.get(k)?.acceptanceCriteria.includes(id)),
  );
  if (uncovered.length > 0) {
    const pathImpl = IMPLEMENTATION.filter((k) => fromPaths.has(k));
    for (const kind of pathImpl.length > 0 ? pathImpl : (["backend"] as AreaKind[])) {
      const a = area(kind);
      for (const id of uncovered) {
        a.acceptanceCriteria.push(id);
        a.reasons.push(`${id} matches no implementation area; assigned to ${kind}`);
      }
    }
  }

  return AREA_KINDS.filter((k) => areas.has(k)).map((k) => area(k));
}

/**
 * URL paths a criterion text mentions (`GET /api/greeter/farewell?name=Ada` gives
 * `/api/greeter/farewell`), lower-cased without query or trailing slash. A path must start the
 * word, so repository file paths (`services/greeter/server.mjs`), full URLs
 * (`http://127.0.0.1:5100`) and query values (`?next=/health`) do not count, nor does a path whose
 * last segment has a file extension.
 */
export function urlPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s"'`(])((?:\/[A-Za-z0-9_\-{}:.~%]+)+)\/?/g)) {
    const segments = (m[1] as string).toLowerCase().split("/").slice(1);
    const last = segments.at(-1) as string;
    if (segments.some((s) => /^\.+$/.test(s)) || /\.[a-z][a-z0-9]*$/.test(last)) continue;
    found.add(`/${segments.join("/")}`);
  }
  return [...found];
}

/**
 * True when `caller` is `endpoint` or reaches it through a prefix, the way a UI gateway forwards
 * `/api/greeter/farewell` to the greeter's `/farewell`. Both start with `/`, so the match is on
 * whole segments.
 */
const reaches = (caller: string, endpoint: string) => caller.endsWith(endpoint);

/** Probe endpoints most services have: naming one says nothing about which task adds it. */
const GENERIC_ENDPOINTS = new Set(["/health", "/healthz", "/status", "/ready", "/metrics"]);

export interface ImplementationDependency {
  /** The implementation area whose task waits. */
  area: AreaKind;
  dependsOn: AreaKind;
  reasons: string[];
}

/**
 * Deterministic order between the implementation areas: the frontend task builds on the backend
 * task when a frontend criterion calls a URL path that another, backend criterion of the same spec
 * names (the backend adds or changes that endpoint, and the frontend's own checks exercise it).
 * Without such a path both run in parallel from the same base; the plan model may still order
 * them.
 */
export function implementationDependencies(
  spec: AreaInput,
  areas: readonly WorkArea[],
): ImplementationDependency[] {
  const backend = areas.find((a) => a.kind === "backend");
  const frontend = areas.find((a) => a.kind === "frontend");
  if (!backend || !frontend) return [];
  const pathsOf = (ids: readonly string[]) =>
    spec.acceptanceCriteria
      .filter((c) => ids.includes(c.id))
      .flatMap((c) => urlPaths(c.text).map((path) => ({ id: c.id, path })));
  const endpoints = pathsOf(backend.acceptanceCriteria).filter(
    (e) => !GENERIC_ENDPOINTS.has(e.path),
  );
  const reasons: string[] = [];
  for (const call of pathsOf(frontend.acceptanceCriteria)) {
    // A criterion in both areas does not count as its own backend: it would always match.
    const hit = endpoints.find((e) => e.id !== call.id && reaches(call.path, e.path));
    if (hit)
      reasons.push(
        `${call.id} (frontend) calls ${call.path}, which ${hit.id} (backend) names as ${hit.path}`,
      );
  }
  return reasons.length > 0 ? [{ area: "frontend", dependsOn: "backend", reasons }] : [];
}
