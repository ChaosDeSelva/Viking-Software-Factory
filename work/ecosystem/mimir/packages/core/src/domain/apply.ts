import { MimirError, type Mission, type Task } from "@mimir/protocol";
import type { Decision } from "./decisions.js";
import { leaseManager, leaseTtlMs } from "./lease.js";
import { missionMachine } from "./missionMachine.js";
import type { ScheduleInput } from "./scheduler.js";
import { taskMachine } from "./taskMachine.js";
import { toIso } from "./time.js";

/**
 * Reference application of scheduler decisions to an input state, through the
 * task/mission state machines and the lease manager. Pure: returns new state.
 * Changed tasks and missions get `updatedAt = now` and `version + 1`, as the
 * store would. Throws `invalid_transition` (or a lease error) if a decision is
 * not applicable, which `schedule` guarantees never happens for its own output.
 */
export function applyDecisions(
  input: ScheduleInput,
  decisions: readonly Decision[],
): ScheduleInput {
  const now = input.now;
  const stamp = toIso(now.getTime());
  const tasks = new Map<string, Task>(input.tasks.map((t) => [t.id, t]));
  const missions = new Map<string, Mission>(input.missions.map((m) => [m.id, m]));
  let leases = [...input.leases];

  const task = (id: string): Task => {
    const t = tasks.get(id);
    if (!t) throw new MimirError("not_found", `task ${id} not in input`, { taskId: id });
    return t;
  };
  const putTask = (t: Task) => tasks.set(t.id, { ...t, updatedAt: stamp, version: t.version + 1 });
  const mission = (id: string): Mission => {
    const m = missions.get(id);
    if (!m) throw new MimirError("not_found", `mission ${id} not in input`, { missionId: id });
    return m;
  };
  const putMission = (m: Mission) =>
    missions.set(m.id, { ...m, updatedAt: stamp, version: m.version + 1 });
  const dropLease = (taskId: string) => {
    leases = leases.filter((l) => l.taskId !== taskId);
  };

  for (const d of decisions) {
    switch (d.kind) {
      case "dispatch": {
        const crew = input.crews.find((c) => c.id === d.crewId);
        if (!crew) throw new MimirError("not_found", `crew ${d.crewId} not in input`);
        const ttl = leaseTtlMs(crew);
        putTask(
          taskMachine.transition(task(d.taskId), {
            type: "lease_granted",
            crewId: d.crewId,
            leaseExpiresAt: toIso(now.getTime() + ttl),
          }),
        );
        leases = leaseManager.grant(
          leases,
          { taskId: d.taskId, crewId: d.crewId, sessionId: null },
          now,
          ttl,
        );
        break;
      }
      case "expire":
        putTask(taskMachine.transition(task(d.taskId), { type: "lease_expired" }));
        dropLease(d.taskId);
        break;
      case "release_lease":
        dropLease(d.taskId);
        break;
      case "retry":
        putTask(taskMachine.transition(task(d.taskId), { type: "retry" }));
        break;
      case "block":
        putTask(
          taskMachine.transition(task(d.taskId), { type: "budget_exceeded", reason: d.reason }),
        );
        break;
      case "unblock":
        putTask(taskMachine.transition(task(d.taskId), { type: "budget_restored" }));
        break;
      case "mission_complete": {
        const own = [...tasks.values()].filter((t) => t.missionId === d.missionId);
        putMission(
          missionMachine.transition(mission(d.missionId), { type: "complete", tasks: own }),
        );
        break;
      }
      case "mission_failed":
        putMission(
          missionMachine.transition(mission(d.missionId), { type: "fail", reason: "scheduler" }),
        );
        break;
    }
  }
  return {
    ...input,
    tasks: input.tasks.map((t) => tasks.get(t.id)!),
    missions: input.missions.map((m) => missions.get(m.id)!),
    leases,
  };
}
