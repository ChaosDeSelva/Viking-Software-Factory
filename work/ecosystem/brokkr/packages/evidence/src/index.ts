import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  BrokkrError,
  VerificationReportSchema,
  canonicalJson,
  ensureSafeDir,
  fileDigest,
  formatIssues,
  sha256Digest,
  validateWith,
  type EvidenceKind,
  type EvidenceReference,
  type VerificationReport,
} from "@brokkr/core";

const exec = promisify(execFile);

/** Run storage root relative to the workspace (spec §10.3). */
export const RUNS_DIR = ".brokkr/runs";
export const EVIDENCE_MANIFEST = "evidence-manifest.json";
export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";
const ARTIFACT_DIRS: ReadonlyArray<{ dir: string; kind: EvidenceKind }> = [
  { dir: "logs", kind: "log" },
  { dir: "test-results", kind: "test-result" },
  { dir: "screenshots", kind: "screenshot" },
];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `run_<ULID>`: 48-bit millisecond timestamp + 80 random bits, Crockford base32. */
export function createRunId(now: Date = new Date()): string {
  let time = now.getTime();
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = "";
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[bytes[i]! % 32];
  return `run_${timePart}${randomPart}`;
}

const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface RunHandle {
  id: string;
  /** Absolute run directory. */
  dir: string;
  /** Absolute log path for a check id. */
  logPath(checkId: string): string;
  /** Directory where a check may write test results (`BROKKR_TEST_RESULTS_DIR`). */
  testResultsDir(checkId: string): string;
  /** Directory where a check may write screenshots (`BROKKR_SCREENSHOTS_DIR`). */
  screenshotsDir(checkId: string): string;
  /**
   * Throw `infra` unless the run directory is still the real directory created
   * for this run: not a symlink, same device and inode, same realpath (so no
   * ancestor such as `.brokkr` was swapped for a symlink). Call before writing
   * anything into the run directory after workspace code has run.
   */
  assertIntact(): Promise<void>;
}

/** Where Brokkr keeps per-user state: `$BROKKR_HOME` or the user's home directory. */
export function defaultBrokkrHome(): string {
  return process.env.BROKKR_HOME ?? homedir();
}

export interface RunStoreOptions {
  /** Home holding `.brokkr/runs` and `.brokkr/key` (default `defaultBrokkrHome()`). */
  home?: string;
  /** Explicit runs root for this workspace (overrides the home-derived default). */
  runsRoot?: string;
}

/**
 * Runs live outside the verified workspace (audit I2):
 * `<home>/.brokkr/runs/<sha256(realpath(workspace))>/`.
 */
export function runsRootFor(workspace: string, home: string = defaultBrokkrHome()): string {
  const key = createHash("sha256").update(realpathSync(workspace)).digest("hex");
  return join(home, ".brokkr", "runs", key);
}

async function ensureRunsRoot(workspace: string, options: RunStoreOptions): Promise<string> {
  if (options.runsRoot) {
    await mkdir(dirname(options.runsRoot), { recursive: true });
    return ensureSafeDir(dirname(options.runsRoot), basename(options.runsRoot));
  }
  const home = options.home ?? defaultBrokkrHome();
  return ensureSafeDir(home, relative(home, runsRootFor(workspace, home)).split(sep).join("/"));
}

function rootFor(workspace: string, options: RunStoreOptions): string {
  return options.runsRoot ?? runsRootFor(workspace, options.home ?? defaultBrokkrHome());
}

