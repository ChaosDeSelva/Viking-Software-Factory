import {
  BrokkrError,
  type LoadedSkill,
  type RepoSignals,
  type ResolvedHarnessSet,
  type ResolvedSkill,
  type SkillRejection,
  type TaskDescriptor,
} from "@brokkr/core";
import { SELECTION_THRESHOLD, scoreSkill } from "./score.js";

export interface SuggestContext {
  task: TaskDescriptor;
  repoSignals: RepoSignals;
  /** Optional skills not selected deterministically; the only names a suggestion can add. */
  candidates: string[];
  /** Skills already selected. */
  selected: string[];
}

export interface ResolveSkillsInput {
  task: TaskDescriptor;
  harnesses: ResolvedHarnessSet;
  repoSignals: RepoSignals;
  /** Maximum total `estimatedTokens`; optional skills are dropped (lowest score first) to fit. */
  budgetTokens?: number;
  /** Optional AI hook. May only add optional skills of the resolved harnesses. */
  suggest?: (ctx: SuggestContext) => Promise<string[]>;
}

export interface SkillResolution {
  skills: ResolvedSkill[];
  /** Candidates that were not selected, with the reason. */
  rationale: SkillRejection[];
  budget: { limit: number | null; used: number; exceeded: boolean };
  warnings: string[];
}

interface Pick {
  name: string;
  score: number;
  reason: string;
  requiredBy?: string;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Deterministic skill selection (spec §6): required skills always; optional
 * skills by selector score; dependency closure; conflicts are errors; optional
 * skills are trimmed lowest-score-first to honour the context budget.
 */
export async function resolveSkills(input: ResolveSkillsInput): Promise<SkillResolution> {
  const { task, harnesses, repoSignals } = input;
  const catalog = harnesses.skills;
  const warnings: string[] = [];
  const rationale: SkillRejection[] = [];

  const required: Pick[] = [];
  const optionalNames: string[] = [];
  for (const h of harnesses.harnesses) {
    const ref = `${h.manifest.metadata.name}@${h.manifest.metadata.version}`;
    for (const name of h.manifest.skills.required) {
      if (!required.some((p) => p.name === name)) {
        required.push({
          name,
          score: scoreOf(name),
          reason: `required by ${ref}`,
          requiredBy: ref,
        });
      }
    }
    for (const name of h.manifest.skills.optional)
      if (!optionalNames.includes(name)) optionalNames.push(name);
  }
  const requiredSet = new Set(required.map((p) => p.name));

  function scoreOf(name: string): number {
    const skill = catalog[name];
    return skill ? scoreSkill(skill.manifest, task, repoSignals).score : 0;
  }
  function get(name: string, from: string): LoadedSkill {
    const skill = catalog[name];
    if (!skill)
      throw new BrokkrError(
        "not-found",
        `skill '${name}' (needed by ${from}) is not provided by the resolved harnesses`,
      );
    return skill;
  }

  const optional: Pick[] = [];
  for (const name of [...optionalNames].sort()) {
    if (requiredSet.has(name)) continue;
    const { score, reasons } = scoreSkill(
      get(name, "harness optional list").manifest,
      task,
      repoSignals,
    );
    if (score >= SELECTION_THRESHOLD) optional.push({ name, score, reason: reasons.join("; ") });
    else
      rationale.push({
        name,
        reason: `no selector matched the task (score ${score}, threshold ${SELECTION_THRESHOLD})`,
        score,
      });
  }

  if (input.suggest) {
    const candidates = rationale.map((r) => r.name).sort();
    let suggested: string[] = [];
    try {
      suggested = await input.suggest({
        task,
        repoSignals,
        candidates,
        selected: [...required, ...optional].map((p) => p.name),
      });
    } catch (error) {
      warnings.push(`AI suggestion hook failed: ${(error as Error).message}`);
    }
    for (const name of [...new Set(suggested)].sort()) {
      if (candidates.includes(name)) {
        optional.push({ name, score: SELECTION_THRESHOLD, reason: "AI-suggested optional skill" });
        rationale.splice(
          rationale.findIndex((r) => r.name === name),
          1,
        );
      } else if (!requiredSet.has(name) && !optional.some((p) => p.name === name)) {
        rationale.push({
          name,
          reason: "AI suggestion rejected: not an optional skill of the resolved harnesses",
        });
      }
    }
  }

  // Dependency closure: mandatory skills first, so deps of required skills are mandatory too.
  function closure(roots: Pick[], mandatory: Map<string, Pick>): Map<string, Pick> {
    const out = new Map<string, Pick>();
    const queue = [...roots];
    while (queue.length > 0) {
      const pick = queue.shift()!;
      if (out.has(pick.name) || mandatory.has(pick.name)) continue;
      out.set(pick.name, pick);
      for (const dep of get(pick.name, pick.name).manifest.dependsOn ?? []) {
        queue.push({
          name: dep,
          score: pick.score,
          reason: `dependency of ${pick.name}`,
          ...(pick.requiredBy ? { requiredBy: pick.requiredBy } : {}),
        });
      }
    }
    return out;
  }
  const mandatory = closure(required, new Map());
  const tokens = (picks: Iterable<Pick>): number =>
    [...picks].reduce((sum, p) => sum + get(p.name, p.name).manifest.estimatedTokens, 0);

  let kept = [...optional];
  let extra = closure(kept, mandatory);
  const limit = input.budgetTokens;
  if (limit !== undefined) {
    // Drop lowest score first; ties drop the alphabetically later name first.
    const dropOrder = [...kept].sort((a, b) => a.score - b.score || byName(b, a));
    while (tokens(mandatory.values()) + tokens(extra.values()) > limit && dropOrder.length > 0) {
      const drop = dropOrder.shift()!;
      kept = kept.filter((p) => p.name !== drop.name);
      extra = closure(kept, mandatory);
      rationale.push({
        name: drop.name,
        reason: `dropped to fit the context budget of ${limit} tokens`,
        score: drop.score,
      });
    }
  }

  const all = [...mandatory.values(), ...extra.values()];
  const names = new Set(all.map((p) => p.name));
  for (const p of all) {
    for (const other of get(p.name, p.name).manifest.conflictsWith ?? []) {
      if (names.has(other)) {
        throw new BrokkrError(
          "skill-conflict",
          `skill '${p.name}' conflicts with selected skill '${other}'`,
          {
            details: { skill: p.name, conflictsWith: other },
          },
        );
      }
    }
  }

  const toResolved = (p: Pick): ResolvedSkill => ({
    name: p.name,
    version: get(p.name, p.name).manifest.metadata.version,
    selected: true,
    reason: p.reason,
    ...(p.requiredBy ? { requiredBy: p.requiredBy } : {}),
    score: p.score,
  });
  const skills = [
    ...[...mandatory.values()].sort(byName),
    ...[...extra.values()].sort((a, b) => b.score - a.score || byName(a, b)),
  ].map(toResolved);
  const used = tokens(all);
  // A candidate rejected on score but pulled in as a dependency is selected, not rejected.
  const finalRationale = rationale.filter((r) => !names.has(r.name)).sort(byName);
  return {
    skills,
    rationale: finalRationale,
    budget: { limit: limit ?? null, used, exceeded: limit !== undefined && used > limit },
    warnings,
  };
}
