import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PreparedContext, PreparedFile } from "./domain.js";
import { z } from "zod";
import { fileDigest, sha256Digest } from "./digest.js";
import { Sha256DigestSchema } from "./schemas.js";
import { BrokkrError } from "./errors.js";

export const LEDGER_FILE = ".brokkr-ledger.json";

const LedgerEntrySchema = z.strictObject({
  relativePath: z.string().min(1),
  digest: Sha256DigestSchema,
  bytes: z.number().int().nonnegative(),
  mode: z.enum(["created", "block"]),
  /** For `block` entries: exact text inserted, and whether Brokkr created the file. */
  blockText: z.string().optional(),
  createdFile: z.boolean().optional(),
});
type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Schema of `.brokkr-ledger.json`. Cleanup refuses a ledger that does not match. */
export const LedgerSchema = z.strictObject({
  ledgerVersion: z.literal(1),
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  files: z.array(LedgerEntrySchema),
  /** Directories Brokkr created, relative to cwd, deepest last. */
  dirs: z.array(z.string().min(1)),
});
type Ledger = z.infer<typeof LedgerSchema>;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Real (symlink-resolved) location of `abs`: the nearest existing ancestor is
 * passed through `realpath` and the not-yet-existing tail is re-joined.
 * Returns undefined when an ancestor cannot be resolved (e.g. dangling link).
 */
function realLocation(abs: string): string | undefined {
  const tail: string[] = [];
  let current = abs;
  while (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    tail.unshift(basename(current));
    current = parent;
  }
  // `current` exists. If it is an intermediate component it will be traversed,
  // so resolve it fully. If it is the target itself, resolve only its parent so
  // a symlink at the target is reported by lstat instead of silently followed.
  try {
    if (tail.length > 0) return join(realpathSync(current), ...tail);
    const parent = dirname(current);
    return parent === current ? current : join(realpathSync(parent), basename(current));
  } catch {
    return undefined;
  }
}

/** Lexical and symlink-resolved containment check. */
function safelyInside(base: string, realBase: string, abs: string): boolean {
  if (!isInside(base, abs)) return false;
  const real = realLocation(abs);
  return real !== undefined && isInside(realBase, real);
}

function markers(adapterId: string): { begin: string; end: string } {
  return { begin: `<!-- brokkr:begin ${adapterId} -->`, end: `<!-- brokkr:end ${adapterId} -->` };
}

/**
 * Writes adapter output while keeping a ledger of exactly what was written so
 * `cleanupBundle` can remove only Brokkr-owned files. Never overwrites a file
 * it did not write.
 */
export class BundleWriter {
  private readonly cwd: string;
  private readonly rootDir: string;
  private readonly adapterId: string;
  private readonly adapterVersion: string;
  private readonly entries: LedgerEntry[] = [];
  private readonly dirs: string[] = [];

  constructor(options: {
    cwd: string;
    rootDir: string;
    adapterId: string;
    adapterVersion: string;
  }) {
    this.cwd = resolve(options.cwd);
    this.rootDir = resolve(options.rootDir);
    this.adapterId = options.adapterId;
    this.adapterVersion = options.adapterVersion;
    if (!isInside(this.cwd, this.rootDir)) {
      throw new BrokkrError(
        "policy-denied",
        `bundle directory ${this.rootDir} is outside ${this.cwd}`,
      );
    }
  }

