import { existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  BrokkrError,
  BundleWriter,
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

export const CODEX_ADAPTER_ID = "codex";
export const CODEX_ADAPTER_VERSION = "0.1.0";

/**
 * Codex adapter: Codex reads plain-Markdown `AGENTS.md` instruction files.
 * The bundle holds an `AGENTS.md` (task brief, execution contract, skill
 * index) and one `instructions/<skill>.md` per selected skill.
 */
export function createCodexAdapter(): ProviderAdapter {
  const rootFor = (ctx: AdapterContext): string => bundleDir(ctx.cwd, ctx.task.id, "codex");
  const cleanup = async (ctx: AdapterContext): Promise<void> => {
    await cleanupBundle(rootFor(ctx), ctx.cwd, {
      allowProjectFiles: ctx.modifyProjectInstructions === true,
      isProjectFile: (rel) => rel === "AGENTS.md",
    });
  };

  return {
    id: CODEX_ADAPTER_ID,
    version: CODEX_ADAPTER_VERSION,

    async validateEnvironment(ctx: AdapterContext): Promise<CompatibilityResult> {
      const issues: string[] = [];
      if (!existsSync(ctx.cwd) || !statSync(ctx.cwd).isDirectory())
        issues.push(`working directory ${ctx.cwd} does not exist`);
      for (const name of ctx.composed.skills.required) {
        if (!ctx.skillCatalog[name])
          issues.push(`required skill '${name}' is missing from the skill catalog`);
      }
      const warnings = ctx.modifyProjectInstructions
        ? []
        : [
            "bundle is isolated: start Codex in the bundle directory or point it at the generated AGENTS.md",
          ];
      return { compatible: issues.length === 0, issues, warnings };
    },

    async prepare(skills: ResolvedSkill[], ctx: AdapterContext): Promise<PreparedContext> {
      const root = rootFor(ctx);
      await cleanup(ctx);
      const projectMode = ctx.modifyProjectInstructions === true;
      const writer = new BundleWriter({
        cwd: ctx.cwd,
        rootDir: root,
        adapterId: CODEX_ADAPTER_ID,
        adapterVersion: CODEX_ADAPTER_VERSION,
      });
      const entrypoint = projectMode ? join(ctx.cwd, "AGENTS.md") : join(root, "AGENTS.md");
      const linkBase = projectMode ? ctx.cwd : root;

      const index: string[] = [];
      for (const resolved of skills) {
        const skill = ctx.skillCatalog[resolved.name];
        if (!skill)
          throw new BrokkrError(
            "not-found",
            `skill '${resolved.name}' is not in the skill catalog`,
          );
        const body = await readContainedFile(skill.dir, skill.manifest.body);
        const file = join(root, "instructions", `${resolved.name}.md`);
        await writer.writeFile(
          file,
          `<!-- skill: ${resolved.name}@${resolved.version} -->\n${body.trimEnd()}\n`,
        );
        const link = relative(linkBase, file).split(sep).join("/");
        index.push(
          `- [${resolved.name}](${link}) ${resolved.version}: ${skill.manifest.metadata.description} (${resolved.reason})`,
        );
      }

      const text = [
        renderTaskBrief(ctx.task),
        renderExecutionContract(ctx.composed),
        "## Skills",
        "",
        "Read the linked instruction file for each skill before working in its area.",
        "",
        ...(index.length ? index : ["(none)"]),
        "",
      ].join("\n");
      if (projectMode) await writer.upsertBlock(entrypoint, text.trimEnd());
      else await writer.writeFile(entrypoint, text);
      return writer.commit(entrypoint);
    },

    cleanup,
  };
}
