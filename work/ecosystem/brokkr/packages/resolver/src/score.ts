import { minimatch } from "minimatch";
import type { RepoSignals, SkillManifest, TaskDescriptor } from "@brokkr/core";

/** Points per selector match. Repo signals alone (1 point) never reach the selection threshold. */
export const SCORE_WEIGHTS = { taskType: 3, keyword: 2, path: 2, repoSignal: 1 } as const;
/** Minimum score for an optional skill to be selected. */
export const SELECTION_THRESHOLD = 2;

export interface SkillScore {
  score: number;
  reasons: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministic relevance score of a skill for a task. */
export function scoreSkill(
  skill: SkillManifest,
  task: TaskDescriptor,
  signals: RepoSignals,
): SkillScore {
  const reasons: string[] = [];
  let score = 0;
  const taskWords = new Set(
    [...(task.taskTypes ?? []), ...(task.tags ?? [])].map((t) => t.toLowerCase()),
  );
  for (const type of skill.selectors.taskTypes ?? []) {
    if (taskWords.has(type.toLowerCase())) {
      score += SCORE_WEIGHTS.taskType;
      reasons.push(`task type '${type}'`);
    }
  }
  const text = [task.title, task.description, ...(task.tags ?? [])].join("\n").toLowerCase();
  for (const keyword of skill.selectors.keywords ?? []) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword.toLowerCase())}($|[^a-z0-9])`);
    if (pattern.test(text)) {
      score += SCORE_WEIGHTS.keyword;
      reasons.push(`keyword '${keyword}' in task`);
    }
  }
  for (const glob of skill.selectors.pathGlobs ?? []) {
    const hit = (task.paths ?? []).find((p) => minimatch(p, glob, { dot: true }));
    if (hit !== undefined) {
      score += SCORE_WEIGHTS.path;
      reasons.push(`path '${hit}' matches '${glob}'`);
    }
  }
  const frameworks = new Set(signals.frameworks.map((f) => f.toLowerCase()));
  for (const tag of skill.metadata.tags) {
    if (frameworks.has(tag.toLowerCase())) {
      score += SCORE_WEIGHTS.repoSignal;
      reasons.push(`repository uses '${tag}'`);
    }
  }
  return { score, reasons };
}