  /** Refuse paths outside cwd (lexically or via symlinks) and symlinked targets. */
  private guard(path: string): string {
    const abs = resolve(path);
    if (!safelyInside(this.cwd, realpathSync(this.cwd), abs)) {
      throw new BrokkrError("policy-denied", `refusing to write ${abs}: outside ${this.cwd}`);
    }
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new BrokkrError("policy-denied", `refusing to write ${abs}: target is a symlink`);
    }
    return abs;
  }

  private async ensureDir(dir: string): Promise<void> {
    if (dir !== this.cwd && !safelyInside(this.cwd, realpathSync(this.cwd), dir)) {
      throw new BrokkrError("policy-denied", `refusing to create ${dir}: outside ${this.cwd}`);
    }
    const missing: string[] = [];
    let current = dir;
    while (
      lstatSync(current, { throwIfNoEntry: false }) === undefined &&
      isInside(this.cwd, current)
    ) {
      missing.unshift(current);
      current = dirname(current);
    }
    for (const d of missing) {
      await mkdir(d);
      this.dirs.push(toPosix(relative(this.cwd, d)));
    }
  }

  /** Create a new file owned by Brokkr. */
  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.guard(path);
    const rel = toPosix(relative(this.cwd, abs));
    if (existsSync(abs) && !this.entries.some((e) => e.relativePath === rel)) {
      throw new BrokkrError(
        "policy-denied",
        `refusing to overwrite ${rel}: file exists and was not written by brokkr`,
      );
    }
    await this.ensureDir(dirname(abs));
    await writeFile(abs, content);
    this.record({
      relativePath: rel,
      digest: sha256Digest(content),
      bytes: Buffer.byteLength(content),
      mode: "created",
    });
  }

  /** Insert (or replace) a marked Brokkr block in a project file, creating the file if needed. */
  async upsertBlock(path: string, content: string): Promise<void> {
    const abs = this.guard(path);
    const rel = toPosix(relative(this.cwd, abs));
    const { begin, end } = markers(this.adapterId);
    const createdFile = !existsSync(abs);
    let existing = createdFile ? "" : await readFile(abs, "utf8");
    existing = stripBlock(existing, this.adapterId);
    const prefix = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    const blockText = `${prefix}${begin}\n${content}\n${end}\n`;
    await this.ensureDir(dirname(abs));
    await writeFile(abs, existing + blockText);
    this.record({
      relativePath: rel,
      digest: sha256Digest(blockText),
      bytes: Buffer.byteLength(blockText),
      mode: "block",
      blockText,
      createdFile,
    });
  }

  private record(entry: LedgerEntry): void {
    const index = this.entries.findIndex((e) => e.relativePath === entry.relativePath);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
  }

  /** Persist the ledger and describe what was written. */
  async commit(entrypoint: string): Promise<PreparedContext> {
    await this.ensureDir(this.rootDir);
    const ledgerPath = this.guard(join(this.rootDir, LEDGER_FILE));
    const ledger: Ledger = {
      ledgerVersion: 1,
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion,
      files: this.entries,
      dirs: this.dirs,
    };
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const files: PreparedFile[] = this.entries.map((e) => ({
      path: join(this.cwd, ...e.relativePath.split("/")),
      relativePath: e.relativePath,
      digest: e.digest,
      bytes: e.bytes,
      mode: e.mode,
    }));
    return {
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion,
      rootDir: this.rootDir,
      entrypoint: resolve(entrypoint),
      files,
      ledgerPath,
    };
  }
}

function stripBlock(text: string, adapterId: string): string {
  const { begin, end } = markers(adapterId);
  const start = text.indexOf(begin);
  if (start < 0) return text;
  const stop = text.indexOf(end, start);
  if (stop < 0) return text;
  let before = text.slice(0, start);
  let after = text.slice(stop + end.length);
  if (after.startsWith("\n")) after = after.slice(1);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return before + after;
}

