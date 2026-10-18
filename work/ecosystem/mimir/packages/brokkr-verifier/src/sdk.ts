/**
 * The part of `@brokkr/sdk` this package uses, declared structurally so the package builds
 * without the SDK installed; the SDK itself is loaded at runtime by {@link loadBrokkrSdk}.
 */

export interface BrokkrHarnessRequest {
  name: string;
  version: string;
}

export interface BrokkrTaskDescriptor {
  id: string;
  title: string;
  description: string;
}

export interface BrokkrReportCheck {
  id: string;
  required: boolean;
  command?: string[];
  state: string;
  exitCode?: number | null;
  durationMs?: number;
  reason?: string;
  message?: string;
  log?: string;
}

/** The fields Mimir reads from a `VerificationReport`; the whole report is stored as is. */
export interface BrokkrReport {
  id: string;
  taskId?: string;
  verdict: "passed" | "failed" | "incomplete" | "blocked";
  repository: { commitSha: string };
  reasons: string[];
  checks: BrokkrReportCheck[];
}

export interface BrokkrInstance {
  resolve(input: {
    task: BrokkrTaskDescriptor;
    harnesses: BrokkrHarnessRequest[];
  }): Promise<unknown>;
  verify(input: {
    selection: unknown;
    workspace: string;
    task?: BrokkrTaskDescriptor;
    signal?: AbortSignal;
    correlationId?: string;
    workspaceId?: string;
  }): Promise<unknown>;
}

export interface BrokkrConstructorOptions {
  cwd: string;
  trust: "workspace-untrusted";
  harnesses: BrokkrHarnessRequest[];
  lock?: unknown;
  policy?: unknown;
  offline: true;
  homeDir?: string;
  builtinDir?: string;
  executor?: unknown;
  /** Directory receiving Brokkr's `run_<ulid>/` evidence (B2fix). */
  runRoot: string;
  /** HMAC key for evidence manifests (B2fix). */
  signingKey: Buffer;
  /** Approver identities whose exceptions count (B2fix, ADR-006). */
  approvers: string[];
  /** Approved exceptions from the caller; Mimir supplies none. */
  exceptions: unknown[];
}

export interface BrokkrSdk {
  Brokkr: new (options: BrokkrConstructorOptions) => BrokkrInstance;
  VerificationReportSchema: { safeParse(v: unknown): { success: boolean } };
}

const SPECIFIER = "@brokkr/sdk";

/**
 * Imports `@brokkr/sdk`, or null when it is not installed (the vendored tarball is missing) or
 * does not expose what Mimir needs. Never throws.
 */
export async function loadBrokkrSdk(
  importer: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<BrokkrSdk | null> {
  try {
    const mod = (await importer(SPECIFIER)) as Partial<BrokkrSdk> | null;
    if (
      mod &&
      typeof mod.Brokkr === "function" &&
      typeof mod.VerificationReportSchema?.safeParse === "function"
    ) {
      return mod as BrokkrSdk;
    }
    return null;
  } catch {
    return null;
  }
}
