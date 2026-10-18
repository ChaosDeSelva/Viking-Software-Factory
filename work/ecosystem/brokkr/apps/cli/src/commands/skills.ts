import { inspectRepo, resolveSkills } from "@brokkr/resolver";
import type { CommandContext } from "../io.js";
import { loadTask, openRegistry, parseBudget, requireConfig, resolveConfigured } from "./shared.js";

export async function skillsList(ctx: CommandContext): Promise<number> {
  const registry = await openRegistry(ctx);
  const byKey = new Map<
    string,
    { name: string; version: string; description: string; providedBy: string[] }
  >();
  for (const s of registry.skills()) {
    const key = `${s.manifest.metadata.name}@${s.manifest.metadata.version}`;
    const entry = byKey.get(key) ?? {
      name: s.manifest.metadata.name,
      version: s.manifest.metadata.version,
      description: s.manifest.metadata.description,
      providedBy: [],
    };
    entry.providedBy.push(s.providedBy);
    byKey.set(key, entry);
  }
  const skills = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of skills) s.providedBy.sort();
  ctx.emit({ skills }, () =>
    skills
      .map((s) => `${s.name} ${s.version} — ${s.description} [${s.providedBy.join(", ")}]`)
      .join("\n"),
  );
  return 0;
}

export async function skillsResolve(
  ctx: CommandContext,
  options: { task: string; budget?: string },
): Promise<number> {
  const task = await loadTask(ctx, options.task);
  const budget = parseBudget(options.budget);
  const config = await requireConfig(ctx);
  const registry = await openRegistry(ctx, config);
  const set = resolveConfigured(registry, config);
  const repoSignals = await inspectRepo(ctx.cwd);
  const result = await resolveSkills({
    task,
    harnesses: set,
    repoSignals,
    ...(budget !== undefined ? { budgetTokens: budget } : {}),
  });
  ctx.emit(
    {
      task: task.id,
      harnesses: set.harnesses.map(
        (h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version}`,
      ),
      ...result,
    },
    () =>
      [
        `Skills for ${task.id} (${result.budget.used} estimated tokens${result.budget.limit !== null ? ` of ${result.budget.limit}` : ""}):`,
        ...result.skills.map((s) => `  ✓ ${s.name}@${s.version} — ${s.reason}`),
        ...result.rationale.map((r) => `  not selected: ${r.name} — ${r.reason}`),
        ...result.warnings.map((w) => `warning: ${w}`),
      ].join("\n"),
  );
  return 0;
}
