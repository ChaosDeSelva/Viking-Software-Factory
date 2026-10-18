import type { AcceptanceCriterion, Assumption, OpenQuestion, SpecBody } from "./body.js";

export interface ListDiff<T> {
  added: T[];
  removed: T[];
}
export interface KeyedDiff<T> extends ListDiff<T> {
  changed: { key: string; from: T; to: T }[];
}

export interface SpecDiff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  title?: { from: string; to: string };
  problem?: { from: string; to: string };
  goals: ListDiff<string>;
  nonGoals: ListDiff<string>;
  constraints: ListDiff<string>;
  risks: ListDiff<string>;
  /** Keyed by assumption text; `changed` means the risk level changed. */
  assumptions: KeyedDiff<Assumption>;
  /** Keyed by criterion id. */
  acceptanceCriteria: KeyedDiff<AcceptanceCriterion>;
  /** Keyed by question id. */
  openQuestions: KeyedDiff<OpenQuestion>;
  changed: boolean;
}

/** Set-based: duplicates and reordering are ignored by design. */
function listDiff(a: string[], b: string[]): ListDiff<string> {
  const sa = new Set(a);
  const sb = new Set(b);
  return { added: b.filter((x) => !sa.has(x)), removed: a.filter((x) => !sb.has(x)) };
}

function keyedDiff<T>(a: T[], b: T[], key: (t: T) => string): KeyedDiff<T> {
  const ma = new Map(a.map((x) => [key(x), x]));
  const mb = new Map(b.map((x) => [key(x), x]));
  const out: KeyedDiff<T> = { added: [], removed: [], changed: [] };
  for (const [k, v] of mb) {
    const prev = ma.get(k);
    if (prev === undefined) out.added.push(v);
    else if (JSON.stringify(prev) !== JSON.stringify(v))
      out.changed.push({ key: k, from: prev, to: v });
  }
  for (const [k, v] of ma) if (!mb.has(k)) out.removed.push(v);
  return out;
}

export interface DiffSide {
  id: string;
  version: number;
  title: string;
  body: SpecBody;
}

export function diffSpecs(a: DiffSide, b: DiffSide): SpecDiff {
  const d: SpecDiff = {
    from: { id: a.id, version: a.version },
    to: { id: b.id, version: b.version },
    goals: listDiff(a.body.goals, b.body.goals),
    nonGoals: listDiff(a.body.nonGoals, b.body.nonGoals),
    constraints: listDiff(a.body.constraints, b.body.constraints),
    risks: listDiff(a.body.risks, b.body.risks),
    assumptions: keyedDiff(a.body.assumptions, b.body.assumptions, (x) => x.text),
    acceptanceCriteria: keyedDiff(
      a.body.acceptanceCriteria,
      b.body.acceptanceCriteria,
      (x) => x.id,
    ),
    openQuestions: keyedDiff(a.body.openQuestions, b.body.openQuestions, (x) => x.id),
    changed: false,
  };
  if (a.title !== b.title) d.title = { from: a.title, to: b.title };
  if (a.body.problem !== b.body.problem) d.problem = { from: a.body.problem, to: b.body.problem };
  const lists = [d.goals, d.nonGoals, d.constraints, d.risks];
  const keyed = [d.assumptions, d.acceptanceCriteria, d.openQuestions];
  d.changed =
    !!d.title ||
    !!d.problem ||
    lists.some((l) => l.added.length + l.removed.length > 0) ||
    keyed.some((k) => k.added.length + k.removed.length + k.changed.length > 0);
  return d;
}
