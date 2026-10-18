import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BrokkrError,
  HarnessLockSchema,
  PolicyLayerSchema,
  ProfileSchema,
  ProjectConfigSchema,
  fileDigest,
  formatIssues,
  parseManifestText,
  validateWith,
  type ApprovedException,
  type ComposedHarness,
  type HarnessLock,
  type PolicyLayer,
  type PolicySource,
  type Profile,
  type ProjectConfig,
  type ResolvedHarnessSet,
} from "@brokkr/core";
import {
  EXCEPTIONS_FILE,
  ORG_POLICY_FILE,
  loadExceptionsFile,
  loadOrgPolicy,
  loadPolicyFile,
  type PolicyLayerInput,
} from "@brokkr/policy";
import { CONFIG_FILE, LOCK_FILE, Registry, createLock } from "@brokkr/registry";

/**
 * `developer`: a developer verifying their own repository; the workspace may
 * supply config, lock, exceptions and policy. `workspace-untrusted`: the
 * workspace is the work under test (e.g. an agent's worktree); everything that
 * defines "verified" comes from the caller or the user config dir (ADR-003).
 */
export type TrustMode = "developer" | "workspace-untrusted";

export interface ContractOptions {
  /** Absolute workspace to verify. */
  workspace: string;
  /** Default `workspace-untrusted` (library default; the CLI defaults to `developer`). */
  trust?: TrustMode;
  /** Brokkr home: user harnesses, org policy and, in untrusted mode, default config/lock/exceptions. */
  home: string;
  builtinDir?: string;
  /** Caller-supplied inputs (files or objects). */
  configFile?: string;
  config?: ProjectConfig;
  lockFile?: string;
  lock?: HarnessLock;
  exceptionsFile?: string;
  exceptions?: ApprovedException[];
  policyFile?: string;
  policy?: PolicyLayer;
  profile?: string;
  /** Approver identities trusted by the caller (required for exceptions in untrusted mode). */
  approvers?: string[];
}

export interface Contract {
  trustMode: TrustMode;
  set: ResolvedHarnessSet;
  composed: ComposedHarness;
  profile?: Profile;
  projectId?: string;
  lockDigest: string;
  /** Lock problems; any entry blocks the run. */
  lockProblems: string[];
  layers: PolicyLayerInput[];
  exceptions: ApprovedException[];
  approvers?: string[];
  policySources: PolicySource[];
  warnings: string[];
}

async function insideWorkspace(workspace: string, file: string): Promise<boolean> {
  const root = await realpath(workspace);
  const real = await realpath(file).catch(() => resolve(file));
  const rel = relative(root, real);
  // `..x/file` is a directory named "..x" inside the workspace, not a parent reference.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function source(
  workspace: string,
  kind: PolicySource["kind"],
  file: string,
): Promise<PolicySource> {
  const root = await realpath(workspace);
  const real = await realpath(file);
  const rel = relative(root, real);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return {
    kind,
    path: inside ? rel.split(sep).join("/") : real,
    origin: inside ? "workspace_supplied" : "external",
    digest: await fileDigest(real),
  };
}

async function parseFile<T>(
  file: string,
  schema: Parameters<typeof parseManifestText>[1],
): Promise<T> {
  if (!existsSync(file)) throw new BrokkrError("invalid-config", `${file} does not exist`);
  const parsed = parseManifestText(await readFile(file, "utf8"), schema, file);
  if (!parsed.ok)
    throw new BrokkrError("invalid-config", `invalid ${file}:\n${formatIssues(parsed.issues)}`);
  return parsed.value as T;
}

async function builtinProfile(
  builtinDir: string | undefined,
  name: string,
): Promise<Profile | undefined> {
  if (!builtinDir) return undefined;
  for (const ext of ["yaml", "yml", "json"]) {
    const file = join(builtinDir, "profiles", `${name}.${ext}`);
    if (existsSync(file)) return parseFile<Profile>(file, ProfileSchema);
  }
  return undefined;
}