/** Create `run_<ulid>/` with `logs/`, `screenshots/` and `test-results/` under the runs root. */
export async function createRun(
  workspace: string,
  options: RunStoreOptions & { runId?: string } = {},
): Promise<RunHandle> {
  const id = options.runId ?? createRunId();
  if (!RUN_ID.test(id)) throw new BrokkrError("invalid-config", `invalid run id '${id}'`);
  const root = await ensureRunsRoot(workspace, options);
  const dir = await ensureSafeDir(root, id);
  for (const { dir: sub } of ARTIFACT_DIRS) await ensureSafeDir(dir, sub);
  const created = await lstat(dir); // ensureSafeDir guarantees a real directory
  const createdReal = await realpath(dir);
  return {
    id,
    dir,
    assertIntact: async () => {
      const now = await lstat(dir).catch(() => undefined);
      const real = await realpath(dir).catch(() => undefined);
      if (
        now === undefined ||
        now.isSymbolicLink() ||
        !now.isDirectory() ||
        now.dev !== created.dev ||
        now.ino !== created.ino ||
        real !== createdReal
      )
        throw new BrokkrError(
          "infra",
          `run directory ${dir} was replaced or moved during verification; refusing to write evidence there`,
        );
    },
    logPath: (checkId) => join(dir, "logs", `${checkId}.log`),
    testResultsDir: (checkId) => join(dir, "test-results", checkId),
    screenshotsDir: (checkId) => join(dir, "screenshots", checkId),
  };
}

