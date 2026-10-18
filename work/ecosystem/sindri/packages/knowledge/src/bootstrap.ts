import { SindriError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join, posix, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { chunkText } from "./chunk.js";
import type { SqliteDatabase } from "./db.js";
import { gitConfigFindings, type GitAuditOptions } from "./git-safety.js";
import { containsSecret, secretLineRanges } from "./secrets.js";

export {
  auditGitConfig,
  gitConfigFindings,
  isDangerousGitKey,
  UnsafeGitConfigError,
} from "./git-safety.js";

/** Files whose names match these are never read, let alone indexed. */
export const SECRET_PATTERNS: readonly string[] = [
  ".env*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*credentials*",
  "*.p12",
  // defense in depth beyond the brief's list
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  "*.pfx",
  "*.jks",
  "*.keystore",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "service-account*.json",
  // audit M7
  "*.tfvars",
  "*.tfvars.json",
  "*.tfstate",
  "*.tfstate.*",
  "secrets.*",
  "*.ppk",
  ".htpasswd",
  "kubeconfig",
  "*.kubeconfig",
  ".dockercfg",
  ".docker/config.json",
];
/** Always excluded, even outside git. */
export const DEFAULT_EXCLUDES: readonly string[] = [".git/", "node_modules/"];
export const MAX_FILE_BYTES = 1024 * 1024;
export const STRUCTURE_DEPTH = 3;
/** Longer repo-relative paths are skipped as `unsafe_name`. */
export const MAX_PATH_LENGTH = 512;

export type DocumentKind =
  | "readme"
  | "doc"
  | "adr"
  | "manifest"
  | "build-script"
  | "design-system"
  | "test-commands"
  | "structure";

/**
 * `symlink_escape`: the path, or one of its parent directories, is a symbolic link, or it
 * resolves outside the repo root. Such paths are never read.
 * `special_file`: a FIFO, socket or device; never opened (opening a FIFO blocks).
 * `unsafe_name`: the path contains control, bidi or zero-width characters, or is longer than
 * {@link MAX_PATH_LENGTH}; it is kept out of the index and the structure summary.
 */
export type SkipReason =
  | "secret"
  | "too-large"
  | "binary"
  | "symlink_escape"
  | "unreadable"
  | "special_file"
  | "unsafe_name";

const UNSAFE_NAME_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- each invisible code point is matched on its own, combining marks included
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** True for repo paths that must never reach the index or a prompt (audit H1). */
export function isUnsafeName(path: string): boolean {
  return path.length > MAX_PATH_LENGTH || UNSAFE_NAME_CHARS.test(path);
}

export interface BootstrapOptions {
  repoPath: string;
  /** Time budget for the git-config audit (default 2 s); an overrun reports `audit_timeout`. */
  gitAuditBudgetMs?: number;
}

export interface BootstrapResult {
  /** Documents (re)indexed in this run. */
  indexed: string[];
  /** Documents whose content hash did not change. */
  unchanged: string[];
  /** Documents that disappeared from the repo and were removed from the index. */
  removed: string[];
  skipped: { path: string; reason: SkipReason }[];
  /**
   * Present when the repo's own git config holds code-executing keys: git was not run and the
   * files were listed by the filesystem walker instead (audit C1).
   */
  unsafeGitConfig?: string[];
  /** Line ranges whose chunks were dropped because their content looks like a secret (M7). */
  secretsDropped: { path: string; startLine: number; endLine: number }[];
}

const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
]);
const BUILD_SCRIPTS = new Set(["Makefile", "makefile", "GNUmakefile", "justfile", "Justfile"]);
const TEST_LIKE = /(test|check|lint|e2e|verify|spec)/i;