/** Lock problems: modified/missing entries and resolved harnesses the lock does not pin. */
export async function lockProblemsFor(
  registry: Registry,
  lock: HarnessLock,
  set: ResolvedHarnessSet,
): Promise<string[]> {
  const problems: string[] = [];
  const verification = await registry.verifyLock(lock);
  for (const e of verification.entries) {
    if (e.status === "ok") continue;
    problems.push(
      e.kind === "lock"
        ? `${e.name} ${e.status} (content digest does not match)`
        : `${e.kind} ${e.name}@${e.version} ${e.status}`,
    );
  }
  for (const h of set.harnesses) {
    const { name, version } = h.manifest.metadata;
    const locked = lock.harnesses.find((l) => l.name === name);
    if (!locked) problems.push(`harness ${name}@${version} is not pinned by the lockfile`);
    else if (locked.version !== version)
      problems.push(`harness ${name} is locked at ${locked.version} but resolved ${version}`);
    else if (locked.digest !== h.digest) {
      const msg = `harness ${name}@${version} modified`;
      if (!problems.includes(msg)) problems.push(msg);
    }
  }
  return problems;
}

/**
 * Load the verification contract (harness set, lock, policy layers,
 * exceptions) according to the trust mode. In `workspace-untrusted` mode
 * nothing is read from the workspace: inputs come from the caller or from
 * `<home>/.brokkr`, caller paths inside the workspace are refused, workspace
 * harnesses are untrusted, and a missing lock is a lock problem (blocks).
 */
