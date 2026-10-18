/**
 * How a planner (Sindri) uses Brokkr: for each planned task, ask Brokkr which
 * harnesses and skills apply and which checks will gate it. Nothing is
 * executed, no agent is launched and nothing is written into the repository.
 * The returned Selection is plain JSON: store it with the plan and hand it to
 * the orchestrator, which passes it back to `brokkr.verify`.
 */
import { Brokkr, type Selection, type TaskDescriptor } from "@brokkr/sdk";

export interface PlannedTaskHarnesses {
  taskId: string;
  harnesses: string[];
  skills: string[];
  requiredChecks: string[];
  lockDigest: string;
  selection: Selection;
}

export async function planHarnesses(
  repo: string,
  tasks: TaskDescriptor[],
  homeDir?: string,
): Promise<PlannedTaskHarnesses[]> {
  // Default trust is "workspace-untrusted": the repository's own .brokkr/ cannot
  // redefine the contract; only built-in and ~/.brokkr harnesses are candidates.
  const brokkr = new Brokkr({ cwd: repo, offline: true, ...(homeDir ? { homeDir } : {}) });
  const out: PlannedTaskHarnesses[] = [];
  for (const task of tasks) {
    const selection = await brokkr.resolve({ task });
    out.push({
      taskId: task.id,
      harnesses: selection.harnesses.map((h) => `${h.name}@${h.version}`),
      skills: selection.skills.map((s) => s.name),
      requiredChecks: selection.harnesses.flatMap((h) =>
        h.checks.filter((c) => c.required).map((c) => `${h.name}/${c.id}`),
      ),
      lockDigest: selection.lock.digest,
      selection,
    });
  }
  return out;
}
