import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { SqliteDatabase } from "./db.js";
import { SindriError } from "./errors.js";

/** Largest SKILL.md imported; a bigger file is refused, never cut. */
export const MAX_SKILL_BYTES = 64 * 1024;
/** Hard cap of the rendered "Operator guidance" block in an agent brief. */
export const GUIDANCE_CAP_BYTES = 48 * 1024;
/** Standing project notes and per-request notes, in UTF-8 bytes. */
export const MAX_PROJECT_NOTES_BYTES = 16 * 1024;
export const MAX_REQUEST_NOTES_BYTES = 8 * 1024;

/** A string of at most `maxBytes` UTF-8 bytes; the one check every notes field uses. */
export const utf8Capped = (maxBytes: number, label: string) =>
  z.string().refine((s) => Buffer.byteLength(s, "utf8") <= maxBytes, {
    message: `${label} is limited to ${maxBytes} bytes (UTF-8)`,
  });

/** Parses with `utf8Capped`, throwing `validation_failed` with its message. */
export function assertUtf8Capped(value: string, maxBytes: number, label: string): void {
  const r = utf8Capped(maxBytes, label).safeParse(value);
  if (!r.success) throw new SindriError("validation_failed", r.error.issues[0]!.message);
}

export const SKILL_FILE = "SKILL.md";

export interface Skill {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  content: string;
  /** sha256 hex of the SKILL.md bytes as imported. */
  digest: string;
  importedAt: string;
  updatedAt: string;
}

export interface SkillListing extends Omit<Skill, "content"> {
  bytes: number;
  /** The file on disk differs from the imported content, or is gone/unreadable. */
  changedOnDisk: boolean;
  missingOnDisk: boolean;
}

export interface SkillImportResult {
  imported: Skill[];
  skipped: { path: string; reason: SkillSkipReason }[];
}

export type SkillSkipReason = "symlink_escapes" | "too_large" | "not_a_file" | "unreadable";

export interface ProjectGuidance {
  projectId: string;
  notes: string;
  defaultSkillIds: string[];
  updatedAt: string | null;
}

/** A skill as carried in a plan and rendered into a brief. */
export interface GuidanceSkill {
  id: string;
  name: string;
  digest: string;
  content: string;
}

/**
 * The guidance a plan was made with: the skills that fit the cap (with their content), the ones
 * left out, and both notes with their digests. Stored in the plan so a brief and its report never
 * depend on later edits to the library.
 */
export interface GuidanceSnapshot {
  skills: GuidanceSkill[];
  omitted: { id: string; name: string; digest: string }[];
  projectNotes: string;
  requestNotes: string;
  projectNotesDigest: string | null;
  requestNotesDigest: string | null;
}

export const sha256Text = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const GUIDANCE_HEADER =
  "Operator guidance: the operator of this factory chose the skills and notes below for this work. They are trusted operator instructions; follow them unless they conflict with the rules of this brief.";

const skillBlock = (s: Pick<GuidanceSkill, "name" | "digest" | "content">) =>
  `### Skill: ${s.name} (sha256 ${s.digest.slice(0, 12)})\n${s.content.trimEnd()}`;

/** The omitted-skills line never takes more than this; further names become "and N more". */
const OMITTED_LINE_MAX_BYTES = 2048;
const OMITTED_NAME_MAX_CHARS = 200;
const SEPARATOR = "\n\n";

