import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
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
  type LoadedSkill,
  type PreparedContext,
  type ProviderAdapter,
  type ResolvedSkill,
} from "@brokkr/core";

export const CLAUDE_CODE_ADAPTER_ID = "claude-code";
export const CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";
/** Description cap required by the Agent Skills format (Claude Code itself truncates listings at 1,536). */
export const MAX_DESCRIPTION_LENGTH = 1024;
const RESERVED_NAMES = /^(synced|anthropic-skills)$/i;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Problems that would stop Claude Code from loading a SKILL.md as intended. Empty when valid. */
export function validateSkillFrontmatter(fm: SkillFrontmatter, directoryName: string): string[] {
  const issues: string[] = [];
  if (!NAME_PATTERN.test(fm.name) || fm.name.length > 64) {
    issues.push(`name '${fm.name}' must be lowercase letters, digits and hyphens (max 64)`);
  }
  if (fm.name !== directoryName)
    issues.push(`name '${fm.name}' must match its directory '${directoryName}'`);
  if (RESERVED_NAMES.test(fm.name)) issues.push(`name '${fm.name}' is reserved by Claude Code`);
  if (fm.description.trim() === "") issues.push("description must not be empty");
  if (fm.description.length > MAX_DESCRIPTION_LENGTH)
    issues.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  if (/[<>]/.test(fm.description))
    issues.push("description must not contain XML tags or angle brackets");
  return issues;
}

function sanitizeDescription(text: string): string {
  const flat = text
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= MAX_DESCRIPTION_LENGTH
    ? flat
    : `${flat.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

/** Render a Claude Code SKILL.md: `---` YAML frontmatter (`name`, `description`) then the Markdown body. */
export function renderSkillMd(fm: SkillFrontmatter, body: string): string {
  const header = stringify(
    { name: fm.name, description: sanitizeDescription(fm.description) },
    { lineWidth: 0 },
  );
  return `---\n${header}---\n\n${body.trimEnd()}\n`;
}

function describe(skill: LoadedSkill, resolved: ResolvedSkill, taskId: string): string {
  const base = skill.manifest.metadata.description.replace(/\.?\s*$/, ".");
  return `${base} Selected by Brokkr for task ${taskId}: ${resolved.reason}.`;
}

export function createClaudeCodeAdapter(): ProviderAdapter {
  const rootFor = (ctx: AdapterContext): string => bundleDir(ctx.cwd, ctx.task.id, "claude");
  const cleanup = async (ctx: AdapterContext): Promise<void> => {
    await cleanupBundle(rootFor(ctx), ctx.cwd, {
      allowProjectFiles: ctx.modifyProjectInstructions === true,
      isProjectFile: (rel) =>
        rel === "CLAUDE.md" || /^\.claude\/skills\/[a-z0-9-]+\/SKILL\.md$/.test(rel),
    });
  };

  return {
    id: CLAUDE_CODE_ADAPTER_ID,
    version: CLAUDE_CODE_ADAPTER_VERSION,

    async validateEnvironment(ctx: AdapterContext): Promise<CompatibilityResult> {
      const issues: string[] = [];
      const warnings: string[] = [];
      if (!existsSync(ctx.cwd) || !statSync(ctx.cwd).isDirectory())
        issues.push(`working directory ${ctx.cwd} does not exist`);
      for (const name of ctx.composed.skills.required) {
        if (!ctx.skillCatalog[name])
          issues.push(`required skill '${name}' is missing from the skill catalog`);
      }
      if (!ctx.modifyProjectInstructions) {
        warnings.push(
          "bundle is isolated: start Claude Code in the bundle directory or pass it with --add-dir",
        );
      }
      return { compatible: issues.length === 0, issues, warnings };
    },

    async prepare(skills: ResolvedSkill[], ctx: AdapterContext): Promise<PreparedContext> {
      const root = rootFor(ctx);
      await cleanup(ctx);
      const projectMode = ctx.modifyProjectInstructions === true;
      const skillsBase = projectMode
        ? join(ctx.cwd, ".claude", "skills")
        : join(root, ".claude", "skills");
      const writer = new BundleWriter({
        cwd: ctx.cwd,
        rootDir: root,
        adapterId: CLAUDE_CODE_ADAPTER_ID,
        adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      });

      const listing: string[] = [];
      for (const resolved of skills) {
        const skill = ctx.skillCatalog[resolved.name];
        if (!skill)
          throw new BrokkrError(
            "not-found",
            `skill '${resolved.name}' is not in the skill catalog`,
          );
        const fm = { name: resolved.name, description: describe(skill, resolved, ctx.task.id) };
        const issues = validateSkillFrontmatter(
          { ...fm, description: sanitizeDescription(fm.description) },
          resolved.name,
        );
        if (issues.length > 0)
          throw new BrokkrError("invalid-config", `skill '${resolved.name}': ${issues.join("; ")}`);
        const body = await readContainedFile(skill.dir, skill.manifest.body);
        await writer.writeFile(
          join(skillsBase, resolved.name, "SKILL.md"),
          renderSkillMd(fm, body),
        );
        listing.push(
          `- \`${resolved.name}\` ${resolved.version} — ${resolved.reason} (\`.claude/skills/${resolved.name}/SKILL.md\`)`,
        );
      }

      const instructions = [
        renderTaskBrief(ctx.task),
        renderExecutionContract(ctx.composed),
        "## Skills",
        "",
        "Brokkr selected these skills for this task. Claude Code loads them from `.claude/skills/`; read each",
        "before working in its area.",
        "",
        ...(listing.length ? listing : ["(none)"]),
        "",
      ].join("\n");

      let entrypoint: string;
      if (projectMode) {
        entrypoint = join(ctx.cwd, "CLAUDE.md");
        await writer.upsertBlock(entrypoint, instructions.trimEnd());
      } else {
        entrypoint = join(root, "CLAUDE.md");
        await writer.writeFile(entrypoint, instructions);
      }
      return writer.commit(entrypoint);
    },

    cleanup,
  };
}
