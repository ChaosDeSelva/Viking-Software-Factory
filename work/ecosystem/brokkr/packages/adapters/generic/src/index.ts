import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BrokkrError,
  BundleWriter,
  CheckDefinitionSchema,
  PoliciesSchema,
  TaskDescriptorSchema,
  bundleDir,
  readContainedFile,
  cleanupBundle,
  renderExecutionContract,
  renderTaskBrief,
  type AdapterContext,
  type CompatibilityResult,
  type PreparedContext,
  type ProviderAdapter,
  type ResolvedSkill,
} from "@brokkr/core";

export const GENERIC_ADAPTER_ID = "generic";
export const GENERIC_ADAPTER_VERSION = "0.1.0";

/** Schema of the machine-readable `manifest.json` written by the generic adapter. */
export const GenericManifestSchema = z.object({
  schemaVersion: z.literal(1),
  adapter: z.object({ id: z.string(), version: z.string() }),
  task: TaskDescriptorSchema,
  harnesses: z.array(z.object({ name: z.string(), version: z.string() })),
  skills: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      description: z.string(),
      reason: z.string(),
      requiredBy: z.string().optional(),
      score: z.number(),
    }),
  ),
  checks: z.array(CheckDefinitionSchema.extend({ from: z.array(z.string()) })),
  policies: PoliciesSchema,
  workflow: z.object({ stages: z.array(z.string()) }),
  executionAllowed: z.boolean(),
});
export type GenericManifest = z.infer<typeof GenericManifestSchema>;

/** Generic adapter: one Markdown file with everything inlined plus a JSON manifest. Always isolated. */
export function createGenericAdapter(): ProviderAdapter {
  const rootFor = (ctx: AdapterContext): string => bundleDir(ctx.cwd, ctx.task.id, "generic");
  const cleanup = async (ctx: AdapterContext): Promise<void> => {
    await cleanupBundle(rootFor(ctx), ctx.cwd);
  };

  return {
    id: GENERIC_ADAPTER_ID,
    version: GENERIC_ADAPTER_VERSION,

    async validateEnvironment(ctx: AdapterContext): Promise<CompatibilityResult> {
      const issues: string[] = [];
      if (!existsSync(ctx.cwd) || !statSync(ctx.cwd).isDirectory())
        issues.push(`working directory ${ctx.cwd} does not exist`);
      const warnings = ctx.modifyProjectInstructions
        ? ["generic output is always isolated; modifyProjectInstructions is ignored"]
        : [];
      return { compatible: issues.length === 0, issues, warnings };
    },

    async prepare(skills: ResolvedSkill[], ctx: AdapterContext): Promise<PreparedContext> {
      const root = rootFor(ctx);
      await cleanup(ctx);
      const writer = new BundleWriter({
        cwd: ctx.cwd,
        rootDir: root,
        adapterId: GENERIC_ADAPTER_ID,
        adapterVersion: GENERIC_ADAPTER_VERSION,
      });
      const sections: string[] = [];
      const manifestSkills: GenericManifest["skills"] = [];
      for (const resolved of skills) {
        const skill = ctx.skillCatalog[resolved.name];
        if (!skill)
          throw new BrokkrError(
            "not-found",
            `skill '${resolved.name}' is not in the skill catalog`,
          );
        const body = await readContainedFile(skill.dir, skill.manifest.body);
        sections.push(
          `## Skill: ${resolved.name} (${resolved.version})`,
          "",
          `_Why: ${resolved.reason}_`,
          "",
          body.trimEnd(),
          "",
        );
        manifestSkills.push({
          name: resolved.name,
          version: resolved.version,
          description: skill.manifest.metadata.description,
          reason: resolved.reason,
          ...(resolved.requiredBy ? { requiredBy: resolved.requiredBy } : {}),
          score: resolved.score,
        });
      }
      const entrypoint = join(root, "INSTRUCTIONS.md");
      await writer.writeFile(
        entrypoint,
        [renderTaskBrief(ctx.task), renderExecutionContract(ctx.composed), ...sections]
          .join("\n")
          .trimEnd() + "\n",
      );
      const manifest: GenericManifest = {
        schemaVersion: 1,
        adapter: { id: GENERIC_ADAPTER_ID, version: GENERIC_ADAPTER_VERSION },
        task: ctx.task,
        harnesses: ctx.composed.harnesses,
        skills: manifestSkills,
        checks: ctx.composed.checks,
        policies: ctx.composed.policies,
        workflow: ctx.composed.workflow,
        executionAllowed: ctx.composed.executionAllowed,
      };
      await writer.writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      return writer.commit(entrypoint);
    },

    cleanup,
  };
}