/** `s` cut to at most `max` UTF-8 bytes, on a character boundary. */
function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = bytes(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

function omittedLine(names: readonly string[]): string {
  const head = "Omitted (size cap): ";
  // Room kept for the longest possible ", and N more" tail.
  const budget = OMITTED_LINE_MAX_BYTES - bytes(head) - bytes(`, and ${names.length} more`);
  const shown: string[] = [];
  let used = 0;
  for (const raw of names) {
    const name =
      raw.length > OMITTED_NAME_MAX_CHARS ? `${raw.slice(0, OMITTED_NAME_MAX_CHARS)}…` : raw;
    const cost = bytes(name) + (shown.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    shown.push(name);
    used += cost;
  }
  const more = names.length - shown.length;
  return `${head}${shown.join(", ")}${more > 0 ? `${shown.length > 0 ? ", " : ""}and ${more} more` : ""}`;
}

/**
 * Header and notes parts. Notes have their own caps where they are written; they are cut to those
 * caps here too, so the parts outside the skills are bounded whatever a stored plan holds.
 */
function fixedParts(projectNotes: string, requestNotes: string) {
  const parts = { head: [GUIDANCE_HEADER], tail: [] as string[] };
  const p = cutBytes(projectNotes.trim(), MAX_PROJECT_NOTES_BYTES);
  const r = cutBytes(requestNotes.trim(), MAX_REQUEST_NOTES_BYTES);
  if (p) parts.tail.push(`### Project notes\n${p}`);
  if (r) parts.tail.push(`### Request notes\n${r}`);
  return parts;
}

function renderParts(
  skills: readonly GuidanceSkill[],
  omitted: readonly { name: string }[],
  projectNotes: string,
  requestNotes: string,
): string {
  const { head, tail } = fixedParts(projectNotes, requestNotes);
  const parts = [...head, ...skills.map(skillBlock), ...tail];
  if (omitted.length > 0) parts.push(omittedLine(omitted.map((o) => o.name)));
  return parts.join(SEPARATOR);
}

/**
 * Keeps skills, in order, while the rendered block stays within `cap`; every skill that does not
 * fit is listed as omitted, whole. The header, notes and a bounded omitted line are counted first
 * and skills fill what remains.
 */
export function fitGuidance(
  input: {
    skills: readonly GuidanceSkill[];
    /** Skills already left out (kept in the omitted list). */
    omitted?: readonly GuidanceSnapshot["omitted"][number][];
    projectNotes?: string;
    requestNotes?: string;
  },
  cap = GUIDANCE_CAP_BYTES,
): GuidanceSnapshot {
  const projectNotes = input.projectNotes ?? "";
  const requestNotes = input.requestNotes ?? "";
  const { head, tail } = fixedParts(projectNotes, requestNotes);
  const fixed = [...head, ...tail].reduce((n, part) => n + bytes(part) + bytes(SEPARATOR), 0);
  let room = cap - fixed - OMITTED_LINE_MAX_BYTES;
  const seen = new Set<string>();
  const kept: GuidanceSkill[] = [];
  const omitted: GuidanceSnapshot["omitted"] = [...(input.omitted ?? [])];
  for (let i = 0; i < input.skills.length; i++) {
    const s = input.skills[i]!;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const cost = bytes(skillBlock(s)) + bytes(SEPARATOR);
    if (cost <= room) {
      kept.push(s);
      room -= cost;
    } else omitted.push({ id: s.id, name: s.name, digest: s.digest });
  }
  return {
    skills: kept,
    omitted,
    projectNotes,
    requestNotes,
    projectNotesDigest: projectNotes.trim() ? sha256Text(projectNotes) : null,
    requestNotesDigest: requestNotes.trim() ? sha256Text(requestNotes) : null,
  };
}

/**
 * The "Operator guidance" brief block, or "" when there is no guidance. Never over `cap` bytes
 * (for any cap above the header, the notes caps and the omitted-line bound).
 */
export function renderGuidance(snapshot: GuidanceSnapshot, cap = GUIDANCE_CAP_BYTES): string {
  const fitted = fitGuidance(snapshot, cap);
  if (emptyGuidance(fitted)) return "";
  return renderParts(fitted.skills, fitted.omitted, fitted.projectNotes, fitted.requestNotes);
}

/** Simple `key: value` frontmatter (name, description) at the top of a SKILL.md. */
export function skillFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) out[kv[1] as "name" | "description"] = value.slice(0, 500);
  }
  return out;
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

type ReadResult =
  { ok: true; text: string; digest: string } | { ok: false; reason: SkillSkipReason };

/**
 * Reads `<folder>/SKILL.md`. The file may be a symlink only to somewhere inside the folder; it
 * must be a regular file of at most `MAX_SKILL_BYTES`.
 */
function readSkillFile(folder: string): ReadResult {
  let root: string;
  let real: string;
  try {
    root = realpathSync(folder);
    real = realpathSync(join(folder, SKILL_FILE));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!within(root, real)) return { ok: false, reason: "symlink_escapes" };
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_a_file" };
    if (st.size > MAX_SKILL_BYTES) return { ok: false, reason: "too_large" };
    const buf = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > MAX_SKILL_BYTES) return { ok: false, reason: "too_large" };
    }
    const data = buf.subarray(0, off);
    return { ok: true, text: data.toString("utf8"), digest: sha256Text(data) };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

const hasSkillFile = (folder: string) => {
  try {
    lstatSync(join(folder, SKILL_FILE));
    return true;
  } catch {
    return false;
  }
};

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source_path: string;
  content: string;
  digest: string;
  imported_at: string;
  updated_at: string;
}

