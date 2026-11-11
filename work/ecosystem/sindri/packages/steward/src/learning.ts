import type { StewardWorld } from "./ports.js";
import { mostSimilar } from "./similarity.js";
import type { StewardStore, StoredDecision } from "./store.js";
import type { DecisionInput, DecisionType, FgLesson, LessonSource, Note } from "./types.js";

export interface LearningLimits {
  /** Latest project notes (decision notes included). Default 8. */
  projectNotes: number;
  /** Latest global notes. Default 5. */
  globalNotes: number;
  /** Most similar past decisions of the same type in the project. Default 5. */
  pastDecisions: number;
  /** Feedback Graph lessons. Default 8. */
  lessons: number;
  /** Most relevant approved knowledge entries. Default 8. */
  knowledge: number;
}

export const DEFAULT_LIMITS: LearningLimits = {
  projectNotes: 8,
  globalNotes: 5,
  pastDecisions: 5,
  lessons: 8,
  knowledge: 8,
};

export interface PastDecision {
  decision: StoredDecision;
  score: number;
}

/** What one recommendation looked at besides its subject. */
export interface Learning {
  notes: Note[];
  past: PastDecision[];
  lessons: FgLesson[];
  knowledge: { id: string; claim: string; guidance: boolean }[];
}

/** The text a past decision is matched on: what it was about, and what was decided. */
export const decisionText = (d: StoredDecision): string =>
  [d.subject.label, d.recommendation.value, d.appliedValue ?? ""].join(" ");

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What became of a past decision, in one line. */
export function pastSummary(d: StoredDecision): string {
  const rec = clip(d.recommendation.value, 120);
  const what =
    d.status === "changed"
      ? `recommended "${rec}", operator changed it to "${clip(d.appliedValue ?? "", 120)}"`
      : d.status === "rejected"
        ? `recommended "${rec}", operator rejected it`
        : d.status === "rolled_back"
          ? `recommended "${rec}", applied, then rolled back`
          : `recommended "${rec}", ${d.status}`;
  const outcome = d.outcome ? `; outcome ${d.outcome.result}` : "";
  return `${clip(d.subject.label, 120)}: ${what}${outcome}`;
}

/**
 * Retrieves the learning inputs of one recommendation: (a) the latest operator notes for the
 * project and global notes, (b) the most similar past decisions of the same type in the
 * project with their outcomes, (c) Feedback Graph lessons, (d) approved knowledge entries
 * (accepted steward guidance among them). Never throws on a lesson source failure.
 */
export async function gatherLearning(o: {
  store: StewardStore;
  world: StewardWorld;
  lessons?: LessonSource | undefined;
  projectId: string;
  type: DecisionType;
  query: string;
  excludeId?: string;
  limits?: Partial<LearningLimits>;
}): Promise<Learning> {
  const lim = { ...DEFAULT_LIMITS, ...o.limits };
  const all = o.store.notes(o.projectId, 200);
  const notes = [
    ...all.filter((n) => n.projectId === o.projectId).slice(0, lim.projectNotes),
    ...all.filter((n) => n.projectId === null).slice(0, lim.globalNotes),
  ];
  const past = mostSimilar(
    o.query,
    o.store.decided(o.projectId, o.type).filter((d) => d.id !== o.excludeId),
    decisionText,
    lim.pastDecisions,
  ).map(({ item, score }) => ({ decision: item, score }));
  let lessons: FgLesson[];
  try {
    lessons = o.lessons ? await o.lessons.lessonsFor(o.projectId, { limit: lim.lessons }) : [];
  } catch {
    lessons = [];
  }
  lessons = lessons.slice(0, lim.lessons);
  const guidanceIds = o.store.guidanceEntryIds(o.projectId);
  let entries: { id: string; claim: string }[];
  try {
    entries = o.world.knowledge(o.projectId);
  } catch {
    entries = [];
  }
  // Accepted guidance always counts; other entries by relevance.
  const knowledge = [
    ...entries.filter((e) => guidanceIds.has(e.id)).map((e) => ({ ...e, guidance: true })),
    ...mostSimilar(
      o.query,
      entries.filter((e) => !guidanceIds.has(e.id)),
      (e) => e.claim,
      lim.knowledge,
    )
      .filter((x) => x.score > 0)
      .map(({ item }) => ({ ...item, guidance: false })),
  ].slice(0, lim.knowledge + guidanceIds.size);
  return { notes, past, lessons, knowledge };
}

/** The learning inputs as recorded on a decision (`inputs[]`). */
export function learningInputs(l: Learning): DecisionInput[] {
  return [
    ...l.notes.map((n): DecisionInput => ({
      kind: "note",
      ref: `note:${n.id}`,
      summary: clip(`${n.projectId ? "project" : "global"} note by ${n.author}: ${n.text}`),
    })),
    ...l.past.map((p): DecisionInput => ({
      kind: "past_decision",
      ref: `decision:${p.decision.id}`,
      summary: clip(pastSummary(p.decision)),
    })),
    ...l.knowledge.map((k): DecisionInput => ({
      kind: "guidance",
      ref: `knowledge:${k.id}`,
      summary: clip(`${k.guidance ? "approved steward guidance" : "knowledge"}: ${k.claim}`),
    })),
    ...l.lessons.map((x): DecisionInput => ({
      kind: "lesson",
      ref: `fg:${x.id}`,
      summary: clip(`${x.title ? `${x.title}: ` : ""}${x.rule}`),
    })),
  ];
}
