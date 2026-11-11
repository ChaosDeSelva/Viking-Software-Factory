/**
 * Human names for records the server only knows by id or by a long agent prompt. Pure functions:
 * the raw value always stays reachable (Id component, disclosure) — these only pick the label.
 */
import type { Agent, Crew, Mission, Task } from "@mimir/protocol";

const MAX_NAME = 90;

/** Sindri's generated objective: "Sindri plan <uuid> v1 (spec <uuid> v1)". */
const SINDRI_PLAN = /^Sindri plan (\S+) v(\d+) \(spec (\S+) v(\d+)\)$/;

export interface PlanRef {
  planId: string;
  planVersion: number;
  specId: string;
  specVersion: number;
}

export function sindriPlanRef(objective: string): PlanRef | null {
  const m = SINDRI_PLAN.exec(objective.trim());
  if (!m) return null;
  return { planId: m[1]!, planVersion: Number(m[2]), specId: m[3]!, specVersion: Number(m[4]) };
}

function clip(text: string, max = MAX_NAME): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** First sentence (or line) of a prompt, without a trailing period. */
function firstSentence(text: string): string {
  const line = text.trim().split(/\n/)[0] ?? "";
  // A period followed by a space ends the sentence; "server.mjs" or "v1.2" do not.
  const end = line.search(/\.\s/);
  return (end > 0 ? line.slice(0, end) : line).replace(/\.$/, "");
}

export interface TaskHeadline {
  /** Planner key such as "implement-backend", when the title starts with one. */
  key: string | null;
  /** First sentence of the prompt, clipped. */
  summary: string;
  /** True when the title holds more than the summary (show it behind a disclosure). */
  hasMore: boolean;
}

const TASK_KEY = /^([a-z0-9][a-z0-9._-]{1,48}):\s+/i;

/** Task titles are often whole agent prompts ("implement-backend: Add a GET … route. It …"). */
export function taskHeadline(title: string): TaskHeadline {
  const m = TASK_KEY.exec(title);
  const rest = m ? title.slice(m[0].length) : title;
  const sentence = firstSentence(rest);
  const summary = clip(sentence.length > 0 ? sentence : rest);
  return {
    key: m ? m[1]! : null,
    summary,
    hasMore: summary.length + 1 < rest.replace(/\s+/g, " ").trim().length,
  };
}

/** "implement-backend · Add a GET /farewell route…" for places that need one line. */
export function taskName(task: Pick<Task, "title">): string {
  const h = taskHeadline(task.title);
  return h.key ? `${h.key} · ${h.summary}` : h.summary;
}

/**
 * Mission name: its objective when that is prose; for a Sindri-generated objective (plan and spec
 * ids only) the first task's summary, which says what the plan is about.
 */
export function missionName(
  mission: Pick<Mission, "id" | "objective">,
  tasks: readonly Task[],
): string {
  const ref = sindriPlanRef(mission.objective);
  if (!ref) return clip(firstLine(mission.objective));
  const first = tasks
    .filter((t) => t.missionId === mission.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0];
  return first
    ? taskHeadline(first.title).summary
    : `Plan ${ref.planId.slice(0, 8)} v${ref.planVersion}`;
}

/** Second line under a mission name: where it came from ("Sindri plan 1e7d7af5 v1"). */
export function missionOrigin(mission: Pick<Mission, "objective">): string | null {
  const ref = sindriPlanRef(mission.objective);
  return ref ? `Sindri plan ${ref.planId.slice(0, 8)} v${ref.planVersion}` : null;
}

function firstLine(text: string): string {
  return text.trim().split(/\n/)[0] ?? text;
}

/** "Implementer crew". The template is the planner's role name for the crew. */
export function crewLabel(crew: Pick<Crew, "template">): string {
  const t = crew.template.trim();
  const words = t.replace(/[-_]+/g, " ");
  const cap = words.charAt(0).toUpperCase() + words.slice(1);
  return /crew$/i.test(cap) ? cap : `${cap} crew`;
}

const MISSION_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const LIVE_AGENT = new Set(["starting", "running", "waiting"]);

/**
 * Crews keep `configured` after their mission ends (the server never moves them), so the stored
 * status alone says nothing. What the operator needs: running (an agent works now), paused,
 * idle (mission live, nothing running), or the mission's own end state.
 */
export function crewEffectiveStatus(
  crew: Crew,
  mission: Mission | undefined,
  agents: readonly Agent[],
): { value: string; domain: "crew" | "mission" } {
  if (crew.status === "stopped" || crew.status === "archived") {
    return { value: crew.status, domain: "crew" };
  }
  if (mission && MISSION_TERMINAL.has(mission.status)) {
    return { value: mission.status, domain: "mission" };
  }
  if (agents.some((a) => a.crewId === crew.id && LIVE_AGENT.has(a.status))) {
    return { value: "running", domain: "crew" };
  }
  if (crew.schedulingPaused) return { value: "paused", domain: "mission" };
  if (mission?.status === "paused") return { value: "paused", domain: "mission" };
  return { value: crew.status === "running" ? "idle" : crew.status, domain: "crew" };
}

/** Completed, failed or cancelled: the server refuses budget changes and new work for it. */
export function isMissionEnded(mission: Mission): boolean {
  return MISSION_TERMINAL.has(mission.status);
}

/** A crew is active while its mission can still run work. */
export function isCrewActive(crew: Crew, mission: Mission | undefined): boolean {
  if (crew.status === "stopped" || crew.status === "archived") return false;
  return mission !== undefined && !MISSION_TERMINAL.has(mission.status);
}
