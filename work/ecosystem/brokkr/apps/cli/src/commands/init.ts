import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrokkrError } from "@brokkr/core";
import { CONFIG_FILE, saveProjectConfig } from "@brokkr/registry";
import { inspectRepo, recommendHarnesses } from "@brokkr/resolver";
import type { CommandContext } from "../io.js";
import { adapterRefs, openRegistry, resolveConfigured } from "./shared.js";

const NEXT = "brokkr prepare --provider claude-code --task task.json";

export async function initCommand(
  ctx: CommandContext,
  options: { yes?: boolean },
): Promise<number> {
  if (existsSync(join(ctx.cwd, CONFIG_FILE))) {
    throw new BrokkrError(
      "invalid-config",
      `${CONFIG_FILE} already exists; use \`brokkr harness add\` to change it`,
    );
  }
  const signals = await inspectRepo(ctx.cwd);
  const registry = await openRegistry(ctx, { version: 1, harnesses: [] });
  const trusted = registry.list().filter((h) => h.trust === "trusted");
  const recs = recommendHarnesses(
    trusted.map((h) => h.manifest),
    signals,
  ).map((rec) => {
    const manifest = registry.inspect(rec.name, rec.version)!.manifest;
    return {
      ...rec,
      requiredChecks: manifest.checks.filter((c) => c.required).map((c) => c.id),
      requiredSkills: manifest.skills.required,
      policies: manifest.policies,
    };
  });

  const explain = (): string => {
    const lines = [
      `Detected: ${signals.frameworks.join(", ") || "no known frameworks"}` +
        `${signals.packageManager ? ` (package manager: ${signals.packageManager})` : ""}`,
    ];
    if (recs.length === 0)
      return [...lines, "No built-in harness matches this repository; nothing written."].join("\n");
    lines.push("", "Recommended harnesses:");
    for (const r of recs) {
      lines.push(
        `  ${r.name}@${r.version} — ${r.description}`,
        `    Why: ${r.reason}`,
        `    Required checks: ${r.requiredChecks.join(", ") || "(none)"}`,
        `    Required skills: ${r.requiredSkills.join(", ") || "(none)"}`,
        `    Policies: network ${r.policies.network}, destructive commands ${r.policies.destructiveCommands}`,
      );
    }
    return lines.join("\n");
  };

  if (recs.length === 0) {
    ctx.emit({ signals, recommended: [], written: [] }, explain);
    return 0;
  }
  if (!ctx.json) ctx.io.stdout(`${explain()}\n\n`);
  if (!options.yes) {
    const approved = await ctx.confirm(
      `Write .brokkr/config.yaml and .brokkr/harness.lock.json with ${recs.map((r) => r.name).join(", ")}? These harnesses define checks Brokkr will run.`,
    );
    if (!approved) {
      throw new BrokkrError(
        "policy-denied",
        "configuration not approved; nothing written (re-run with --yes to approve non-interactively)",
      );
    }
  }

  const config = {
    version: 1 as const,
    harnesses: recs.map((r) => ({ name: r.name, version: `^${r.version}` })),
  };
  const configPath = await saveProjectConfig(ctx.cwd, config);
  const set = resolveConfigured(registry, config);
  const { path: lockPath } = await registry.writeLock(set, adapterRefs());
  ctx.emit({ signals, recommended: recs, configPath, lockPath, next: NEXT }, () =>
    [`Wrote ${configPath}`, `Wrote ${lockPath}`, "", `Next: ${NEXT}`].join("\n"),
  );
  return 0;
}