/** Per-installation HMAC key at `<home>/.brokkr/key` (32 bytes, mode 0600, created on first use). */
export async function signingKey(home: string = defaultBrokkrHome()): Promise<Buffer> {
  const dir = await ensureSafeDir(home, ".brokkr");
  const file = join(dir, "key");
  let st = await lstat(file).catch(() => undefined);
  if (st === undefined) {
    try {
      await writeFile(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    st = await lstat(file);
  }
  if (!st.isFile())
    throw new BrokkrError(
      "policy-denied",
      `${file} is not a regular file; refusing to use it as the signing key`,
    );
  if ((st.mode & 0o077) !== 0)
    throw new BrokkrError(
      "policy-denied",
      `${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`,
    );
  const key = Buffer.from((await readFile(file, "utf8")).trim(), "hex");
  if (key.length !== 32) throw new BrokkrError("integrity", `${file} is not a valid signing key`);
  return key;
}

function manifestSignature(key: Buffer, manifest: Omit<EvidenceManifest, "signature">): string {
  const body = canonicalJson({
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    workspaceKey: manifest.workspaceKey,
    runsRoot: manifest.runsRoot,
    artifacts: manifest.artifacts,
  });
  return `hmac-sha256:${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** Workspace identity: sha256 of the canonical (realpath) workspace path. */
export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(realpathSync(workspace)).digest("hex");
}

/** Creation time embedded in a run id (ULID). */
export function runIdTime(id: string): number {
  let ms = 0;
  for (const c of id.slice(4, 14)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}

export interface RepositoryState {
  commitSha: string;
  dirtyTreeDigest?: string;
  warnings: string[];
}

/** Workspace paths never covered by the tree digest (Brokkr's own state). */
// Runs no longer live in the workspace, so a workspace `.brokkr/runs` is ordinary content.
const DIGEST_EXCLUDES = new Set([".git", ".brokkr/cache/sources"]);

/**
 * Environment for every git invocation: nothing from the caller (no GIT_* or
 * secrets), no system/global config, no prompts.
 */
export function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

/** Overrides for repo-controlled config that could execute commands. */
export const GIT_SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.untrackedCache=false",
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...GIT_SAFE_CONFIG, ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Content digest of the whole working tree by directory walk (tracked,
 * untracked and ignored files alike, including node_modules). Symlinks are
 * hashed by their target and never followed; `.git` and Brokkr state are
 * excluded.
 */
export async function workspaceTreeDigest(workspace: string): Promise<string> {
  const root = await realpath(workspace);
  const hash = createHash("sha256");
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (DIGEST_EXCLUDES.has(childRel)) continue;
      const abs = join(dir, entry.name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) hash.update(`L\0${childRel}\0${await readlink(abs)}\n`);
      else if (st.isDirectory()) await walk(abs, childRel);
      else if (st.isFile()) {
        hash.update(`F\0${childRel}\0${st.mode & 0o111 ? "x" : "-"}\0${await fileDigest(abs)}\n`);
      } else hash.update(`O\0${childRel}\n`);
    }
  };
  await walk(root, "");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Identify the exact repository state (spec §10.2): HEAD from git (run with a
 * scrubbed environment and command-executing config disabled; no status or
 * diff, so no filters, textconv or fsmonitor run) plus `workspaceTreeDigest`.
 */
export async function repositoryState(workspace: string): Promise<RepositoryState> {
  const warnings: string[] = [];
  let commitSha = "unversioned";
  try {
    await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
    commitSha =
      (await git(workspace, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() ||
      "unborn";
  } catch {
    warnings.push(`${workspace} is not a git repository; only the tree digest identifies it`);
  }
  return { commitSha, dirtyTreeDigest: await workspaceTreeDigest(workspace), warnings };
}

export type ManifestArtifact = EvidenceReference;

export interface EvidenceManifest {
  schemaVersion: "1.0";
  runId: string;
  artifacts: ManifestArtifact[];
  /** sha256 of the canonical workspace path the run verified (fix round 2, I4). */
  workspaceKey?: string;
  /** Canonical runs root the run was written into. */
  runsRoot?: string;
  /** HMAC-SHA256 of the manifest (including workspaceKey and runsRoot) with the installation key. */
  signature?: string;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links out of the run directory
    if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out.sort();
}

async function reference(
  runDir: string,
  abs: string,
  kind: EvidenceKind,
  producedBy: string,
): Promise<EvidenceReference> {
  const st = await stat(abs);
  return {
    path: toPosix(relative(runDir, abs)),
    sha256: await fileDigest(abs),
    bytes: st.size,
    producedBy,
    kind,
  };
}

/** Hash every artifact in `logs/`, `test-results/` and `screenshots/` (symlinks skipped). */
export async function collectArtifacts(runDir: string): Promise<EvidenceReference[]> {
  const refs: EvidenceReference[] = [];
  for (const { dir, kind } of ARTIFACT_DIRS) {
    for (const abs of await walkFiles(join(runDir, dir))) {
      const rel = toPosix(relative(join(runDir, dir), abs));
      const producedBy =
        kind === "log" ? rel.replace(/\.log$/, "") : (rel.split("/")[0] ?? "brokkr");
      refs.push(await reference(runDir, abs, kind, producedBy));
    }
  }
  return refs;
}

/**
 * Finish a run: hash artifacts into `report.evidence`, write `report.json`,
 * optional `report.md`, and `evidence-manifest.json` covering all of them.
 */
export async function finalizeRun(
  runDir: string,
  report: VerificationReport,
  options: {
    markdown?: (report: VerificationReport) => string;
    home?: string;
    key?: Buffer;
    /** The verified workspace; its identity and the runs root are bound into the signature. */
    workspace?: string;
  } = {},
): Promise<VerificationReport> {
  const key = options.key ?? (await signingKey(options.home));
  const evidence = await collectArtifacts(runDir);
  const final: VerificationReport = { ...report, evidence };
  const valid = validateWith(VerificationReportSchema, final);
  if (!valid.ok)
    throw new BrokkrError(
      "infra",
      `refusing to write an invalid report:\n${formatIssues(valid.issues)}`,
    );
  await writeFile(join(runDir, REPORT_JSON), `${JSON.stringify(final, null, 2)}\n`);
  const artifacts = [
    ...evidence,
    await reference(runDir, join(runDir, REPORT_JSON), "report", "brokkr"),
  ];
  if (options.markdown) {
    await writeFile(join(runDir, REPORT_MD), options.markdown(final));
    artifacts.push(await reference(runDir, join(runDir, REPORT_MD), "report", "brokkr"));
  }
  const unsigned = {
    schemaVersion: "1.0" as const,
    runId: report.id,
    ...(options.workspace ? { workspaceKey: workspaceKey(options.workspace) } : {}),
    runsRoot: realpathSync(dirname(runDir)),
    artifacts,
  };
  const manifest: EvidenceManifest = { ...unsigned, signature: manifestSignature(key, unsigned) };
  await writeFile(join(runDir, EVIDENCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return final;
}

export interface IntegrityResult {
  status: "ok" | "integrity_failed";
  problems: string[];
}

export interface StoredReport {
  report: VerificationReport;
  dir: string;
  integrity: IntegrityResult;
}

/**
 * Read a stored report and re-hash every artifact listed in its evidence
 * manifest (spec §10.4). Problems flag `integrity_failed`; with `strict` they
 * throw an `integrity` error instead.
 */
export async function readReport(
  runDir: string,
  options: {
    strict?: boolean;
    home?: string;
    key?: Buffer;
    now?: Date;
    /** When given, the run must belong to this workspace. */
    workspace?: string;
  } = {},
): Promise<StoredReport> {
  const reportPath = join(runDir, REPORT_JSON);
  if (!existsSync(reportPath)) throw new BrokkrError("not-found", `no ${REPORT_JSON} in ${runDir}`);
  const text = await readFile(reportPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BrokkrError(
      "integrity",
      `${reportPath} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const valid = validateWith(VerificationReportSchema, parsed, REPORT_JSON);
  if (!valid.ok)
    throw new BrokkrError("integrity", `invalid ${REPORT_JSON}:\n${formatIssues(valid.issues)}`);
  const report = valid.value;
  const problems: string[] = [];

  const manifestPath = join(runDir, EVIDENCE_MANIFEST);
  let manifest: EvidenceManifest | undefined;
  if (!existsSync(manifestPath)) problems.push(`${EVIDENCE_MANIFEST} is missing`);
  else {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvidenceManifest;
    } catch {
      problems.push(`${EVIDENCE_MANIFEST} is not valid JSON`);
    }
  }
  if (manifest && !Array.isArray(manifest.artifacts)) {
    problems.push(`${EVIDENCE_MANIFEST} has no artifact list`);
    manifest = undefined;
  }
  if (manifest) {
    if (!manifest.signature) problems.push(`${EVIDENCE_MANIFEST} is unsigned`);
    else {
      const key = options.key ?? (await signingKey(options.home));
      const expected = manifestSignature(key, manifest);
      const a = Buffer.from(manifest.signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        problems.push(
          `${EVIDENCE_MANIFEST}: signature mismatch (not signed by this installation's key)`,
        );
    }
    if (manifest.runId !== report.id) problems.push("manifest run id does not match the report");
    if (!manifest.workspaceKey || !manifest.runsRoot)
      problems.push(
        "manifest does not bind a workspace and runs root (written by an older Brokkr)",
      );
    else {
      if (manifest.runsRoot !== realpathSync(dirname(runDir)))
        problems.push(
          `run was signed in another runs root (${manifest.runsRoot}); it has been moved or copied`,
        );
      if (options.workspace && manifest.workspaceKey !== workspaceKey(options.workspace))
        problems.push("run belongs to another workspace");
    }
    const listed = new Map(manifest.artifacts.map((a) => [a.path, a]));
    if (!listed.has(REPORT_JSON)) problems.push(`${REPORT_JSON} is not listed in the manifest`);
    for (const e of report.evidence) {
      const m = listed.get(e.path);
      if (!m || m.sha256 !== e.sha256)
        problems.push(`${e.path}: report evidence does not match the manifest`);
    }
    for (const artifact of manifest.artifacts) {
      const abs = join(runDir, artifact.path);
      if (relative(runDir, abs).startsWith("..")) {
        problems.push(`${artifact.path}: path escapes the run directory`);
        continue;
      }
      if (!existsSync(abs)) {
        problems.push(`${artifact.path}: missing`);
        continue;
      }
      const actual = await fileDigest(abs);
      if (actual !== artifact.sha256)
        problems.push(
          `${artifact.path}: digest mismatch (recorded ${artifact.sha256}, actual ${actual})`,
        );
    }
  }
  if (runIdTime(report.id) > (options.now ?? new Date()).getTime() + 5 * 60_000)
    problems.push(`run id ${report.id} is dated in the future`);
  if (basename(runDir) !== report.id)
    problems.push("run directory name does not match the report id");
  const integrity: IntegrityResult = {
    status: problems.length === 0 ? "ok" : "integrity_failed",
    problems,
  };
  if (options.strict && problems.length > 0) {
    throw new BrokkrError(
      "integrity",
      `run ${report.id} failed integrity validation:\n${problems.join("\n")}`,
      {
        details: { problems },
      },
    );
  }
  return { report, dir: runDir, integrity };
}

export interface RunSummary {
  id: string;
  dir: string;
  verdict?: VerificationReport["verdict"];
  startedAt?: string;
  completedAt?: string;
  /** Modification time of the run directory (used for retention). */
  mtimeMs: number;
  /** Signature and digest check of the stored run. */
  integrity: IntegrityResult["status"];
}

/**
 * Runs for a workspace, newest first. Unsigned, tampered or forged runs are
 * omitted unless `includeInvalid` is set (they then carry `integrity_failed`).
 */
export async function listRuns(
  workspace: string,
  options: RunStoreOptions & { includeInvalid?: boolean } = {},
): Promise<RunSummary[]> {
  const root = rootFor(workspace, options);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return [];
  const key = await signingKey(options.home);
  const runs: RunSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const summary: RunSummary = {
      id: entry.name,
      dir,
      mtimeMs: (await lstat(dir)).mtimeMs,
      integrity: "integrity_failed",
    };
    try {
      const stored = await readReport(dir, { key, workspace });
      summary.integrity = stored.integrity.status;
      summary.verdict = stored.report.verdict;
      summary.startedAt = stored.report.startedAt;
      summary.completedAt = stored.report.completedAt;
    } catch {
      // unreadable report: invalid
    }
    if (summary.integrity === "ok" || options.includeInvalid) runs.push(summary);
  }
  return runs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Newest run whose signature and digests verify. */
export async function latestRun(
  workspace: string,
  options: RunStoreOptions = {},
): Promise<RunSummary | undefined> {
  return (await listRuns(workspace, options))[0];
}

/**
 * Retention: keep the newest `keep` runs and/or remove runs older than
 * `olderThanMs`. Invalid runs are pruned too; symlinks and anything resolving
 * outside the runs root are never touched (audit I6).
 */
export async function pruneRuns(
  workspace: string,
  options: RunStoreOptions & { keep?: number; olderThanMs?: number; now?: Date },
): Promise<{ removed: string[]; kept: string[] }> {
  if (options.keep === undefined && options.olderThanMs === undefined)
    throw new BrokkrError("invalid-config", "prune needs --keep <n> or --older-than <duration>");
  const now = (options.now ?? new Date()).getTime();
  const root = rootFor(workspace, options);
  const rootStat = await lstat(root).catch(() => undefined);
  if (rootStat?.isSymbolicLink())
    throw new BrokkrError("policy-denied", `${root} is a symlink; refusing to prune through it`);
  const realRoot = rootStat ? await realpath(root) : root;
  const runs = await listRuns(workspace, { ...options, includeInvalid: true });
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [index, run] of runs.entries()) {
    const tooMany = options.keep !== undefined && index >= options.keep;
    const tooOld = options.olderThanMs !== undefined && now - run.mtimeMs > options.olderThanMs;
    if (!(tooMany || tooOld)) {
      kept.push(run.id);
      continue;
    }
    const st = await lstat(run.dir);
    const real = await realpath(run.dir);
    if (st.isSymbolicLink() || !st.isDirectory() || dirname(real) !== realRoot) {
      kept.push(run.id);
      continue;
    }
    await rm(run.dir, { recursive: true, force: true });
    removed.push(run.id);
  }
  return { removed, kept };
}

/** Digest helper re-exported for callers hashing in-memory evidence. */
export const digestText = (text: string): string => sha256Digest(text);
