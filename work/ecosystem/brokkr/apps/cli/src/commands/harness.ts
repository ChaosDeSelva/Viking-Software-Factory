import { BrokkrError, displayCommand, formatIssues } from "@brokkr/core";
import { readLock, saveProjectConfig, loadProjectConfig } from "@brokkr/registry";
import semver from "semver";
import type { CommandContext } from "../io.js";
import { adapterRefs, openRegistry, requireConfig, resolveConfigured } from "./shared.js";

export async function harnessList(ctx: CommandContext): Promise<number> {
  const registry = await openRegistry(ctx);
  const harnesses = registry.list().map((h) => ({
    name: h.manifest.metadata.name,
    version: h.manifest.metadata.version,
    description: h.manifest.metadata.description,
    source: h.source,
    sourceRef: h.sourceRef,
    trust: h.trust,
    digest: h.digest,
    dir: h.dir,
  }));
  ctx.emit({ harnesses, diagnostics: registry.diagnostics }, () => {
    if (harnesses.length === 0) return "No harnesses found.";
    const width = Math.max(...harnesses.map((h) => h.name.length));
    return harnesses
      .map(
        (h) =>
          `${h.name.padEnd(width)}  ${h.version.padEnd(8)}  ${h.source.padEnd(8)}  ${h.trust.padEnd(9)}  ${h.description}`,
      )
      .join("\n");
  });
  return 0;
}

export async function harnessInspect(
  ctx: CommandContext,
  name: string,
  options: { range: string },
): Promise<number> {
  const registry = await openRegistry(ctx);
  const h = registry.inspect(name, options.range);
  if (!h) throw new BrokkrError("not-found", `harness '${name}' (${options.range}) not found`);
  const skills = h.skills.map((s) => ({
    name: s.manifest.metadata.name,
    version: s.manifest.metadata.version,
    description: s.manifest.metadata.description,
    digest: s.digest,
  }));
  ctx.emit(
    {
      manifest: h.manifest,
      source: h.source,
      sourceRef: h.sourceRef,
      trust: h.trust,
      digest: h.digest,
      dir: h.dir,
      skills,
    },
    () => {
      const m = h.manifest;
      return [
        `${m.metadata.name}@${m.metadata.version} — ${m.metadata.description}`,
        `Source: ${h.sourceRef} (${h.trust})  Digest: ${h.digest}`,
        `Platforms: ${m.compatibility.platforms.join(", ")}  Task types: ${m.compatibility.taskTypes.join(", ")}`,
        `Required skills: ${m.skills.required.join(", ") || "(none)"}`,
        `Optional skills: ${m.skills.optional.join(", ") || "(none)"}`,
        `Workflow: ${m.workflow.stages.join(" → ")}`,
        "Checks:",
        ...m.checks.map(
          (c) =>
            `  ${c.id} (${c.required ? "required" : "optional"}): ${displayCommand(c.command)} [${c.timeoutSeconds}s]`,
        ),
        `Policies: network ${m.policies.network}, destructive commands ${m.policies.destructiveCommands}, approval for ${m.policies.requireApprovalFor.join(", ") || "(nothing)"}`,
      ].join("\n");
    },
  );
  return 0;
}

export async function harnessValidate(ctx: CommandContext, dir: string): Promise<number> {
  const registry = await openRegistry(ctx);
  const result = await registry.validate(dir);
  ctx.emit(result, () =>
    result.valid
      ? [
          `✓ ${result.manifest?.metadata.name}@${result.manifest?.metadata.version} is valid`,
          ...result.warnings.map((w) => `warning: ${w}`),
        ].join("\n")
      : `✗ ${result.dir} is invalid:\n${formatIssues(result.issues)}`,
  );
  return result.valid ? 0 : 2;
}

export async function harnessAdd(ctx: CommandContext, spec: string): Promise<number> {
  const at = spec.indexOf("@", 1);
  const name = at < 0 ? spec : spec.slice(0, at);
  const range = at < 0 ? undefined : spec.slice(at + 1);
  if (range !== undefined && semver.validRange(range) === null)
    throw new BrokkrError("invalid-config", `invalid range '${range}'`);
  const registry = await openRegistry(ctx);
  const found = registry.inspect(name, range ?? "*");
  if (!found)
    throw new BrokkrError("not-found", `harness '${spec}' not found in any registry source`);
  if (found.trust !== "trusted") {
    throw new BrokkrError(
      "policy-denied",
      `harness ${name}@${found.manifest.metadata.version} comes from untrusted source ${found.sourceRef}; review it and run \`brokkr trust add <source> --digest <sha256>\` first`,
    );
  }
  const config = (await loadProjectConfig(ctx.cwd)) ?? { version: 1 as const, harnesses: [] };
  const entry = { name, version: range ?? `^${found.manifest.metadata.version}` };
  const harnesses = [...config.harnesses.filter((h) => h.name !== name), entry];
  const next = { ...config, harnesses };
  const set = resolveConfigured(registry, next);
  await saveProjectConfig(ctx.cwd, next);
  const { path } = await registry.writeLock(set, adapterRefs());
  ctx.emit({ added: entry, lockPath: path }, `Added ${name}@${entry.version}; wrote ${path}`);
  return 0;
}

export async function harnessLock(
  ctx: CommandContext,
  options: { verify?: boolean },
): Promise<number> {
  const config = await requireConfig(ctx);
  const registry = await openRegistry(ctx, config);
  if (options.verify) {
    const lock = await readLock(ctx.cwd);
    if (!lock)
      throw new BrokkrError(
        "invalid-config",
        "no .brokkr/harness.lock.json; run `brokkr harness lock`",
      );
    const result = await registry.verifyLock(lock);
    ctx.emit(result, () =>
      result.ok
        ? "✓ lockfile matches harness contents"
        : [
            "✗ lockfile integrity check failed:",
            ...result.entries
              .filter((e) => e.status !== "ok")
              .map((e) => `  ${e.kind} ${e.name}${e.version ? `@${e.version}` : ""}: ${e.status}`),
          ].join("\n"),
    );
    return result.ok ? 0 : 1;
  }
  const { lock, path } = await registry.writeLock(
    resolveConfigured(registry, config),
    adapterRefs(),
  );
  ctx.emit(
    { lock, path },
    `Wrote ${path} (${lock.harnesses.length} harnesses, ${lock.skills.length} skills)`,
  );
  return 0;
}
