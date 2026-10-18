import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MimirError } from "@mimir/protocol";
import type { BrokkrReport, BrokkrSdk } from "./sdk.js";
import { parseHarnessRef, parseSettings, readSettingsFile } from "./settings.js";

/**
 * Structural copies of Mimir's Verifier port (apps/server `orchestrator/verifier.ts`); the server
 * type-checks this class against the port where it wires it.
 */
export interface VerifierBinding {
  taskId: string;
  missionId: string;
  worktreePath: string;
  baseRef: string;
  headSha: string | null;
}

export interface BrokkrVerifyInput extends VerifierBinding {
  signal: AbortSignal;
  taskTitle?: string;
  /** `project.settings.verification`, opaque to the orchestrator. */
  verifierConfig?: unknown;
}

export interface VerifierCheck {
  name: string;
  command: string[];
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
}

export interface BrokkrVerificationResult {
  source: "brokkr";
  passed: boolean;
  checks: VerifierCheck[];
  report: unknown;
  binding: VerifierBinding;
}

export interface BrokkrVerifierOptions {
  sdk: BrokkrSdk;
  /**
   * Mimir's data dir. Brokkr's run evidence goes to `<dataDir>/brokkr/runs` and its evidence
   * signing key is `<dataDir>/brokkr/signing.key` (0600): never the worktree, never ~/.brokkr.
   */
  dataDir: string;
  /** `~/.brokkr` location for user harnesses and organization policy (default: the OS home). */
  homeDir?: string;
  builtinDir?: string;
  /** Injected Brokkr `CheckExecutor` (tests); Brokkr's `LocalProcessExecutor` otherwise. */
  executor?: unknown;
}

const bindingOf = (i: VerifierBinding): VerifierBinding => ({
  taskId: i.taskId,
  missionId: i.missionId,
  worktreePath: i.worktreePath,
  baseRef: i.baseRef,
  headSha: i.headSha,
});

function toCheck(c: BrokkrReport["checks"][number]): VerifierCheck {
  const detail = [c.reason, c.message, c.log ? `log: ${c.log}` : undefined].filter(Boolean);
  return {
    name: c.id,
    command: c.command ?? [],
    passed: c.state === "passed",
    exitCode: c.exitCode ?? null,
    durationMs: c.durationMs ?? 0,
    timedOut: c.state === "timed_out",
    output: `${c.state}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`,
  };
}

const KEY_BYTES = 32;

/** Mimir's own Brokkr evidence signing key: created once (0600) under the data dir, then reused. */
export function signingKeyAt(dir: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "signing.key");
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new MimirError("conflict", `${path} is not a regular file`);
    if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length >= KEY_BYTES) return key;
  } catch (err) {
    if (err instanceof MimirError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

/**
 * Verifies a task worktree with Brokkr (D-011). Brokkr runs `workspace-untrusted`: the
 * harnesses, lock and policy come from the project's settings, never from the worktree. The
 * verdict is Brokkr's alone (D-012): Mimir passes the task only when the verdict is `passed`
 * and the report is bound to this task and to the head commit Mimir observed.
 *
 * Nothing is written inside the worktree: run evidence goes to `<dataDir>/brokkr/runs`, signed
 * with Mimir's key. Mimir supplies no exceptions and no approvers, so no waiver applies (the
 * worktree's own `.brokkr/` is never read). The report `verify` returns is stored by the
 * orchestrator as the `brokkr.verification-report` artifact.
 */
export class BrokkrVerifier {
  constructor(private readonly options: BrokkrVerifierOptions) {}

  async verify(input: BrokkrVerifyInput): Promise<BrokkrVerificationResult> {
    const settings = parseSettings(input.verifierConfig);
    const harnesses = settings.harnesses.map(parseHarnessRef);
    const lock = settings.lock ?? readSettingsFile(settings.lockPath!, input.worktreePath, "lock");
    const policy =
      settings.policyPath === undefined
        ? undefined
        : readSettingsFile(settings.policyPath, input.worktreePath, "policy");
    if (input.signal.aborted) throw new MimirError("conflict", "verification was cancelled");

    const { sdk } = this.options;
    const brokkrDir = join(this.options.dataDir, "brokkr");
    const brokkr = new sdk.Brokkr({
      cwd: input.worktreePath,
      trust: "workspace-untrusted",
      harnesses,
      offline: true,
      lock,
      runRoot: join(brokkrDir, "runs"),
      signingKey: signingKeyAt(brokkrDir),
      approvers: [],
      exceptions: [],
      ...(policy !== undefined ? { policy } : {}),
      ...(this.options.homeDir !== undefined ? { homeDir: this.options.homeDir } : {}),
      ...(this.options.builtinDir !== undefined ? { builtinDir: this.options.builtinDir } : {}),
      ...(this.options.executor !== undefined ? { executor: this.options.executor } : {}),
    });
    const task = {
      id: input.taskId,
      title: input.taskTitle ?? input.taskId,
      description: `Mimir task ${input.taskId} (mission ${input.missionId})`,
    };
    const selection = await brokkr.resolve({ task, harnesses });
    const raw = await brokkr.verify({
      selection,
      workspace: input.worktreePath,
      task,
      signal: input.signal,
    });
    if (!sdk.VerificationReportSchema.safeParse(raw).success) {
      throw new MimirError("internal", "Brokkr returned a report that does not match its schema");
    }
    const report = raw as BrokkrReport;
    // Checks Brokkr skipped (conditions not met) did not run; the report artifact keeps them.
    const checks = report.checks.filter((c) => c.state !== "skipped").map(toCheck);
    const bound =
      report.taskId === input.taskId &&
      input.headSha !== null &&
      report.repository.commitSha === input.headSha;
    if (!bound) {
      checks.push({
        name: "mimir.binding",
        command: [],
        passed: false,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        output: `report is for task ${report.taskId ?? "(none)"} at ${report.repository.commitSha}; expected task ${input.taskId} at ${input.headSha ?? "(head not observed)"}`,
      });
    }
    return {
      source: "brokkr",
      passed: report.verdict === "passed" && bound,
      checks,
      report,
      binding: bindingOf(input),
    };
  }
}
