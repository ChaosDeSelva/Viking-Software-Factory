import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fitGuidance,
  GUIDANCE_CAP_BYTES,
  MAX_PROJECT_NOTES_BYTES,
  MAX_REQUEST_NOTES_BYTES,
  MAX_SKILL_BYTES,
  utf8Capped,
  openGuidance,
  renderGuidance,
  sha256Text,
  skillFrontmatter,
  type Guidance,
  type GuidanceSkill,
} from "./guidance.js";
import { openKnowledge, type Knowledge } from "./knowledge.js";

let dir: string;
let k: Knowledge;
let g: Guidance;

const skillDir = (name: string, text: string, parent = dir) => {
  const d = join(parent, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), text);
  return d;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sindri-skills-"));
  k = openKnowledge(":memory:");
  g = openGuidance(k.db);
});
afterEach(() => {
  k.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("skill import", () => {
  it("imports one SKILL.md folder with its frontmatter and digest, and upserts on re-import", () => {
    const text = "---\nname: careful-review\ndescription: 'Review carefully'\n---\nBe careful.\n";
    const d = skillDir("x", text);
    const first = g.importPath(d);
    expect(first.skipped).toEqual([]);
    expect(first.imported).toHaveLength(1);
    const s = first.imported[0]!;
    expect(s).toMatchObject({
      name: "careful-review",
      description: "Review carefully",
      sourcePath: join(realpathSync(d), "SKILL.md"),
      content: text,
      digest: sha256Text(text),
    });
    const again = g.importPath(d).imported[0]!;
    expect(again.id).toBe(s.id);
    expect(g.list()).toHaveLength(1);
  });

  it("names a skill after its folder when the frontmatter has no name", () => {
    const d = skillDir("plain-skill", "No frontmatter here.\n");
    expect(g.importPath(d).imported[0]!.name).toBe("plain-skill");
  });

  it("imports every child folder with a SKILL.md when given a parent folder", () => {
    skillDir("a", "A\n");
    skillDir("b", "B\n");
    mkdirSync(join(dir, "empty"));
    const r = g.importPath(dir);
    expect(r.imported.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("refuses a SKILL.md symlink that points outside the folder", () => {
    const outside = mkdtempSync(join(tmpdir(), "sindri-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "outside secret\n");
      const d = join(dir, "evil");
      mkdirSync(d);
      symlinkSync(join(outside, "secret.md"), join(d, "SKILL.md"));
      const r = g.importPath(d);
      expect(r.imported).toEqual([]);
      expect(r.skipped).toEqual([{ path: join(d, "SKILL.md"), reason: "symlink_escapes" }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stores the real path, so a folder reached through a symlinked parent is one skill", () => {
    const real = skillDir("one", "One\n");
    const linkedParent = join(dir, "..", `${dir.split("/").pop()}-link`);
    symlinkSync(dir, linkedParent);
    try {
      const a = g.importPath(real).imported[0]!;
      const b = g.importPath(join(linkedParent, "one")).imported[0]!;
      expect(b.id).toBe(a.id);
      expect(g.list()).toHaveLength(1);
      expect(g.listing(a.id)).toMatchObject({ changedOnDisk: false, missingOnDisk: false });
      expect(g.listing("skl_nope")).toBeUndefined();
    } finally {
      rmSync(linkedParent, { force: true });
    }
  });

  it("refuses a child folder symlink that escapes the parent", () => {
    const outside = mkdtempSync(join(tmpdir(), "sindri-outside-"));
    try {
      skillDir("real", "R\n");
      skillDir("away", "outside\n", outside);
      symlinkSync(join(outside, "away"), join(dir, "linked"));
      const r = g.importPath(dir);
      expect(r.imported.map((s) => s.name)).toEqual(["real"]);
      expect(r.skipped).toEqual([
        { path: join(dir, "linked", "SKILL.md"), reason: "symlink_escapes" },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a SKILL.md over the size cap instead of cutting it", () => {
    const d = skillDir("big", "x".repeat(MAX_SKILL_BYTES + 1));
    const r = g.importPath(d);
    expect(r.imported).toEqual([]);
    expect(r.skipped[0]!.reason).toBe("too_large");
  });

  it("rejects relative paths and folders without any SKILL.md", () => {
    expect(() => g.importPath("relative/path")).toThrow(/absolute/);
    mkdirSync(join(dir, "nothing"));
    expect(() => g.importPath(join(dir, "nothing"))).toThrow(/no SKILL.md/);
  });

  it("reports changedOnDisk and missingOnDisk, and re-import picks up the change", () => {
    const d = skillDir("s", "v1\n");
    const s = g.importPath(d).imported[0]!;
    expect(g.list()[0]).toMatchObject({ changedOnDisk: false, missingOnDisk: false, bytes: 3 });
    writeFileSync(join(d, "SKILL.md"), "v2\n");
    expect(g.list()[0]).toMatchObject({ changedOnDisk: true, missingOnDisk: false });
    const re = g.reimport(s.id);
    expect(re).toMatchObject({ id: s.id, content: "v2\n", digest: sha256Text("v2\n") });
    expect(g.list()[0]!.changedOnDisk).toBe(false);
    rmSync(join(d, "SKILL.md"));
    expect(g.list()[0]).toMatchObject({ changedOnDisk: true, missingOnDisk: true });
  });

  it("delete removes the skill from project defaults", () => {
    const p = k.projects.create({ name: "p", repoPath: dir });
    const s = g.importPath(skillDir("s", "S\n")).imported[0]!;
    g.setProjectGuidance(p.id, { notes: "n", defaultSkillIds: [s.id] });
    g.delete(s.id);
    expect(g.projectGuidance(p.id).defaultSkillIds).toEqual([]);
    expect(() => g.delete(s.id)).toThrow(/not found/);
  });
});

describe("project guidance", () => {
  it("defaults to empty, validates skill ids and stores notes", () => {
    const p = k.projects.create({ name: "p", repoPath: dir });
    expect(g.projectGuidance(p.id)).toEqual({
      projectId: p.id,
      notes: "",
      defaultSkillIds: [],
      updatedAt: null,
    });
    expect(() => g.setProjectGuidance(p.id, { notes: "", defaultSkillIds: ["skl_x"] })).toThrow(
      /unknown skill/,
    );
    expect(() => g.setProjectGuidance("nope", { notes: "", defaultSkillIds: [] })).toThrow(
      /not found/,
    );
    const s = g.importPath(skillDir("s", "S\n")).imported[0]!;
    const set = g.setProjectGuidance(p.id, { notes: "be terse", defaultSkillIds: [s.id, s.id] });
    expect(set.defaultSkillIds).toEqual([s.id]);
    expect(set.notes).toBe("be terse");
  });

  it("snapshot merges project defaults with request skills, deduplicated", () => {
    const p = k.projects.create({ name: "p", repoPath: dir });
    const a = g.importPath(skillDir("a", "A\n")).imported[0]!;
    const b = g.importPath(skillDir("b", "B\n")).imported[0]!;
    g.setProjectGuidance(p.id, { notes: "proj", defaultSkillIds: [a.id] });
    const snap = g.snapshot(p.id, { skillIds: [b.id, a.id, "skl_gone"], notes: "req" });
    expect(snap.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(snap.projectNotesDigest).toBe(sha256Text("proj"));
    expect(snap.requestNotesDigest).toBe(sha256Text("req"));
  });
});

describe("guidance rendering", () => {
  const skill = (name: string, size: number): GuidanceSkill => {
    const content = "y".repeat(size);
    return { id: `skl_${name}`, name, digest: sha256Text(content), content };
  };

  it("renders skills, then project notes, then request notes", () => {
    const s = skill("one", 10);
    const text = renderGuidance(fitGuidance({ skills: [s], projectNotes: "P", requestNotes: "R" }));
    expect(text).toContain(`### Skill: one (sha256 ${s.digest.slice(0, 12)})`);
    expect(text.indexOf("### Skill: one")).toBeLessThan(text.indexOf("### Project notes"));
    expect(text.indexOf("### Project notes")).toBeLessThan(text.indexOf("### Request notes"));
  });

  it("is empty without guidance", () => {
    expect(renderGuidance(fitGuidance({ skills: [] }))).toBe("");
  });

  it("lists skills that do not fit as omitted and never cuts one", () => {
    const skills = [skill("a", 20_000), skill("b", 30_000), skill("c", 10_000)];
    const snap = fitGuidance({ skills, projectNotes: "notes" });
    expect(snap.skills.map((s) => s.name)).toEqual(["a", "c"]);
    expect(snap.omitted.map((s) => s.name)).toEqual(["b"]);
    const text = renderGuidance(snap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(GUIDANCE_CAP_BYTES);
    expect(text).toContain("Omitted (size cap): b");
    expect(text).toContain("y".repeat(20_000));
    expect(text).not.toContain("y".repeat(30_000));
  });

  it("stays within the cap with 70 huge-named skills and notes at their caps", () => {
    const skills = Array.from({ length: 70 }, (_, i) => {
      const content = `${i}`.repeat(3000);
      return {
        id: `skl_${i}`,
        name: `${"n".repeat(400)}-${i}`,
        digest: sha256Text(content),
        content,
      };
    });
    const snap = fitGuidance({
      skills,
      projectNotes: "é".repeat(MAX_PROJECT_NOTES_BYTES / 2),
      requestNotes: "r".repeat(MAX_REQUEST_NOTES_BYTES),
    });
    const text = renderGuidance(snap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(GUIDANCE_CAP_BYTES);
    expect(snap.omitted.length).toBeGreaterThan(0);
    expect(snap.skills.length + snap.omitted.length).toBe(70);
    expect(text).toMatch(/and \d+ more$/);
    // A stored snapshot with oversized notes is still bounded when rendered.
    const huge = renderGuidance({ ...snap, projectNotes: "x".repeat(200_000) });
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(GUIDANCE_CAP_BYTES);
  });

  it("caps notes by UTF-8 bytes, not characters", () => {
    const schema = utf8Capped(4, "notes");
    expect(schema.safeParse("abcd").success).toBe(true);
    expect(schema.safeParse("éé").success).toBe(true);
    expect(schema.safeParse("ééa").success).toBe(false);
  });

  it("parses simple frontmatter", () => {
    expect(skillFrontmatter('---\nname: "x"\ndescription: d\nother: z\n---\nbody')).toEqual({
      name: "x",
      description: "d",
    });
    expect(skillFrontmatter("no frontmatter")).toEqual({});
  });
});
