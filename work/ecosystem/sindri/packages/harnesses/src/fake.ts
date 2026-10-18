import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import {
  FAKE_HARNESSES,
  FAKE_PROFILES,
  FAKE_REPO_SIGNALS,
  FAKE_SKILLS,
  type FakeHarness,
  type FakeProfile,
  type FakeSkill,
} from "./fixtures.js";
import { compareVersions, satisfies } from "./semver.js";
import {
  HarnessServiceError,
  TaskDescriptorSchema,
  type HarnessRequest,
  type HarnessService,
  type HarnessSummary,
  type RationaleEntry,
  type RepoSignals,
  type ResolveInput,
  type SelectedSkill,
  type Selection,
  type TaskDescriptor,
} from "./types.js";

export interface FakeHarnessServiceOptions {
  harnesses?: readonly FakeHarness[];
  skills?: readonly FakeSkill[];
  profiles?: readonly FakeProfile[];
  repoSignals?: RepoSignals;
}

/** Same weights and threshold as Brokkr's resolver (`@brokkr/resolver` score.ts). */
const WEIGHTS = { taskType: 3, keyword: 2, path: 2 } as const;
const THRESHOLD = 2;

const sha256 = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const ref = (h: { name: string; version: string }) => `${h.name}@${h.version}`;

/**
 * In-memory HarnessService with Brokkr-like behaviour: deterministic harness choice
 * (explicit requests, a profile, or task-type match), required skills always, optional
 * skills by selector score, and a content digest over the locked set.
 */
export class FakeHarnessService implements HarnessService {
  readonly #harnesses: readonly FakeHarness[];
  readonly #skills: ReadonlyMap<string, FakeSkill>;
  readonly #profiles: readonly FakeProfile[];
  readonly #signals: RepoSignals;
  /** Every resolve input, for assertions. */
  readonly calls: ResolveInput[] = [];

  constructor(options: FakeHarnessServiceOptions = {}) {
    this.#harnesses = options.harnesses ?? FAKE_HARNESSES;
    this.#skills = new Map((options.skills ?? FAKE_SKILLS).map((s) => [s.name, s]));
    this.#profiles = options.profiles ?? FAKE_PROFILES;
    this.#signals = options.repoSignals ?? FAKE_REPO_SIGNALS;
  }

