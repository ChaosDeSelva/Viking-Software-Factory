import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BrokkrError,
  TaskDescriptorSchema,
  createLogger,
  formatIssues,
  parseManifestText,
  type Logger,
  type ProjectConfig,
  type ProviderAdapter,
  type ResolvedHarnessSet,
  type TaskDescriptor,
} from "@brokkr/core";
import { Registry, loadProjectConfig, type AdapterRef } from "@brokkr/registry";
import { createClaudeCodeAdapter } from "@brokkr/adapter-claude-code";
import { createCodexAdapter } from "@brokkr/adapter-codex";
import { createGenericAdapter } from "@brokkr/adapter-generic";
import type { CommandContext } from "../io.js";

export const ADAPTER_FACTORIES: Record<string, () => ProviderAdapter> = {
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
  generic: createGenericAdapter,
};

export function adapterRefs(): AdapterRef[] {
  return Object.values(ADAPTER_FACTORIES).map((f) => {
    const a = f();
    return { id: a.id, version: a.version };
  });
}

export function logger(ctx: CommandContext): Logger {
  const level = (ctx.io.env.BROKKR_LOG_LEVEL ?? "warn") as "warn";
  return createLogger({ level });
}

export async function openRegistry(ctx: CommandContext, config?: ProjectConfig): Promise<Registry> {
  const registry = new Registry({
    cwd: ctx.cwd,
    builtinDir: ctx.builtinDir,
    homeDir: ctx.homeDir,
    ...(config ? { config } : {}),
  });
  await registry.load();
  const log = logger(ctx);
  for (const d of registry.diagnostics) log.warn({ diagnostic: d }, "registry diagnostic");
  return registry;
}

export async function requireConfig(ctx: CommandContext): Promise<ProjectConfig> {
  const config = await loadProjectConfig(ctx.cwd);
  if (!config) {
    throw new BrokkrError(
      "invalid-config",
      "no .brokkr/config.yaml found; run `brokkr init` or `brokkr harness add <name>` first",
    );
  }
  return config;
}

export function resolveConfigured(
  registry: Registry,
  config: ProjectConfig,
  options: { allowUntrusted?: boolean } = {},
): ResolvedHarnessSet {
  return registry.resolve({
    harnesses: config.harnesses.map((h) => ({ name: h.name, range: h.version })),
    ...(options.allowUntrusted ? { allowUntrusted: true } : {}),
  });
}

export async function loadTask(ctx: CommandContext, file: string): Promise<TaskDescriptor> {
  const path = resolve(ctx.cwd, file);
  if (!existsSync(path))
    throw new BrokkrError("invalid-config", `task file ${file} does not exist`);
  const parsed = parseManifestText(await readFile(path, "utf8"), TaskDescriptorSchema, file);
  if (!parsed.ok)
    throw new BrokkrError("invalid-config", `invalid task file:\n${formatIssues(parsed.issues)}`, {
      details: { issues: parsed.issues },
    });
  return parsed.value;
}

export function parseBudget(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new BrokkrError(
      "invalid-config",
      `--budget must be a non-negative integer, got '${String(value)}'`,
    );
  return n;
}