export function classify(path: string): DocumentKind | undefined {
  const base = basename(path);
  if (path.startsWith("docs/adrs/") || path.startsWith(".adr/") || path.endsWith(".adr")) {
    return "adr";
  }
  if (/^readme/i.test(base)) return "readme";
  if (path.startsWith("docs/") && /\.md$/i.test(path)) return "doc";
  if (MANIFESTS.has(base)) return "manifest";
  if (BUILD_SCRIPTS.has(base)) return "build-script";
  if (
    /^tailwind\.config\.[cm]?[jt]s$/.test(base) ||
    /(^|[-_.])(design-)?tokens?\.(json|[cm]?[jt]s|css|scss|ya?ml)$/i.test(base)
  ) {
    return "design-system";
  }
  return undefined;
}

/** Read an ignore file only if it is a regular, non-symlinked file of sane size. */
function readIgnoreFile(root: string, name: string): string {
  const p = join(root, name);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return "";
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** True if any component of `rel` (relative to root) is a symlink. Caches per prefix. */
function hasSymlinkComponent(
  root: string,
  rel: string,
  cache: Map<string, boolean>,
): boolean | undefined {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    let link = cache.get(prefix);
    if (link === undefined) {
      try {
        link = lstatSync(join(root, prefix)).isSymbolicLink();
      } catch {
        return undefined; // missing (e.g. deleted but still in the git index)
      }
      cache.set(prefix, link);
    }
    if (link) return true;
  }
  return false;
}

/**
 * Read a repo file without following symlinks: lstat first (only regular files are opened, so
 * a FIFO can never block), then an O_NOFOLLOW|O_NONBLOCK open, fstat on the fd, and a realpath
 * check that the file is inside the repo root.
 */
function readContained(
  full: string,
  realRoot: string,
): { buf: Buffer } | { skip: SkipReason } | undefined {
  try {
    if (!lstatSync(full).isFile()) return { skip: "special_file" };
  } catch {
    return undefined;
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return undefined;
  }
  if (!real.startsWith(realRoot + sep)) return { skip: "symlink_escape" };
  let fd: number;
  try {
    fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP"
      ? { skip: "symlink_escape" }
      : { skip: "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { skip: "special_file" };
    if (st.size > MAX_FILE_BYTES) return { skip: "too-large" };
    return { buf: readFileSync(fd) };
  } catch {
    return { skip: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

type Scope = { base: string; ig: Ignore };

/**
 * Walk the tree honouring `.gitignore` files the way git does: the deepest `.gitignore` with a
 * rule matching the path decides (so a nested `!pattern` re-includes), then the root
 * `.gitignore`, then `.git/info/exclude`; a file inside an excluded directory is never
 * re-included because excluded directories are not entered. `.sindriignore` and the default
 * excludes always win. Ignore files are read only when they are regular files, so a FIFO in
 * their place cannot block.
 */
function walkFiles(root: string, forced: Ignore): string[] {
  const out: string[] = [];
  const infoExclude: Scope = {
    base: "",
    ig: ignore().add(readIgnoreFile(root, ".git/info/exclude")),
  };
  const ignored = (p: string, scopes: Scope[]) => {
    if (forced.ignores(p)) return true;
    for (const { base, ig } of [...scopes].reverse().concat(infoExclude)) {
      const rel = base ? p.slice(base.length + 1) : p;
      if (!rel) continue;
      const r = ig.test(rel);
      if (r.ignored) return true;
      if (r.unignored) return false;
    }
    return false;
  };
  const visit = (rel: string, parentScopes: Scope[]) => {
    const scopes = [
      ...parentScopes,
      {
        base: rel,
        ig: ignore().add(readIgnoreFile(root, rel ? `${rel}/.gitignore` : ".gitignore")),
      },
    ];
    for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!ignored(`${p}/`, scopes)) visit(p, scopes);
      } else if (!ignored(p, scopes)) {
        out.push(p);
      }
    }
  };
  visit("", []);
  return out;
}

/** Excludes that no `.gitignore` negation can override. */
function forcedIgnore(root: string): Ignore {
  return ignore()
    .add(DEFAULT_EXCLUDES as string[])
    .add(readIgnoreFile(root, ".sindriignore"));
}

/**
 * List files for bootstrap. Always the filesystem walker: git is never run to list files
 * (review Ssec I1). The repo's git setup is only audited, and findings are reported.
 */
function listFiles(
  root: string,
  audit: GitAuditOptions = {},
): { files: string[]; unsafeGitConfig?: string[] } {
  const files = walkFiles(root, forcedIgnore(root)).sort();
  const unsafe = gitConfigFindings(root, audit);
  return unsafe.length ? { files, unsafeGitConfig: unsafe } : { files };
}

/** List repo-relative files honoring .gitignore files, .git/info/exclude, .sindriignore and defaults. */
export function listCandidateFiles(root: string): string[] {
  return listFiles(root).files;
}

const secretMatcher = ignore().add(SECRET_PATTERNS as string[]);
export const isSecretPath = (path: string): boolean => secretMatcher.ignores(path);

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function makeTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (m?.[1] && !m[1].startsWith(".")) out.push(m[1]);
  }
  return out;
}