const toSkill = (r: SkillRow): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  sourcePath: r.source_path,
  content: r.content,
  digest: r.digest,
  importedAt: r.imported_at,
  updatedAt: r.updated_at,
});

/** The skills library and per-project guidance, over the knowledge database. */
export function openGuidance(db: SqliteDatabase, options: { now?: () => Date } = {}) {
  const iso = () => (options.now ?? (() => new Date()))().toISOString();
  const getRow = (id: string) =>
    db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;

  const upsert = (folder: string, read: { text: string; digest: string }): Skill => {
    // The real path, so the same folder reached through a symlink or another spelling is one skill.
    let real = folder;
    try {
      real = realpathSync(folder);
    } catch {
      // Read a moment ago; keep the given spelling if it vanished since.
    }
    const sourcePath = join(real, SKILL_FILE);
    const fm = skillFrontmatter(read.text);
    const name = fm.name ?? basename(real);
    const ts = iso();
    const existing = db
      .prepare("SELECT * FROM skills WHERE source_path IN (?, ?) ORDER BY rowid LIMIT 1")
      .get(sourcePath, join(folder, SKILL_FILE)) as SkillRow | undefined;
    if (existing) {
      db.prepare(
        `UPDATE skills SET name = ?, description = ?, source_path = ?, content = ?, digest = ?,
           updated_at = ? WHERE id = ?`,
      ).run(name, fm.description ?? "", sourcePath, read.text, read.digest, ts, existing.id);
      return toSkill(getRow(existing.id)!);
    }
    const row: SkillRow = {
      id: `skl_${randomUUID()}`,
      name,
      description: fm.description ?? "",
      source_path: sourcePath,
      content: read.text,
      digest: read.digest,
      imported_at: ts,
      updated_at: ts,
    };
    db.prepare(
      `INSERT INTO skills (id, name, description, source_path, content, digest, imported_at, updated_at)
       VALUES (@id, @name, @description, @source_path, @content, @digest, @imported_at, @updated_at)`,
    ).run(row);
    return toSkill(row);
  };

  const listing = (r: SkillRow): SkillListing => {
    const { content, ...rest } = toSkill(r);
    const now = readSkillFile(r.source_path.slice(0, -(SKILL_FILE.length + 1)));
    return {
      ...rest,
      bytes: bytes(content),
      changedOnDisk: !now.ok || now.digest !== r.digest,
      missingOnDisk: !now.ok,
    };
  };

  const api = {
    /**
     * Imports `<path>/SKILL.md`, or, when `path` has none, every direct child folder that has one.
     * Re-importing a known source path updates it in place.
     */
    importPath(path: string): SkillImportResult {
      if (!isAbsolute(path))
        throw new SindriError("validation_failed", "skill path must be absolute");
      const folder = resolve(path);
      let st;
      try {
        st = lstatSync(folder);
        if (st.isSymbolicLink()) st = lstatSync(realpathSync(folder));
      } catch {
        throw new SindriError("not_found", "skill folder not found");
      }
      if (!st.isDirectory())
        throw new SindriError("validation_failed", "skill path must be a folder");
      const result: SkillImportResult = { imported: [], skipped: [] };
      const importOne = (dir: string) => {
        const read = readSkillFile(dir);
        if (read.ok) result.imported.push(upsert(dir, read));
        else result.skipped.push({ path: join(dir, SKILL_FILE), reason: read.reason });
      };
      if (hasSkillFile(folder)) importOne(folder);
      else {
        const root = realpathSync(folder);
        const children = readdirSync(folder, { withFileTypes: true })
          .filter((d) => d.isDirectory() || d.isSymbolicLink())
          .map((d) => join(folder, d.name))
          .sort();
        for (const child of children) {
          let real: string;
          try {
            real = realpathSync(child);
            if (!lstatSync(real).isDirectory()) continue;
          } catch {
            continue;
          }
          if (!hasSkillFile(child)) continue;
          if (!within(root, real)) {
            result.skipped.push({ path: join(child, SKILL_FILE), reason: "symlink_escapes" });
            continue;
          }
          importOne(child);
        }
        if (result.imported.length === 0 && result.skipped.length === 0)
          throw new SindriError(
            "validation_failed",
            `no ${SKILL_FILE} in the folder or its direct child folders`,
          );
      }
      return result;
    },

    reimport(id: string): Skill {
      const row = getRow(id);
      if (!row) throw new SindriError("not_found", "skill not found");
      const folder = row.source_path.slice(0, -(SKILL_FILE.length + 1));
      const read = readSkillFile(folder);
      if (!read.ok)
        throw new SindriError("validation_failed", `cannot re-import skill: ${read.reason}`, {
          reason: read.reason,
        });
      return upsert(folder, read);
    },

    get(id: string): Skill | undefined {
      const r = getRow(id);
      return r && toSkill(r);
    },

    /** Every skill, with whether the file on disk still matches what was imported. */
    list(): SkillListing[] {
      const rows = db.prepare("SELECT * FROM skills ORDER BY name, rowid").all() as SkillRow[];
      return rows.map(listing);
    },

    /** One skill with its drift flags; reads only that skill's file. */
    listing(id: string): SkillListing | undefined {
      const r = getRow(id);
      return r && listing(r);
    },

    /** Deletes a skill and drops it from every project's defaults. */
    delete(id: string): void {
      if (!getRow(id)) throw new SindriError("not_found", "skill not found");
      db.transaction(() => {
        db.prepare("DELETE FROM skills WHERE id = ?").run(id);
        const rows = db
          .prepare("SELECT project_id, default_skill_ids FROM project_guidance")
          .all() as { project_id: string; default_skill_ids: string }[];
        for (const r of rows) {
          const ids = JSON.parse(r.default_skill_ids) as string[];
          if (ids.includes(id))
            db.prepare(
              "UPDATE project_guidance SET default_skill_ids = ?, updated_at = ? WHERE project_id = ?",
            ).run(JSON.stringify(ids.filter((x) => x !== id)), iso(), r.project_id);
        }
      })();
    },

    /** Ids among `ids` that are not in the library. */
    unknownSkills(ids: readonly string[]): string[] {
      const has = db.prepare("SELECT 1 FROM skills WHERE id = ?");
      return ids.filter((id) => !has.get(id));
    },

    projectGuidance(projectId: string): ProjectGuidance {
      const r = db.prepare("SELECT * FROM project_guidance WHERE project_id = ?").get(projectId) as
        { notes: string; default_skill_ids: string; updated_at: string } | undefined;
      return {
        projectId,
        notes: r?.notes ?? "",
        defaultSkillIds: r ? (JSON.parse(r.default_skill_ids) as string[]) : [],
        updatedAt: r?.updated_at ?? null,
      };
    },

    setProjectGuidance(
      projectId: string,
      input: { notes: string; defaultSkillIds: string[] },
    ): ProjectGuidance {
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId))
        throw new SindriError("not_found", "project not found");
      assertUtf8Capped(input.notes, MAX_PROJECT_NOTES_BYTES, "project notes");
      const ids = [...new Set(input.defaultSkillIds)];
      const unknown = api.unknownSkills(ids);
      if (unknown.length > 0)
        throw new SindriError("validation_failed", "unknown skill ids", { unknown });
      db.prepare(
        `INSERT INTO project_guidance (project_id, notes, default_skill_ids, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET notes = excluded.notes,
           default_skill_ids = excluded.default_skill_ids, updated_at = excluded.updated_at`,
      ).run(projectId, input.notes, JSON.stringify(ids), iso());
      return api.projectGuidance(projectId);
    },

    /**
     * The fitted guidance for one piece of work: the project's default skills, then the request's
     * own (deduplicated, unknown ids ignored), project notes and request notes.
     */
    snapshot(
      projectId: string,
      request: { skillIds?: readonly string[]; notes?: string } = {},
    ): GuidanceSnapshot {
      const pg = api.projectGuidance(projectId);
      const ids = [...new Set([...pg.defaultSkillIds, ...(request.skillIds ?? [])])];
      const skills = ids
        .map((id) => getRow(id))
        .filter((r): r is SkillRow => r !== undefined)
        .map((r) => ({ id: r.id, name: r.name, digest: r.digest, content: r.content }));
      return fitGuidance({
        skills,
        projectNotes: pg.notes,
        requestNotes: request.notes ?? "",
      });
    },
  };
  return api;
}

export type Guidance = ReturnType<typeof openGuidance>;

/** True when the snapshot carries nothing to render. */
export const emptyGuidance = (g: GuidanceSnapshot | undefined): boolean =>
  !g ||
  (g.skills.length === 0 &&
    g.omitted.length === 0 &&
    !g.projectNotes.trim() &&
    !g.requestNotes.trim());
