/**
 * `@brokkr/sdk/testing`: deterministic test doubles for consumers (Mimir,
 * Sindri, your own orchestrator). `MockExecutor` implements the same
 * `CheckExecutor` contract as the local process executor but runs nothing.
 *
 * @packageDocumentation
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CheckExecutionRequest,
  CheckExecutionResult,
  CheckExecutor,
  ExecutionState,
} from "@brokkr/runner";

/** A scripted result: a state, a partial result, or a function computing one. */
export type MockOutcome =
  | ExecutionState
  | MockResult
  | ((request: CheckExecutionRequest) => MockResult | Promise<MockResult>);

export interface MockResult extends Partial<
  Omit<CheckExecutionResult, "checkId" | "startedAt" | "completedAt" | "durationMs" | "state">
> {
  state: ExecutionState;
  /** Text written to the request's log file and returned as the output tail. */
  output?: string;
  /** Simulated duration; an abort during the delay yields `cancelled`. */
  delayMs?: number;
}

export interface MockExecutorOptions {
  /** Result for checks without a script entry. Default: `errored` (never a silent pass). */
  fallback?: MockOutcome;
}

/** Executes nothing; returns scripted results per check id and records every request. */
export class MockExecutor implements CheckExecutor {
  readonly calls: CheckExecutionRequest[] = [];
  private readonly script: Readonly<Record<string, MockOutcome>>;
  private readonly fallback: MockOutcome | undefined;

  constructor(
    script: Readonly<Record<string, MockOutcome>> = {},
    options: MockExecutorOptions = {},
  ) {
    this.script = script;
    this.fallback = options.fallback;
  }

  async execute(
    request: CheckExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CheckExecutionResult> {
    this.calls.push(request);
    const startedAt = new Date();
    const done = (r: MockResult): CheckExecutionResult => {
      const completedAt = new Date();
      const output = r.output ?? "";
      const rest: MockResult = { ...r };
      delete rest.output;
      delete rest.delayMs;
      return {
        checkId: request.checkId,
        exitCode: r.state === "passed" ? 0 : r.state === "failed" ? 1 : null,
        signal: null,
        outputTail: output,
        outputBytes: Buffer.byteLength(output),
        truncated: false,
        secretFindings: 0,
        ...rest,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    };
    const cancelled = (): CheckExecutionResult => done({ state: "cancelled", reason: "cancelled" });
    if (signal?.aborted) return cancelled();

    const outcome = this.script[request.checkId] ?? this.fallback;
    let result: MockResult;
    if (outcome === undefined)
      result = {
        state: "errored",
        reason: "spawn_error",
        error: `MockExecutor: no scripted result for check '${request.checkId}'`,
      };
    else if (typeof outcome === "string") result = { state: outcome };
    else if (typeof outcome === "function") result = await outcome(request);
    else result = outcome;

    if (result.delayMs !== undefined && result.delayMs > 0) {
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), result.delayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
      if (aborted) return cancelled();
    }
    if (request.logFile) {
      await mkdir(dirname(request.logFile), { recursive: true });
      await writeFile(request.logFile, result.output ?? "");
    }
    return done(result);
  }
}

export type { CheckExecutionRequest, CheckExecutionResult, CheckExecutor, ExecutionState };
