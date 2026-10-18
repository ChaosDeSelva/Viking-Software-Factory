import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  HarnessManifestSchema,
  RoleSchema,
  SkillManifestSchema,
  TEMPLATE_PLACEHOLDERS,
  parseManifestText,
  treeDigest,
  checkContainedFile,
  type HarnessManifest,
  type LoadedSkill,
  type SkillManifest,
  type ValidationIssue,
} from "@brokkr/core";

export const HARNESS_MANIFEST_FILES = ["harness.yaml", "harness.yml", "harness.json"] as const;
export const SKILL_MANIFEST_FILES = ["skill.yaml", "skill.yml", "skill.json"] as const;

export interface HarnessValidation {
  valid: boolean;
  dir: string;
  issues: ValidationIssue[];
  warnings: string[];
  manifest?: HarnessManifest;
}

export interface HarnessPackage {
  manifest: HarnessManifest;
  dir: string;
  digest: string;
  skills: LoadedSkill[];
}

function findManifest(dir: string, names: readonly string[]): string | undefined {
  return names.find((n) => existsSync(join(dir, n)));
}

export function hasHarnessManifest(dir: string): boolean {
  return findManifest(dir, HARNESS_MANIFEST_FILES) !== undefined;
}

/**
 * Validate a harness package directory: manifest schema (argv-array commands,
 * safe relative paths), every referenced skill exists with a valid manifest
 * whose name matches its directory, every body file exists, and skill
 * dependencies are shipped by the same package. Never throws.
 */