  listHarnesses(): Promise<HarnessSummary[]> {
    return Promise.resolve(this.#harnesses.map((h) => structuredClone(h)));
  }

  inspectRepo(): Promise<RepoSignals> {
    return Promise.resolve(structuredClone(this.#signals));
  }

  resolve(input: ResolveInput): Promise<Selection> {
    this.calls.push(structuredClone(input));
    try {
      return Promise.resolve(this.#resolve(input));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  #resolve(input: ResolveInput): Selection {
    if (input.profile !== undefined && input.harnesses !== undefined)
      throw new HarnessServiceError("invalid_request", "give either profile or harnesses, not both");
    const parsed = TaskDescriptorSchema.safeParse(input.task);
    if (!parsed.success)
      throw new HarnessServiceError("invalid_request", `invalid task: ${parsed.error.message}`);
    const task = parsed.data;
    const rationale: RationaleEntry[] = [];

    let chosen: FakeHarness[];
    if (input.harnesses !== undefined || input.profile !== undefined) {
      let requests: HarnessRequest[];
      let via: string;
      if (input.profile !== undefined) {
        const profile = this.#profiles.find((p) => p.name === input.profile);
        if (!profile)
          throw new HarnessServiceError("not_found", `unknown profile '${input.profile}'`);
        requests = profile.harnesses;
        via = `profile ${profile.name}`;
      } else {
        requests = input.harnesses ?? [];
        via = "explicit request";
      }
      chosen = requests.map((r) => {
        const h = this.#pin(r);
        rationale.push({
          kind: "harness",
          name: h.name,
          selected: true,
          reason: `${via} ${r.name}@${r.version} pinned to ${h.version}`,
        });
        return h;
      });
    } else {
      const wanted = new Set(task.taskTypes ?? []);
      chosen = this.#latest().filter((h) => h.taskTypes.some((t) => wanted.has(t)));
      if (chosen.length === 0)
        throw new HarnessServiceError(
          "no_match",
          `no harness covers task types [${[...wanted].join(", ")}]`,
        );
      for (const h of chosen)
        rationale.push({
          kind: "harness",
          name: h.name,
          selected: true,
          reason: `task types ${h.taskTypes.filter((t) => wanted.has(t)).join(", ")} match ${ref(h)}`,
        });
    }

    const skills = this.#selectSkills(task, chosen, rationale);
    const harnesses = chosen.map((h) => ({
      name: h.name,
      version: h.version,
      digest: sha256(h),
      description: h.description,
      taskTypes: [...h.taskTypes],
      checks: h.checks.map((c) => ({ ...c })),
    }));
    const lockHarnesses = harnesses
      .map(({ name, version, digest }) => ({ name, version, digest }))
      .sort(byName);
    const lockSkills = skills
      .map((s) => ({ name: s.name, version: s.version, digest: sha256(this.#skills.get(s.name)) }))
      .sort(byName);
    return {
      harnesses,
      skills,
      lock: {
        digest: sha256({ harnesses: lockHarnesses, skills: lockSkills }),
        harnesses: lockHarnesses,
        skills: lockSkills,
      },
      rationale,
    };
  }

  #latest(): FakeHarness[] {
    const latest = new Map<string, FakeHarness>();
    for (const h of this.#harnesses) {
      const cur = latest.get(h.name);
      if (!cur || compareVersions(h.version, cur.version) > 0) latest.set(h.name, h);
    }
    return [...latest.values()].sort(byName);
  }

  #pin(req: HarnessRequest): FakeHarness {
    const candidates = this.#harnesses.filter((h) => h.name === req.name);
    if (candidates.length === 0)
      throw new HarnessServiceError("not_found", `unknown harness '${req.name}'`);
    const matching = candidates.filter((h) => {
      const ok = satisfies(h.version, req.version);
      if (ok === undefined)
        throw new HarnessServiceError("invalid_request", `unsupported range '${req.version}'`);
      return ok;
    });
    const best = matching.sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!best)
      throw new HarnessServiceError("not_found", `no ${req.name} version satisfies ${req.version}`);
    return best;
  }

  #score(skill: FakeSkill, task: TaskDescriptor): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    const types = new Set(task.taskTypes ?? []);
    const hitType = skill.selectors.taskTypes?.find((t) => types.has(t));
    if (hitType) {
      score += WEIGHTS.taskType;
      reasons.push(`task type ${hitType}`);
    }
    const text = `${task.title} ${task.description} ${(task.tags ?? []).join(" ")}`.toLowerCase();
    const hitWord = skill.selectors.keywords?.find((k) =>
      new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text),
    );
    if (hitWord) {
      score += WEIGHTS.keyword;
      reasons.push(`keyword "${hitWord}"`);
    }
    const hitGlob = skill.selectors.pathGlobs?.find((g) =>
      (task.paths ?? []).some((p) => matchesGlob(p, g)),
    );
    if (hitGlob) {
      score += WEIGHTS.path;
      reasons.push(`path ${hitGlob}`);
    }
    return { score, reasons };
  }

  #selectSkills(
    task: TaskDescriptor,
    harnesses: FakeHarness[],
    rationale: RationaleEntry[],
  ): SelectedSkill[] {
    const out = new Map<string, SelectedSkill>();
    const get = (name: string, from: string) => {
      const s = this.#skills.get(name);
      if (!s) throw new HarnessServiceError("not_found", `skill '${name}' (from ${from}) missing`);
      return s;
    };
    for (const h of harnesses)
      for (const name of h.skills.required) {
        if (out.has(name)) continue;
        const s = get(name, ref(h));
        const reason = `required by ${ref(h)}`;
        out.set(name, {
          name,
          version: s.version,
          reason,
          requiredBy: ref(h),
          score: this.#score(s, task).score,
        });
        rationale.push({ kind: "skill", name, selected: true, reason });
      }
    const optional = [...new Set(harnesses.flatMap((h) => h.skills.optional))].sort();
    for (const name of optional) {
      if (out.has(name)) continue;
      const s = get(name, "optional list");
      const { score, reasons } = this.#score(s, task);
      if (score >= THRESHOLD) {
        const reason = reasons.join("; ");
        out.set(name, { name, version: s.version, reason, score });
        rationale.push({ kind: "skill", name, selected: true, reason, score });
      } else {
        rationale.push({
          kind: "skill",
          name,
          selected: false,
          reason: `no selector matched the task (threshold ${THRESHOLD})`,
          score,
        });
      }
    }
    return [...out.values()];
  }
}