export async function loadContract(options: ContractOptions): Promise<Contract> {
  const trust: TrustMode = options.trust ?? "workspace-untrusted";
  const untrusted = trust === "workspace-untrusted";
  const ws = options.workspace;
  const userDir = join(options.home, ".brokkr");
  const warnings: string[] = [];
  const policySources: PolicySource[] = [];

  const callerFile = async (
    file: string | undefined,
    what: string,
  ): Promise<string | undefined> => {
    if (file === undefined) return undefined;
    const abs = resolve(ws, file);
    if (untrusted && (await insideWorkspace(ws, abs)))
      throw new BrokkrError(
        "invalid-config",
        `${what} ${abs} is inside the verified workspace; in workspace-untrusted mode it must come from the caller`,
      );
    return abs;
  };
  const userDefault = (name: string): string | undefined => {
    const file = join(userDir, name);
    return untrusted && existsSync(file) ? file : undefined;
  };

  if (untrusted) {
    for (const f of [CONFIG_FILE, LOCK_FILE, EXCEPTIONS_FILE])
      if (existsSync(join(ws, f)))
        warnings.push(
          `workspace ${f} ignored (workspace-untrusted mode reads only caller-supplied inputs)`,
        );
  }

  // Config
  let config = options.config;
  const configFile =
    (await callerFile(options.configFile, "config")) ??
    (untrusted ? userDefault("config.yaml") : undefined);
  if (!config && configFile)
    config = await parseFile<ProjectConfig>(configFile, ProjectConfigSchema);
  if (!config && !untrusted && existsSync(join(ws, CONFIG_FILE)))
    config = await parseFile<ProjectConfig>(join(ws, CONFIG_FILE), ProjectConfigSchema);
  if (!config) {
    throw new BrokkrError(
      "invalid-config",
      untrusted
        ? `workspace-untrusted mode needs a caller-supplied config (--config <file> outside the workspace, or ${join(userDir, "config.yaml")}); the workspace's ${CONFIG_FILE} is never read`
        : `no ${CONFIG_FILE} found; run \`brokkr init\` or \`brokkr harness add <name>\` first`,
    );
  }

  // Profile: a configured profile may never shadow a built-in one.
  let profile: Profile | undefined;
  for (const p of config.profiles ?? []) {
    if (await builtinProfile(options.builtinDir, p.name))
      throw new BrokkrError(
        "invalid-config",
        `config profile '${p.name}' shadows the built-in profile of the same name; rename it`,
      );
  }
  if (options.profile) {
    profile =
      config.profiles?.find((p) => p.name === options.profile) ??
      (await builtinProfile(options.builtinDir, options.profile));
    if (!profile)
      throw new BrokkrError(
        "not-found",
        `profile '${options.profile}' is not defined in the config or the built-in profiles`,
      );
  }

  // Harnesses
  const registry = new Registry({
    cwd: ws,
    ...(options.builtinDir ? { builtinDir: options.builtinDir } : {}),
    homeDir: options.home,
    config,
    projectHarnessTrust: untrusted ? "untrusted" : "trusted",
  });
  await registry.load();
  const requests = profile?.harnesses ?? config.harnesses;
  let set: ResolvedHarnessSet;
  try {
    set = registry.resolve({
      harnesses: requests.map((h) => ({ name: h.name, range: h.version })),
    });
  } catch (error) {
    const invalid = registry.diagnostics.filter((d) => d.code !== "shadowed");
    if (error instanceof BrokkrError && invalid.length > 0) {
      throw new BrokkrError(
        error.code,
        `${error.message}\nregistry diagnostics:\n${invalid.map((d) => `  ${d.source}: ${d.message}`).join("\n")}`,
        { ...(error.details ? { details: error.details } : {}), cause: error },
      );
    }
    throw error;
  }
  const composed = registry.compose(set);
  warnings.push(...composed.warnings);

  // Lock
  let lock = options.lock;
  const lockFile =
    (await callerFile(options.lockFile, "lock")) ??
    (untrusted ? userDefault("harness.lock.json") : undefined);
  if (!lock && lockFile) lock = await parseFile<HarnessLock>(lockFile, HarnessLockSchema);
  if (!lock && !untrusted && existsSync(join(ws, LOCK_FILE)))
    lock = await parseFile<HarnessLock>(join(ws, LOCK_FILE), HarnessLockSchema);
  const lockProblems: string[] = [];
  if (lock) lockProblems.push(...(await lockProblemsFor(registry, lock, set)));
  else if (untrusted)
    lockProblems.push(
      "no lock supplied by the caller (--lock): workspace-untrusted mode requires pinned harness versions and digests",
    );
  else
    warnings.push(`no ${LOCK_FILE}: harness versions are not pinned (run \`brokkr harness lock\`)`);
  const lockDigest = lock?.digest ?? createLock(set, []).digest;

  // Exceptions
  let exceptions = options.exceptions ?? [];
  const exceptionsFile =
    (await callerFile(options.exceptionsFile, "exceptions file")) ??
    (untrusted
      ? userDefault("exceptions.yaml")
      : existsSync(join(ws, EXCEPTIONS_FILE))
        ? join(ws, EXCEPTIONS_FILE)
        : undefined);
  if (!options.exceptions && exceptionsFile) {
    exceptions = await loadExceptionsFile(exceptionsFile);
    policySources.push(await source(ws, "exceptions", exceptionsFile));
  }

  // Policy layers
  const layers: PolicyLayerInput[] = [];
  const org = await loadOrgPolicy(options.home);
  if (org) {
    layers.push({ layer: "organization", policy: org });
    policySources.push(
      await source(ws, "organization-policy", join(options.home, ORG_POLICY_FILE)),
    );
  }
  const policyFile = await callerFile(options.policyFile, "policy file");
  if (options.policy) layers.push({ layer: "project", policy: options.policy });
  else if (policyFile) {
    layers.push({ layer: "project", policy: await loadPolicyFile(policyFile) });
    policySources.push(await source(ws, "project-policy", policyFile));
    if (config.policies)
      warnings.push("config policies were ignored because a policy file was given");
  } else if (config.policies) {
    layers.push({ layer: "project", policy: config.policies });
    if (configFile) policySources.push(await source(ws, "project-policy", configFile));
    else if (!untrusted && existsSync(join(ws, CONFIG_FILE)))
      policySources.push(await source(ws, "project-policy", join(ws, CONFIG_FILE)));
  }
  const profilePolicies = profile?.overrides?.policies;
  if (profilePolicies !== undefined) {
    const valid = validateWith(PolicyLayerSchema, profilePolicies, `profile ${profile?.name}`);
    if (!valid.ok)
      throw new BrokkrError(
        "invalid-config",
        `invalid profile policies:\n${formatIssues(valid.issues)}`,
      );
    layers.push({ layer: "task", policy: valid.value });
  }

  return {
    trustMode: trust,
    set,
    composed,
    ...(profile ? { profile } : {}),
    ...(config.project ? { projectId: config.project } : {}),
    lockDigest,
    lockProblems,
    layers,
    exceptions,
    ...(options.approvers ? { approvers: [...options.approvers] } : {}),
    policySources,
    warnings,
  };
}
