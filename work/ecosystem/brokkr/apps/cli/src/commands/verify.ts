import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BrokkrError, type CheckResult } from "@brokkr/core";
import { formatDuration, notApplicableRequired, renderJson, stripControl } from "@brokkr/reporters";
import {
  loadContract,
  readGeneratedBundles,
  runVerification,
  type VerifyEvent,
} from "@brokkr/runner";
import type { CommandContext } from "../io.js";
import { loadTask } from "./shared.js";

export interface VerifyCommandOptions {
  profile?: string;
  task?: string;
  executor?: string;
  /** Approval exceptions file, e.g. supplied by Mimir from outside the worktree. */
  exceptions?: string;
  /** Project policy layer file, replacing `policies` in .brokkr/config.yaml. */
  policy?: string;
  /** Treat the workspace as the work under test: read nothing from it (ADR-003). */
  untrustedWorkspace?: boolean;
  /** Caller-supplied project config (harnesses, profiles, policies). */
  config?: string;
  /** Caller-supplied harness lock. */
  lock?: string;
  /** Approver identities whose exceptions are honoured (repeatable). */
  approver?: string[];
}

const ICON: Record<CheckResult["state"], string> = {
  passed: "✓",
  failed: "✗",
  errored: "!",
  timed_out: "⏱",
  skipped: "-",
  cancelled: "⊘",
};

function checkLine(r: CheckResult): string {
  const name = r.id.padEnd(18);
  if (r.state === "skipped" || (r.state === "cancelled" && !r.startedAt)) {
    const why = r.exceptionId
      ? `exception ${r.exceptionId}`
      : `${r.reason ?? "skipped"}: ${r.message ?? ""}`;
    return `  ${ICON[r.state]} ${name} ${r.state} (${why})`;
  }
  const time = formatDuration(r.durationMs).padStart(6);
  const extra =
    r.state === "passed"
      ? ""
      : `  ${r.state}${r.exitCode !== undefined && r.exitCode !== null ? ` (exit ${r.exitCode})` : ""}${r.message ? `: ${r.message}` : ""}`;
  return `  ${ICON[r.state]} ${name} ${time}${extra}${r.required ? "" : "  (optional)"}`;
}

function tailLines(text: string, n: number): string {
  return text
    .trimEnd()
    .split("\n")
    .slice(-n)
    .map((l) => `      ${l}`)
    .join("\n");
}

export async function verifyCommand(
  ctx: CommandContext,
  options: VerifyCommandOptions,
): Promise<number> {
  if (options.executor !== undefined && options.executor !== "local")
    throw new BrokkrError(
      "invalid-config",
      `unknown executor '${options.executor}' (available: local)`,
    );
  const trust = options.untrustedWorkspace ? "workspace-untrusted" : "developer";
  const contract = await loadContract({
    workspace: ctx.cwd,
    trust,
    home: ctx.homeDir,
    builtinDir: ctx.builtinDir,
    ...(options.config !== undefined ? { configFile: resolve(ctx.cwd, options.config) } : {}),
    ...(options.lock !== undefined ? { lockFile: resolve(ctx.cwd, options.lock) } : {}),
    ...(options.exceptions !== undefined
      ? { exceptionsFile: resolve(ctx.cwd, options.exceptions) }
      : {}),
    ...(options.policy !== undefined ? { policyFile: resolve(ctx.cwd, options.policy) } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.approver !== undefined ? { approvers: options.approver } : {}),
  });
  const { set, composed, profile } = contract;
  if (options.task !== undefined && trust === "workspace-untrusted") {
    // The task id selects task-scoped exceptions: it must come from the caller too.
    const root = await realpath(ctx.cwd);
    const file = await realpath(resolve(ctx.cwd, options.task)).catch(() =>
      resolve(ctx.cwd, options.task!),
    );
    const rel = relative(root, file);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
      throw new BrokkrError(
        "invalid-config",
        `task file ${file} is inside the verified workspace; in workspace-untrusted mode it must come from the caller`,
      );
  }
  const task = options.task ? await loadTask(ctx, options.task) : undefined;
  const warnings = [...contract.warnings];
  const layers = contract.layers;
  const exceptions = contract.exceptions;
  const policySources = contract.policySources;
  const problems = contract.lockProblems;
  const lockDigest = contract.lockDigest;
  const config = { project: contract.projectId };

  const human = !ctx.json;
  // Check output, messages and exception text are untrusted: never let them drive the terminal.
  const out = (s: string): void => {
    if (human) ctx.io.stdout(`${stripControl(s)}\n`);
  };
  out(`BROKKR / VERIFY${trust === "workspace-untrusted" ? " · workspace-untrusted" : ""}`);
  out(
    `${composed.harnesses.map((h) => `${h.name}@${h.version}`).join(", ")}${profile ? ` · profile ${profile.name}` : ""}${task ? ` · task ${task.id}` : ""}`,
  );
  const onEvent = (e: VerifyEvent): void => {
    if (e.type === "run-start") out(`run ${e.runId} · ${e.checks} check(s)\n`);
    if (e.type === "check-start") out(`  ▸ ${e.checkId} …`);
    if (e.type === "check-end") {
      out(checkLine(e.result));
      if (["failed", "errored", "timed_out"].includes(e.result.state) && e.outputTail)
        out(tailLines(e.outputTail, 15));
    }
  };

  const outcome = await runVerification({
    workspace: ctx.cwd,
    set,
    composed,
    lockDigest,
    lockProblems: problems,
    ...(task ? { task } : {}),
    ...(config.project ? { projectId: config.project } : {}),
    layers,
    exceptions,
    policySources,
    trustMode: trust,
    ...(contract.approvers ? { approvers: contract.approvers } : {}),
    env: ctx.io.env,
    ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
    onEvent,
    // Read after the checks with the shared O_NOFOLLOW/fstat/nlink/bounded reader (B3b I-b).
    readBundles: () => readGeneratedBundles(ctx.cwd),
    home: ctx.homeDir,
    warnings,
  });
  const { report } = outcome;
  if (ctx.json) {
    ctx.io.stdout(renderJson(report));
    return outcome.exitCode;
  }
  const na = notApplicableRequired(report);
  const requiredChecks = report.checks.filter((c) => c.required && !na.includes(c));
  const passedRequired = requiredChecks.filter((c) => c.state === "passed").length;
  out("");
  if (outcome.interrupted)
    out("Interrupted: remaining checks were cancelled; partial evidence kept.");
  if (na.length > 0) {
    out(`Required checks not applicable (${na.length}) — their \`when\` guard was not met:`);
    for (const c of na) out(`  ! ${c.id}: ${c.message ?? "guard not met"}`);
  }
  out(
    `${report.verdict.toUpperCase()} · ${passedRequired}/${requiredChecks.length} required gates passed${na.length > 0 ? ` (${na.length} not applicable)` : ""}`,
  );
  for (const reason of report.reasons) out(`  - ${reason}`);
  for (const w of report.warnings) ctx.io.stderr(`warning: ${stripControl(w)}\n`);
  out(`Report: ${join(outcome.runDir, "report.md")}`);
  return outcome.exitCode;
}
