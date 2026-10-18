import { runTests, type RunTestsResult } from "@mimir/git";
import { MimirError } from "@mimir/protocol";

/** Output kept per check in results and events; the full output goes to an artifact. */
export const MAX_CHECK_OUTPUT = 64 * 1024;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/** What a verification is about: the task, its worktree and the exact commits checked. */
export interface VerifyBinding {
  taskId: string;
  missionId: string;
  /** The exact worktree the agent worked in. */
  worktreePath: string;
  /** Commit the worktree was created from. */
  baseRef: string;
  /**
   * HEAD of the worktree observed in this verifying step (the same value as the step's
   * `changed-files` manifest); null when git could not observe it. Never the base as a fallback.
   */
  headSha: string | null;
}

export interface VerifyInput extends VerifyBinding {
  /** The task's title, recorded in a verifier's report. */
  taskTitle?: string;
  /**
   * The project's `settings.verification`, passed through unread: Mimir does not interpret a
   * verifier's configuration. Present means "verify with the configured verifier" (Brokkr).
   */
  verifierConfig?: unknown;
  /** Plain test command (argv, no shell). */
  testCommand?: readonly string[];
  /** Opaque reference to a verification profile, passed through to Brokkr. */
  harnessRef?: string;
  signal: AbortSignal;
}

export interface VerificationCheck {
  name: string;
  command: string[];
  passed: boolean;
  /** null when the process was killed (timeout or signal). */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** stdout then stderr, capped at MAX_CHECK_OUTPUT. */
  output: string;
}

export interface VerificationResult {
  source: "test-command" | "brokkr";
  passed: boolean;
  checks: VerificationCheck[];
  /** The verifier's own report (Brokkr `VerificationReport`), stored as an artifact. */
  report?: unknown;
  /** The input binding, echoed back unchanged so the result can be tied to the task. */
  binding?: VerifyBinding;
}

const bindingOf = (input: VerifyInput): VerifyBinding => ({
  taskId: input.taskId,
  missionId: input.missionId,
  worktreePath: input.worktreePath,
  baseRef: input.baseRef,
  headSha: input.headSha,
});

/** Runs verification against a worktree. Mimir never overrides the verdict. */
export interface Verifier {
  verify(input: VerifyInput): Promise<VerificationResult>;
}

function capOutput(r: RunTestsResult): string {
  const text = r.stderr.length > 0 ? `${r.stdout}\n--- stderr ---\n${r.stderr}` : r.stdout;
  if (text.length <= MAX_CHECK_OUTPUT && !r.truncated) return text;
  return `${text.slice(0, MAX_CHECK_OUTPUT)}\n[truncated]`;
}

/**
 * Default verifier: the project's plain test command as one required check, run through
 * `@mimir/git`'s `runTests` (argv only, scrubbed env, own process group, timeout, capped output).
 */
export class TestCommandVerifier implements Verifier {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const command = input.testCommand;
    if (command === undefined || command.length === 0) {
      throw new MimirError("validation_failed", "no test command configured for verification");
    }
    if (input.signal.aborted) throw new MimirError("conflict", "verification was cancelled");
    const r = await runTests(input.worktreePath, [...command], {
      timeoutMs: this.options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    });
    const passed = r.exitCode === 0 && !r.timedOut;
    return {
      source: "test-command",
      binding: bindingOf(input),
      passed,
      checks: [
        {
          name: "test",
          command: [...command],
          passed,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          timedOut: r.timedOut,
          output: capOutput(r),
        },
      ],
    };
  }
}