function justRecipes(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^@?([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s+[^:=]*)?:(?!=)/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function packageManager(root: string, files: Set<string>): string {
  if (files.has("pnpm-lock.yaml") || existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  return "npm";
}

function testCommandsDoc(root: string, readable: Map<string, string>, files: Set<string>): string {
  const pm = packageManager(root, files);
  const lines: string[] = [];
  for (const [path, text] of readable) {
    const base = basename(path);
    const dir = posix.dirname(path);
    if (base === "package.json") {
      let scripts: Record<string, unknown>;
      try {
        const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
        scripts = parsed.scripts ?? {};
      } catch {
        continue;
      }
      for (const [name, cmd] of Object.entries(scripts)) {
        if (!TEST_LIKE.test(name) || typeof cmd !== "string") continue;
        const where = dir === "." ? "" : ` (in ${dir})`;
        lines.push(`- \`${pm} run ${name}\`${where} -> ${cmd}`);
      }
    } else if (BUILD_SCRIPTS.has(base)) {
      const isJust = /^justfile$/i.test(base);
      const tool = isJust ? "just" : "make";
      const targets = isJust ? justRecipes(text) : makeTargets(text);
      for (const t of targets) {
        if (!TEST_LIKE.test(t)) continue;
        const where = dir === "." ? "" : ` (in ${dir})`;
        lines.push(`- \`${tool} ${t}\`${where} (${path})`);
      }
    }
  }
  return lines.length ? ["# Test commands", "", ...lines].join("\n") + "\n" : "";
}

function structureDoc(files: string[]): string {
  const counts = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      rootFiles.push(f);
      continue;
    }
    const dirs = parts.slice(0, -1);
    for (let d = 1; d <= Math.min(dirs.length, STRUCTURE_DEPTH); d++) {
      const key = `${dirs.slice(0, d).join("/")}/`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const dirLines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, n]) => `${dir} (${n} file${n === 1 ? "" : "s"})`);
  return (
    [
      `# Directory structure (depth ${STRUCTURE_DEPTH})`,
      "",
      "Root files: " + (rootFiles.join(", ") || "(none)"),
      "",
      ...dirLines,
    ].join("\n") + "\n"
  );
}

interface DocRow {
  id: string;
  path: string;
  sha256: string;
}

