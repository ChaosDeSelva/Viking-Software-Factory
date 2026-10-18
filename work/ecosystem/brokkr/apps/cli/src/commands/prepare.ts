import { BrokkrError, type AdapterContext } from "@brokkr/core";
import { inspectRepo, resolveSkills } from "@brokkr/resolver";
import type { CommandContext } from "../io.js";
import {
  ADAPTER_FACTORIES,
  loadTask,
  openRegistry,
  parseBudget,
  requireConfig,
  resolveConfigured,
} from "./shared.js";

interface PrepareOptions {
  provider: string;
  task: string;
  budget?: string;
  modifyProjectInstructions?: boolean;
  cleanup?: boolean;
}

export async function prepareCommand(
  ctx: CommandContext,
  options: PrepareOptions,
): Promise<number> {
  const factory = ADAPTER_FACTORIES[options.provider];
  if (!factory) {
    throw new BrokkrError(
      "invalid-config",
      `unknown provider '${options.provider}'; expected one of ${Object.keys(ADAPTER_FACTORIES).join(", ")}`,
    );
  }
  const adapter = factory();
  const task = await loadTask(ctx, options.task);
  const budget = parseBudget(options.budget);
  const config = await requireConfig(ctx);
  const registry = await openRegistry(ctx, config);
  // Resolve permissively so the refusal below is explicit and names the source.
  const set = resolveConfigured(registry, config, { allowUntrusted: true });
  const untrusted = set.harnesses.filter((h) => h.trust !== "trusted" || !h.executionAllowed);
  if (untrusted.length > 0) {
    throw new BrokkrError(
      "trust_required",
      `refusing to prepare instructions: ${untrusted
        .map((h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version} (${h.sourceRef})`)
        .join(
          ", ",
        )} ${untrusted.length === 1 ? "comes" : "come"} from an untrusted source; run \`brokkr trust add <source> --digest <sha256>\` after reviewing it`,
      { details: { harnesses: untrusted.map((h) => h.sourceRef) } },
    );
  }
  const adapterCtx: AdapterContext = {
    cwd: ctx.cwd,
    task,
    composed: registry.compose(set),
    skillCatalog: set.skills,
    modifyProjectInstructions: options.modifyProjectInstructions === true,
  };

  if (options.cleanup) {
    await adapter.cleanup(adapterCtx);
    ctx.emit(
      { provider: adapter.id, task: task.id, cleaned: true },
      `Removed ${adapter.id} bundle for ${task.id}`,
    );
    return 0;
  }

  const env = await adapter.validateEnvironment(adapterCtx);
  if (!env.compatible)
    throw new BrokkrError(
      "invalid-config",
      `${adapter.id} cannot prepare this task: ${env.issues.join("; ")}`,
    );
  const resolution = await resolveSkills({
    task,
    harnesses: set,
    repoSignals: await inspectRepo(ctx.cwd),
    ...(budget !== undefined ? { budgetTokens: budget } : {}),
  });
  const prepared = await adapter.prepare(resolution.skills, adapterCtx);
  ctx.emit(
    {
      ...prepared,
      skills: resolution.skills,
      rationale: resolution.rationale,
      warnings: [...env.warnings, ...resolution.warnings],
    },
    () =>
      [
        `Prepared ${adapter.id} context for ${task.id}:`,
        ...prepared.files.map((f) => `  ${f.relativePath}`),
        "",
        `Entry point: ${prepared.entrypoint}`,
        ...env.warnings.map((w) => `note: ${w}`),
      ].join("\n"),
  );
  return 0;
}