export interface CleanupResult {
  /** Relative paths removed (or whose Brokkr block was removed). */
  removed: string[];
  /** Ledger entries deliberately left in place, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Remove exactly the files recorded in `rootDir`'s ledger, plus directories
 * Brokkr created if they are now empty. The ledger is treated as untrusted:
 * every entry must stay inside the boundary (the bundle directory, or `cwd`
 * when `allowProjectFiles` is set) after resolving symlinks, must not be a
 * symlink itself, and must still have the digest recorded at write time.
 * Anything else is skipped and reported, never deleted.
 */
export async function cleanupBundle(
  rootDir: string,
  cwd: string,
  options: {
    allowProjectFiles?: boolean;
    /**
     * With `allowProjectFiles`, the project files (outside the bundle
     * directory) this adapter may own, as POSIX paths relative to cwd. Ledger
     * entries for any other project file are skipped.
     */
    isProjectFile?: (relativePath: string) => boolean;
  } = {},
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], skipped: [] };
  const base = resolve(cwd);
  const root = resolve(rootDir);
  if (!existsSync(base) || !existsSync(root)) return result;
  const realBase = realpathSync(base);
  if (!safelyInside(base, realBase, root)) {
    throw new BrokkrError("policy-denied", `bundle directory ${root} is outside ${base}`);
  }
  const ledgerPath = join(root, LEDGER_FILE);
  const ledgerStat = lstatSync(ledgerPath, { throwIfNoEntry: false });
  if (ledgerStat === undefined) return result;
  if (!ledgerStat.isFile())
    throw new BrokkrError("policy-denied", `ledger ${ledgerPath} is not a regular file`);

  const boundary = options.allowProjectFiles ? base : root;
  const realBoundary = realpathSync(boundary);
  let ledger: Ledger;
  try {
    ledger = LedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
  } catch (error) {
    throw new BrokkrError(
      "invalid-config",
      `malformed ledger ${ledgerPath}; refusing to clean up`,
      { cause: error },
    );
  }
  const skip = (path: string, reason: string): void => {
    result.skipped.push({ path, reason });
  };

  for (const entry of ledger.files) {
    const rel = entry.relativePath;
    const abs = resolve(base, rel);
    if (!safelyInside(boundary, realBoundary, abs)) {
      skip(
        rel,
        `outside ${options.allowProjectFiles ? "the project directory" : "the bundle directory"}`,
      );
      continue;
    }
    if (
      options.allowProjectFiles &&
      options.isProjectFile &&
      !isInside(root, abs) &&
      !options.isProjectFile(toPosix(relative(base, abs)))
    ) {
      skip(rel, "not one of this adapter's project files");
      continue;
    }
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) {
      skip(rel, "is a symlink");
      continue;
    }
    if (!stat.isFile()) {
      skip(rel, "is not a regular file");
      continue;
    }
    if (entry.mode === "created") {
      if ((await fileDigest(abs)) !== entry.digest) {
        skip(rel, "digest mismatch: modified since brokkr wrote it");
        continue;
      }
      await unlink(abs);
      result.removed.push(rel);
      continue;
    }
    const text = await readFile(abs, "utf8");
    const block = entry.blockText;
    const { begin, end } = markers(ledger.adapterId);
    if (block === undefined || !block.includes(begin) || !block.includes(end)) {
      skip(rel, "block entry lacks brokkr markers");
      continue;
    }
    if (sha256Digest(block) !== entry.digest || !text.includes(block)) {
      skip(rel, "digest mismatch: brokkr block modified since it was written");
      continue;
    }
    const next = text.replace(block, "");
    if (entry.createdFile && next.trim() === "") await unlink(abs);
    else await writeFile(abs, next);
    result.removed.push(rel);
  }
  await unlink(ledgerPath);
  // Directories: only Brokkr's own state directory (`.brokkr/`) unless project
  // files are allowed, so a forged ledger cannot prune empty project dirs.
  const brokkrDir = join(base, ".brokkr");
  const dirBoundary = options.allowProjectFiles
    ? base
    : isInside(brokkrDir, root)
      ? brokkrDir
      : root;
  const realDirBoundary = existsSync(dirBoundary) ? realpathSync(dirBoundary) : realBoundary;
  for (const rel of [...ledger.dirs].reverse()) {
    const abs = resolve(base, rel);
    if (!safelyInside(dirBoundary, realDirBoundary, abs)) continue;
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if ((await readdir(abs)).length === 0) await rmdir(abs);
  }
  return result;
}
