import { existsSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import semver from "semver";
import {
  BROKKR_VERSION,
  ensureSafeDir,
  fileDigest,
  treeDigest,
  type ComposedHarness,
  type ExternalSource,
  type HarnessLock,
  type LoadedHarness,
  type LoadedSkill,
  type ProjectConfig,
  type ResolvedHarnessSet,
  type SourceKind,
} from "@brokkr/core";
import { composeHarnessSet } from "./compose.js";
import { LOCK_FILE, ensureBrokkrDir, loadProjectConfig } from "./config.js";
import { discoverHarnessDirs, validateHarnessDir, type HarnessValidation } from "./load.js";
import { createLock, verifyLockAgainst, type AdapterRef, type LockVerification } from "./lock.js";
import { resolveHarnessSet, type ResolveRequest } from "./resolve.js";
import { extractTarball, inspectTarball } from "./tarball.js";

export interface RegistryOptions {
  /** Repository root; project-local harnesses live in `<cwd>/.brokkr/harnesses`. */
  cwd: string;
  /** Built-in harness library bundled with the CLI. */
  builtinDir?: string;
  /** Home directory for user-local harnesses (`<home>/.brokkr/harnesses`). Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Project config; read from `.brokkr/config.yaml` when omitted. */
  config?: ProjectConfig;
  /** Platform used for compatibility checks in `resolve`. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Trust for harnesses in `<cwd>/.brokkr/harnesses`. `untrusted` when the
   * workspace itself is not trusted (e.g. an agent's worktree): they then
   * resolve only with `allowUntrusted` and never execute (audit C1).
   */
  projectHarnessTrust?: "trusted" | "untrusted";
  /** Running Brokkr version for `compatibility.brokkr` checks. */
  brokkrVersion?: string;
  /**
   * When false, nothing under `cwd` is a harness source: no project-local
   * `.brokkr/harnesses` and no `sources` from the project config. Used when the
   * repository is not trusted to define its own verification contract.
   * Default true.
   */
  projectSources?: boolean;
  /**
   * When set, a user, project or external harness whose name equals a built-in
   * harness name is dropped (diagnostic `shadow_refused`), whatever its version,
   * unless its `name@version` is listed in `allow`.
   */
  refuseShadowing?: { allow?: readonly string[] };
}

export interface RegistryDiagnostic {
  code:
    | "invalid"
    | "shadowed"
    | "shadow_refused"
    | "integrity"
    | "source-error"
    | "unsafe-archive"
    | "tampered";
  source: string;
  message: string;
}

export interface SourceSummary {
  kind: SourceKind;
  ref: string;
  location: string;
  trusted: boolean;
  digest?: string;
  harnesses: number;
  /** Set when an extracted tarball cache no longer matched its archive. */
  tampered?: boolean;
}

/**
 * Harness registry over four sources in precedence order (spec §5.1):
 * built-in, user-local, project-local, then pinned external packages. When the
 * same `name@version` appears in several sources the higher-precedence one wins
 * and a `shadowed` diagnostic is recorded.
 */
export class Registry {
  readonly cwd: string;
  private readonly options: RegistryOptions;
  private entries: LoadedHarness[] = [];
  private sourceSummaries: SourceSummary[] = [];
  diagnostics: RegistryDiagnostic[] = [];

  constructor(options: RegistryOptions) {
    this.options = options;
    this.cwd = resolve(options.cwd);
  }

  async load(): Promise<void> {
    this.entries = [];
    this.diagnostics = [];
    this.sourceSummaries = [];
    const config =
      this.options.config ??
      (this.options.projectSources === false ? undefined : await loadProjectConfig(this.cwd));
    const home = this.options.homeDir ?? homedir();
    if (this.options.builtinDir)
      await this.loadRoot("builtin", "builtin", this.options.builtinDir, true);
    await this.loadRoot("user", "user", join(home, ".brokkr", "harnesses"), true);
    if (this.options.projectSources !== false) {
      await this.loadRoot(
        "project",
        "project",
        join(this.cwd, ".brokkr", "harnesses"),
        this.options.projectHarnessTrust !== "untrusted",
      );
      for (const source of config?.sources ?? []) await this.loadExternal(source);
    }
    this.refuseShadowing();
  }

  private refuseShadowing(): void {
    const rule = this.options.refuseShadowing;
    if (!rule) return;
    const allow = new Set(rule.allow ?? []);
    const builtin = new Set(
      this.entries.filter((e) => e.source === "builtin").map((e) => e.manifest.metadata.name),
    );
    this.entries = this.entries.filter((e) => {
      const { name, version } = e.manifest.metadata;
      if (e.source === "builtin" || !builtin.has(name) || allow.has(`${name}@${version}`))
        return true;
      this.diagnostics.push({
        code: "shadow_refused",
        source: e.sourceRef,
        message: `${name}@${version} from ${e.sourceRef} would shadow the built-in harness '${name}'; ignored (pin it in the lock to allow)`,
      });
      return false;
    });
  }

  private async loadRoot(
    kind: SourceKind,
    ref: string,
    root: string,
    trusted: boolean,
    digest?: string,
    tampered = false,
  ): Promise<void> {
    const dirs = await discoverHarnessDirs(root);
    let count = 0;
    for (const dir of dirs) {
      const result = await validateHarnessDir(dir);
      if (!result.pkg) {
        this.diagnostics.push({
          code: "invalid",
          source: dir,
          message: result.issues
            .map((i) => `${i.file ?? ""}${i.file ? ":" : ""}${i.path}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      const { manifest } = result.pkg;
      const key = `${manifest.metadata.name}@${manifest.metadata.version}`;
      const existing = this.entries.find(
        (e) => `${e.manifest.metadata.name}@${e.manifest.metadata.version}` === key,
      );
      if (existing) {
        this.diagnostics.push({
          code: "shadowed",
          source: dir,
          message: `${key} from ${ref} is shadowed by ${existing.sourceRef} (${existing.dir})`,
        });
        continue;
      }
      this.entries.push({
        ...result.pkg,
        source: kind,
        sourceRef: ref,
        trust: trusted ? "trusted" : "untrusted",
      });
      count++;
    }
    this.sourceSummaries.push({
      kind,
      ref,
      location: root,
      trusted,
      harnesses: count,
      ...(digest ? { digest } : {}),
      ...(tampered ? { tampered } : {}),
    });
  }

  private async loadExternal(source: ExternalSource): Promise<void> {
    if ("path" in source) {
      const dir = resolve(this.cwd, source.path);
      const ref = `external:${source.path}`;
      if (!existsSync(dir)) {
        this.diagnostics.push({
          code: "source-error",
          source: ref,
          message: `source path ${dir} does not exist`,
        });
        return;
      }
      let actual: string;
      try {
        actual = await treeDigest(dir);
      } catch (error) {
        this.diagnostics.push({
          code: "integrity",
          source: ref,
          message: (error as Error).message,
        });
        return;
      }
      // A changed tree keeps its harnesses visible (list/inspect) but they lose
      // trust: resolve refuses them and nothing they define can execute.
      const tampered = actual !== source.digest;
      if (tampered) {
        this.diagnostics.push({
          code: "tampered",
          source: ref,
          message: `TAMPERED: digest mismatch for ${source.path}: pinned ${source.digest}, actual ${actual}; loaded as untrusted`,
        });
      }
      await this.loadRoot(
        "external",
        ref,
        dir,
        source.trusted && !tampered,
        source.digest,
        tampered,
      );
      return;
    }
    const ref = `external:${source.tarball}`;
    const file = resolve(this.cwd, source.tarball);
    if (!existsSync(file)) {
      this.diagnostics.push({
        code: "source-error",
        source: ref,
        message: `tarball ${file} does not exist`,
      });
      return;
    }
    const actual = await fileDigest(file);
    if (actual !== source.digest) {
      this.diagnostics.push({
        code: "integrity",
        source: ref,
        message: `digest mismatch for ${source.tarball}: pinned ${source.digest}, actual ${actual}`,
      });
      return;
    }
    const inspection = inspectTarball(file);
    if (inspection.problems.length > 0) {
      this.diagnostics.push({
        code: "unsafe-archive",
        source: ref,
        message: `unsafe archive ${source.tarball}, refusing to extract: ${inspection.problems.join("; ")}`,
      });
      return;
    }
    // Always extract afresh from the verified tarball, then compare with the
    // cache: anything that edited the cache since the last load is tampering.
    await ensureBrokkrDir(this.cwd);
    const hex = actual.slice("sha256:".length);
    // Every component below the workspace is lstat-checked: never extract through a symlink.
    const cacheRoot = await ensureSafeDir(this.cwd, ".brokkr/cache/sources");
    const dest = join(cacheRoot, hex);
    const staging = join(cacheRoot, `.staging-${hex}-${process.pid}-${Date.now()}`);
    let freshDigest: string;
    try {
      await extractTarball(file, staging);
      freshDigest = await treeDigest(staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      this.diagnostics.push({
        code: "source-error",
        source: ref,
        message: (error as Error).message,
      });
      return;
    }
    let tampered = false;
    if (existsSync(dest)) {
      let cached: string;
      try {
        cached = await treeDigest(dest);
      } catch (error) {
        cached = `unreadable: ${(error as Error).message}`;
      }
      tampered = cached !== freshDigest;
      if (tampered) {
        this.diagnostics.push({
          code: "tampered",
          source: ref,
          message: `TAMPERED: extracted cache ${dest} no longer matches ${source.tarball} (cache ${cached}, archive ${freshDigest}); restored from the archive and marked untrusted`,
        });
      }
      await rm(dest, { recursive: true, force: true });
    }
    await rename(staging, dest);
    const root = inspection.topLevel ? join(dest, inspection.topLevel) : dest;
    await this.loadRoot(
      "external",
      ref,
      root,
      source.trusted && !tampered,
      source.digest,
      tampered,
    );
  }

  /** All loaded harnesses, sorted by name then version (descending). */
  list(): LoadedHarness[] {
    return [...this.entries].sort((a, b) => {
      const n = a.manifest.metadata.name.localeCompare(b.manifest.metadata.name);
      return n !== 0
        ? n
        : semver.rcompare(a.manifest.metadata.version, b.manifest.metadata.version);
    });
  }

  /** Every skill shipped by any loaded harness. */
  skills(): LoadedSkill[] {
    return this.list().flatMap((h) => h.skills);
  }

  sources(): SourceSummary[] {
    return [...this.sourceSummaries];
  }

  /** Highest version of `name` (optionally within `range`). */
  inspect(name: string, range = "*"): LoadedHarness | undefined {
    return this.list().find(
      (h) =>
        h.manifest.metadata.name === name && semver.satisfies(h.manifest.metadata.version, range),
    );
  }

  /** Validate an arbitrary harness package directory without registering it. */
  async validate(dir: string): Promise<HarnessValidation> {
    const result: HarnessValidation & { pkg?: unknown } = await validateHarnessDir(
      resolve(this.cwd, dir),
    );
    delete result.pkg;
    return result;
  }

  resolve(request: ResolveRequest): ResolvedHarnessSet {
    return resolveHarnessSet(this.entries, request, {
      platform: this.options.platform ?? process.platform,
      brokkrVersion: this.options.brokkrVersion ?? BROKKR_VERSION,
    });
  }

  compose(set: ResolvedHarnessSet): ComposedHarness {
    return composeHarnessSet(set);
  }

  /** Create the lock for `set` and write it to `<cwd>/.brokkr/harness.lock.json`. */
  async writeLock(
    set: ResolvedHarnessSet,
    adapters: readonly AdapterRef[],
  ): Promise<{ lock: HarnessLock; path: string }> {
    const lock = createLock(set, adapters);
    const path = join(this.cwd, LOCK_FILE);
    await ensureBrokkrDir(this.cwd);
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
    return { lock, path };
  }

  /** Recompute digests from disk; reports `modified` and `missing` entries. */
  async verifyLock(lock: HarnessLock): Promise<LockVerification> {
    return verifyLockAgainst(lock, this.entries);
  }
}
