export const STAGES = [
  "Intake",
  "Specification",
  "Planning",
  "Ready",
  "Building",
  "Verification",
  "Review",
  "Completed",
  "Delivery",
];
export function validatePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Preferences must be an object");
  const result = {};
  if (value.archivedProjects !== undefined) {
    if (!Array.isArray(value.archivedProjects) || value.archivedProjects.length > 1000 ||
      value.archivedProjects.some(id => typeof id !== "string" || !/^[\w-]{1,200}$/.test(id)))
      throw Error("Invalid archived project identifiers");
    result.archivedProjects = [...new Set(value.archivedProjects)];
  }
  if (value.theme !== undefined) {
    if (!["dark", "light"].includes(value.theme)) throw Error("Invalid theme");
    result.theme = value.theme;
  }
  if (value.desktopNotifications !== undefined) {
    if (typeof value.desktopNotifications !== "boolean")
      throw Error("Invalid notification setting");
    result.desktopNotifications = value.desktopNotifications;
  }
  if (value.stages !== undefined) {
    if (
      !Array.isArray(value.stages) ||
      value.stages.length !== STAGES.length ||
      new Set(value.stages).size !== STAGES.length ||
      value.stages.some((s) => !STAGES.includes(s))
    )
      throw Error("Pipeline must contain each stage exactly once");
    result.stages = value.stages;
  }
  if (value.graphs !== undefined) {
    if (
      !value.graphs ||
      typeof value.graphs !== "object" ||
      Array.isArray(value.graphs) ||
      Object.keys(value.graphs).length > 100
    )
      throw Error("Invalid graph layouts");
    result.graphs = {};
    for (const [id, positions] of Object.entries(value.graphs)) {
      if (
        !/^[\w-]{1,200}$/.test(id) ||
        !positions ||
        typeof positions !== "object" ||
        Object.keys(positions).length > 2000
      )
        throw Error("Invalid graph");
      result.graphs[id] = {};
      for (const [key, p] of Object.entries(positions)) {
        if (
          !/^[\w.-]{1,200}$/.test(key) ||
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > 100000 ||
          Math.abs(p.y) > 100000
        )
          throw Error("Invalid node position");
        result.graphs[id][key] = { x: p.x, y: p.y };
      }
    }
  }
  if (
    Object.keys(value).some(
      (k) => !["theme", "desktopNotifications", "stages", "graphs", "archivedProjects"].includes(k),
    )
  )
    throw Error("Unknown preference");
  return result;
}
export function attentionRecords(state) {
  const out = [];
  const push = (key, title, severity, kind, row, revision) =>
    out.push({
      id: key,
      title,
      severity,
      kind,
      resourceId: row.id,
      row,
      revision: String(
        revision ?? row.version ?? row.updatedAt ?? row.status ?? "1",
      ),
    });
  for (const [name, s] of Object.entries(state.sources ?? {}))
    if (s.status === "disconnected")
      push(
        "source:" + name,
        name + " disconnected",
        "error",
        "connection",
        { id: name },
        s.lastSuccess ?? "initial",
      );
  for (const agent of state.mimir.agents ?? [])
    if (["failed", "lost", "unknown", "disconnected"].includes(agent.status))
      push(
        "agent:" + agent.id,
        "Agent " + agent.id + " · " + agent.status,
        "error",
        "agents",
        agent,
      );
  for (const task of state.mimir.tasks ?? [])
    if (["blocked", "failed"].includes(task.status))
      push(
        "task:" + task.id,
        task.title + " · " + task.status,
        "error",
        "tasks",
        task,
      );
  for (const mission of state.mimir.missions ?? [])
    if (["failed", "completed"].includes(mission.status))
      push(
        "mission:" + mission.id,
        mission.objective + " · " + mission.status,
        mission.status === "failed" ? "error" : "success",
        "missions",
        mission,
      );
  for (const a of state.mimir.approvals ?? [])
    if (a.status === "pending")
      push(
        "approval:" + a.id,
        "Approval needed: " + a.action,
        "warning",
        "approvals",
        a,
      );
  for (const kind of ["specs", "plans"])
    for (const item of state.sindri[kind] ?? [])
      if (item.status === "review")
        push(
          kind + ":" + item.id,
          (kind === "specs" ? "Specification" : "Plan") + " ready for review",
          "warning",
          kind,
          item,
        );
  for (const d of state.sindri.deliveries ?? [])
    push(
      "delivery:" + d.id,
      "Delivery ready: " + d.id,
      "success",
      "deliveries",
      d,
    );
  for (const e of state.sindri.executions ?? []) {
    for (const g of e.gates ?? [])
      if (!g.passed)
        push(
          "gate:" + e.execution.id + ":" + g.planTaskId,
          "Verification failed: " + g.planTaskId,
          "error",
          "gate",
          { ...g, id: g.planTaskId },
          g.evaluatedAt,
        );
    for (const t of e.tasks ?? [])
      if (t.escalation)
        push(
          "escalation:" + e.execution.id + ":" + t.planTaskId,
          "Operator decision: " + t.planTaskId,
          "warning",
          "escalation",
          { ...t, id: t.planTaskId, executionId: e.execution.id },
          JSON.stringify(t.escalation),
        );
  }
  return out;
}