export async function validateHarnessDir(
  dir: string,
): Promise<HarnessValidation & { pkg?: HarnessPackage }> {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const manifestFile = findManifest(dir, HARNESS_MANIFEST_FILES);
  if (manifestFile === undefined) {
    issues.push({
      path: "",
      message: `no harness manifest found (expected one of ${HARNESS_MANIFEST_FILES.join(", ")})`,
    });
    return { valid: false, dir, issues, warnings };
  }
  const manifestText = await readFile(join(dir, manifestFile), "utf8");
  const parsed = parseManifestText(manifestText, HarnessManifestSchema, manifestFile);
  // Keep going on an invalid harness manifest so skill problems are reported in the same pass.
  if (!parsed.ok) issues.push(...parsed.issues);
  const manifest = parsed.ok ? parsed.value : undefined;
  const providedBy = manifest
    ? `${manifest.metadata.name}@${manifest.metadata.version}`
    : "invalid";

  const skillsRoot = join(dir, "skills");
  const shipped = existsSync(skillsRoot)
    ? (await readdir(skillsRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const shippedSet = new Set(shipped);
  const skills: LoadedSkill[] = [];
  const skillManifests = new Map<string, SkillManifest>();

  for (const name of shipped.sort()) {
    const sdir = join(skillsRoot, name);
    const sfile = findManifest(sdir, SKILL_MANIFEST_FILES);
    const rel = posix.join("skills", name, sfile ?? "skill.yaml");
    if (sfile === undefined) {
      issues.push({ path: "", file: rel, message: "skill manifest missing" });
      continue;
    }
    const sp = parseManifestText(
      await readFile(join(sdir, sfile), "utf8"),
      SkillManifestSchema,
      rel,
    );
    if (!sp.ok) {
      issues.push(...sp.issues);
      continue;
    }
    const skill = sp.value;
    if (skill.metadata.name !== name) {
      issues.push({
        path: "metadata.name",
        file: rel,
        message: `skill name '${skill.metadata.name}' must match its directory '${name}'`,
      });
      continue;
    }
    const bodyPath = join(sdir, ...skill.body.split("/"));
    // lstat + realpath: the body must be a regular file physically inside the skill directory.
    const bodyProblem = checkContainedFile(sdir, skill.body);
    if (bodyProblem) {
      issues.push({ path: "body", file: rel, message: `body file ${bodyProblem}` });
      continue;
    }
    skillManifests.set(name, skill);
    skills.push({ manifest: skill, dir: sdir, bodyPath, digest: "", providedBy });
  }

  const referenced = new Set<string>();
  const declared = manifest?.skills ?? looseSkillLists(manifestText, manifestFile);
  for (const group of ["required", "optional"] as const) {
    declared[group].forEach((name, index) => {
      referenced.add(name);
      if (!shippedSet.has(name)) {
        issues.push({
          path: `skills.${group}.${index}`,
          file: manifestFile,
          message: `skill '${name}' is not shipped in skills/${name}/`,
        });
      }
    });
  }
  for (const [name, skill] of skillManifests) {
    (skill.dependsOn ?? []).forEach((dep, index) => {
      if (!skillManifests.has(dep)) {
        issues.push({
          path: `dependsOn.${index}`,
          file: posix.join("skills", name, "skill.yaml"),
          message: `skill dependency '${dep}' is not shipped by this harness package`,
        });
      }
    });
    if (manifest && !referenced.has(name) && !isDependedOn(name, skillManifests)) {
      warnings.push(`skill '${name}' is shipped but not referenced by the harness`);
    }
  }

  issues.push(...(await validateRoles(dir, shippedSet)));
  issues.push(...(await validateTemplates(dir)));

  let digest = "";
  try {
    digest = await treeDigest(dir);
    for (const skill of skills) skill.digest = await treeDigest(skill.dir);
  } catch (error) {
    issues.push({ path: "", message: (error as Error).message });
  }

  if (issues.length > 0 || !manifest)
    return { valid: false, dir, issues, warnings, ...(manifest ? { manifest } : {}) };
  return {
    valid: true,
    dir,
    issues,
    warnings,
    manifest,
    pkg: { manifest, dir, digest, skills },
  };
}

/**
 * Placeholders in a brief template must be one of TEMPLATE_PLACEHOLDERS.
 * `{{harnessDir}}` is tolerated only inside inline code, where templates
 * document check commands verbatim.
 */
export function templatePlaceholderIssues(text: string): string[] {
  const codeSpans = [...text.matchAll(/`[^`\n]*`/g)].map((m) => [m.index, m.index + m[0].length]);
  const inCode = (i: number): boolean => codeSpans.some(([a, b]) => i > a! && i < b!);
  const issues: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const name = m[1] ?? "";
    if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) continue;
    if (name === "harnessDir" && inCode(m.index)) continue;
    issues.push(`unknown placeholder {{${name}}}`);
  }
  return issues;
}

async function validateRoles(
  dir: string,
  shipped: ReadonlySet<string>,
): Promise<ValidationIssue[]> {
  const root = join(dir, "roles");
  if (!existsSync(root)) return [];
  const issues: ValidationIssue[] = [];
  const files = (await readdir(root)).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
  for (const f of files) {
    const rel = posix.join("roles", f);
    const parsed = parseManifestText(await readFile(join(root, f), "utf8"), RoleSchema, rel);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      continue;
    }
    parsed.value.skills.forEach((skill, index) => {
      if (!shipped.has(skill))
        issues.push({
          path: `skills.${index}`,
          file: rel,
          message: `role skill '${skill}' is not shipped in skills/${skill}/`,
        });
    });
  }
  return issues;
}

async function validateTemplates(dir: string): Promise<ValidationIssue[]> {
  const root = join(dir, "templates");
  if (!existsSync(root)) return [];
  const issues: ValidationIssue[] = [];
  for (const f of (await readdir(root)).filter((x) => x.endsWith(".md")).sort()) {
    const rel = posix.join("templates", f);
    for (const message of templatePlaceholderIssues(await readFile(join(root, f), "utf8")))
      issues.push({ path: "", file: rel, message });
  }
  return issues;
}

/** Best-effort skill lists from a manifest that failed schema validation, so reference errors still surface. */
function looseSkillLists(text: string, file: string): { required: string[]; optional: string[] } {
  const out = { required: [] as string[], optional: [] as string[] };
  try {
    const raw = (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as {
      skills?: Record<string, unknown>;
    };
    for (const group of ["required", "optional"] as const) {
      const list = raw?.skills?.[group];
      if (Array.isArray(list) && list.every((x) => typeof x === "string"))
        out[group] = list as string[];
    }
  } catch {
    // Syntax errors are already reported by parseManifestText.
  }
  return out;
}

function isDependedOn(name: string, skills: Map<string, SkillManifest>): boolean {
  for (const s of skills.values()) if (s.dependsOn?.includes(name)) return true;
  return false;
}

/** Find harness package directories under a source root (root itself, children, or grandchildren). */
export async function discoverHarnessDirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (hasHarnessManifest(root)) return [root];
  const out: string[] = [];
  for (const child of await subdirs(root)) {
    if (hasHarnessManifest(child)) out.push(child);
    else
      for (const grandchild of await subdirs(child))
        if (hasHarnessManifest(grandchild)) out.push(grandchild);
  }
  return out.sort();
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(dir, e.name))
    .sort();
}