export function bootstrapProject(
  db: SqliteDatabase,
  projectId: string,
  { repoPath, gitAuditBudgetMs }: BootstrapOptions,
  clock: () => Date,
): BootstrapResult {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new SindriError("not_found", `unknown project ${projectId}`);
  }
  const listing = listFiles(
    realpathSync(repoPath),
    gitAuditBudgetMs === undefined ? {} : { budgetMs: gitAuditBudgetMs },
  );
  const all = listing.files;
  const fileSet = new Set(all);
  const skipped: BootstrapResult["skipped"] = [];
  const visible: string[] = [];
  const toIndex = new Map<string, { kind: DocumentKind; text: string }>();
  const readable = new Map<string, string>();
  const realRoot = realpathSync(repoPath);
  const linkCache = new Map<string, boolean>();

  for (const path of all) {
    if (isUnsafeName(path)) {
      skipped.push({ path, reason: "unsafe_name" });
      continue;
    }
    if (isSecretPath(path)) {
      skipped.push({ path, reason: "secret" });
      continue;
    }
    const linked = hasSymlinkComponent(repoPath, path, linkCache);
    if (linked === undefined) continue; // tracked by git but deleted from the working tree
    if (linked) {
      skipped.push({ path, reason: "symlink_escape" });
      continue;
    }
    visible.push(path);
    const kind = classify(path);
    if (!kind) continue;
    const res = readContained(join(repoPath, path), realRoot);
    if (!res) continue;
    if ("skip" in res) {
      skipped.push({ path, reason: res.skip });
      continue;
    }
    const buf = res.buf;
    if (looksBinary(buf)) {
      skipped.push({ path, reason: "binary" });
      continue;
    }
    const text = buf.toString("utf8");
    readable.set(path, text);
    toIndex.set(path, { kind, text });
  }

  const tests = testCommandsDoc(repoPath, readable, fileSet);
  if (tests) toIndex.set("sindri:test-commands", { kind: "test-commands", text: tests });
  toIndex.set("sindri:structure", { kind: "structure", text: structureDoc(visible) });

  const result: BootstrapResult = {
    indexed: [],
    unchanged: [],
    removed: [],
    skipped,
    secretsDropped: [],
  };
  if (listing.unsafeGitConfig) result.unsafeGitConfig = listing.unsafeGitConfig;
  const now = clock().toISOString();
  const existing = new Map(
    (
      db
        .prepare("SELECT id, path, sha256 FROM documents WHERE project_id = ?")
        .all(projectId) as DocRow[]
    ).map((r) => [r.path, r]),
  );
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, project_id, path, kind, sha256, bytes, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateDoc = db.prepare(
    "UPDATE documents SET kind = ?, sha256 = ?, bytes = ?, indexed_at = ? WHERE id = ?",
  );
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
  const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");
  const legacyChunks = db.prepare("SELECT id, text FROM chunks WHERE document_id = ?");
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
  const insertChunk = db.prepare(
    "INSERT INTO chunks (document_id, ordinal, text, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (const [path, { kind, text }] of toIndex) {
      const sha = createHash("sha256").update(text).digest("hex");
      const prev = existing.get(path);
      if (prev && prev.sha256 === sha) {
        // Indexes built before content scanning may still hold secret chunks: drop them.
        for (const c of legacyChunks.all(prev.id) as { id: number; text: string }[]) {
          if (containsSecret(c.text)) deleteChunk.run(c.id);
        }
        result.unchanged.push(path);
        continue;
      }
      let docId: string;
      if (prev) {
        docId = prev.id;
        deleteChunks.run(docId);
        updateDoc.run(kind, sha, Buffer.byteLength(text), now, docId);
      } else {
        docId = randomUUID();
        insertDoc.run(docId, projectId, path, kind, sha, Buffer.byteLength(text), now);
      }
      const secretRanges = secretLineRanges(text);
      for (const c of chunkText(text)) {
        const hit = secretRanges.some((r) => r.start <= c.endLine && r.end >= c.startLine);
        if (hit || containsSecret(c.text)) {
          result.secretsDropped.push({ path, startLine: c.startLine, endLine: c.endLine });
          continue;
        }
        insertChunk.run(docId, c.ordinal, c.text, c.startLine, c.endLine);
      }
      result.indexed.push(path);
    }
    for (const [path, row] of existing) {
      if (toIndex.has(path)) continue;
      deleteChunks.run(row.id);
      deleteDoc.run(row.id);
      result.removed.push(path);
    }
    db.prepare("UPDATE projects SET repo_path = ?, updated_at = ? WHERE id = ?").run(
      repoPath,
      now,
      projectId,
    );
  })();
  return result;
}
