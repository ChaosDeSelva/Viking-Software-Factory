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
  for (const c of spec.acceptanceCriteria) {
    let hit = false;
    for (const kind of AREA_KINDS) {
      const word = keywordHit(kind, c.text);
      if (!word) continue;
      hit = true;
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

  return AREA_KINDS.filter((k) => areas.has(k)).map((k) => area(k));
}
