import { join } from "node:path";
import type { ComposedHarness } from "./domain.js";
import { GENERATED_CONTEXT_DIR } from "./domain.js";
import { BrokkrError } from "./errors.js";
import { TaskDescriptorSchema, type TaskDescriptor } from "./schemas.js";

/** `<cwd>/.brokkr/generated/task-context/<taskId>/<adapterDir>`; rejects path-unsafe task ids. */
export function bundleDir(cwd: string, taskId: string, adapterDir: string): string {
  if (!TaskDescriptorSchema.shape.id.safeParse(taskId).success) {
    throw new BrokkrError("invalid-config", `task id '${taskId}' is not a safe directory name`);
  }
  return join(cwd, GENERATED_CONTEXT_DIR, taskId, adapterDir);
}

/** Render an argv array for display (quoting args with whitespace). Display only; never executed via a shell. */
export function displayCommand(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"'`$]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

export function renderTaskBrief(task: TaskDescriptor): string {
  const lines = [
    `# Task ${task.id}: ${task.title}`,
    "",
    task.description || "(no description)",
    "",
  ];
  if (task.tags?.length) lines.push(`- Tags: ${task.tags.join(", ")}`);
  if (task.taskTypes?.length) lines.push(`- Task types: ${task.taskTypes.join(", ")}`);
  if (task.paths?.length) lines.push(`- Paths: ${task.paths.join(", ")}`);
  for (const [k, v] of Object.entries(task.context ?? {})) lines.push(`- ${k}: ${v}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Human-readable harness execution contract shared by all adapters. */
export function renderExecutionContract(composed: ComposedHarness): string {
  const out: string[] = ["## Harness execution contract", ""];
  out.push(
    `Harnesses: ${composed.harnesses.map((h) => `${h.name}@${h.version}`).join(", ") || "(none)"}`,
    "",
  );
  out.push("Work is not complete until every required check passes when Brokkr verifies it.");
  out.push("Do not claim success on behalf of a check you did not see pass.", "");
  out.push("### Workflow stages", "");
  composed.workflow.stages.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push("", "### Verification checks", "");
  for (const c of composed.checks) {
    const when: string[] = [];
    if (c.when?.fileExists?.length) when.push(`when files exist: ${c.when.fileExists.join(", ")}`);
    if (c.when?.anyFileExists?.length)
      when.push(`when any file exists: ${c.when.anyFileExists.join(", ")}`);
    if (c.when?.scriptExists?.length)
      when.push(`when scripts exist: ${c.when.scriptExists.join(", ")}`);
    out.push(
      `- \`${c.id}\` (${c.required ? "required" : "optional"}): \`${displayCommand(c.command)}\`` +
        `${c.cwd ? ` in \`${c.cwd}\`` : ""}, timeout ${c.timeoutSeconds}s${when.length ? ` (${when.join("; ")})` : ""}`,
    );
  }
  out.push("", "### Policies", "");
  out.push(`- Network access: ${composed.policies.network}`);
  out.push(`- Destructive commands: ${composed.policies.destructiveCommands}`);
  out.push(
    `- Ask for approval before: ${composed.policies.requireApprovalFor.length ? composed.policies.requireApprovalFor.join(", ") : "(nothing listed)"}`,
  );
  if (!composed.executionAllowed) {
    out.push(
      "- Some harnesses come from untrusted sources: their checks will not run until the source is trusted.",
    );
  }
  const evidence = Object.entries(composed.evidence)
    .filter(([, v]) => v)
    .map(([k]) => k);
  out.push("", "### Evidence", "", `Brokkr will capture: ${evidence.join(", ") || "(nothing)"}`);
  if (composed.aiReview.criteria.length) {
    out.push("", "### Review criteria", "");
    for (const c of composed.aiReview.criteria) out.push(`- ${c}`);
  }
  return `${out.join("\n")}\n`;
}
