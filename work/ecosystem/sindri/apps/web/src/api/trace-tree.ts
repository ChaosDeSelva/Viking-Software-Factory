import type { TraceDocument, TraceNode } from "./delivery-types.js";

type Doc = TraceDocument;
const node = (kind: string, id: string, label: string, children: TraceNode[] = []): TraceNode => ({
  kind,
  id,
  label,
  children,
});

const events = (id: string, list: Doc["unattributedEvents"], label = "Events"): TraceNode[] =>
  list.length
    ? [
        node(
          "events",
          id,
          `${label} (${list.length})`,
          list.map((e) => node("event", e.id, `${e.type} at ${e.occurredAt}`)),
        ),
      ]
    : [];

const artifacts = (list: Doc["tasks"][number]["artifacts"]): TraceNode[] =>
  list.map((a) => node("artifact", a.id, `${a.kind} ${a.hash.slice(0, 19)}`));

/** Ticket -> spec -> plan -> mission -> tasks (artifacts, events), for display as nested lists. */
export function traceTree(doc: TraceDocument): TraceNode {
  const tasks = doc.tasks.map((t) =>
    node(
      "task",
      t.mimirTaskId ?? t.planTaskId,
      `${t.planTaskId} (${t.role}): ${t.status} · ${t.harness.id}@${t.harness.version}${
        t.gate ? ` · gate ${t.gate.passed ? "passed" : "failed"}` : ""
      }`,
      [...artifacts(t.artifacts), ...events(`${t.planTaskId}:events`, t.events)],
    ),
  );
  const reviewTasks = doc.reviewTasks.map((r) =>
    node(
      "review",
      r.mimirTaskId,
      `Review of ${r.review.ofPlanTaskId}: ${r.review.status}${r.review.verdict ? ` (${r.review.verdict})` : ""}`,
      [...artifacts(r.artifacts), ...events(`${r.mimirTaskId}:events`, r.events)],
    ),
  );
  const mission = node(
    "mission",
    doc.mission.id,
    `Mimir mission ${doc.mission.id} · execution ${doc.execution.status}`,
    [
      ...tasks,
      ...reviewTasks,
      ...events("mission:events", doc.unattributedEvents, "Mission events"),
    ],
  );
  const plan = node("plan", doc.plan.id, `Plan v${doc.plan.version}`, [mission]);
  const spec = node("spec", doc.spec.id, `Spec v${doc.spec.version}: ${doc.spec.title}`, [plan]);
  return doc.ticket ? node("ticket", doc.ticket.id, `Ticket: ${doc.ticket.title}`, [spec]) : spec;
}
