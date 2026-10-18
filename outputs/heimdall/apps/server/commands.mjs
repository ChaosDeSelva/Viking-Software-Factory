export function commandRoute(c) {
  const id = String(c.id ?? "");
  if (!/^[\w-]{1,200}$/.test(id)) throw Error("Invalid resource ID");
  const body = { ...(c.body ?? {}) };
  let source, path;
  if (
    ["mission.pause", "mission.resume", "mission.cancel"].includes(c.action)
  ) {
    source = "mimir";
    path = `/v1/missions/${id}/${c.action.split(".")[1]}`;
  } else if (c.action === "fleet.drain") {
    source = "mimir";
    path = `/v1/fleet/${id}/drain`;
  } else if (c.action === "supervisor.register") {
    source = "mimir";
    path = "/v1/supervisors";
  } else if (
    ["supervisor.state", "supervisor.message", "supervisor.resolve", "supervisor.policy", "supervisor.authorize"].includes(
      c.action,
    )
  ) {
    source = "mimir";
    path = `/v1/supervisors/${id}/${c.action === "supervisor.message" ? "messages" : c.action.split(".")[1]}`;
  } else if (c.action === "session.input") {
    source = "mimir";
    path = `/v1/sessions/${id}/input`;
  } else if (c.action === "task.retry") {
    source = "mimir";
    path = `/v1/tasks/${id}/retry`;
  } else if (c.action === "session.stop") {
    source = "mimir";
    path = `/v1/sessions/${id}/stop`;
    if (!["graceful", "soft"].includes(body.mode))
      throw Error("Only graceful session stop is supported here");
    body.mode = "soft";
  } else if (c.action === "approval.decide") {
    source = "mimir";
    path = `/v1/approvals/${id}/decision`;
  } else if (
    [
      "spec.submit",
      "spec.approve",
      "plan.submit",
      "plan.approve",
      "spec.answer",
      "spec.revise",
      "plan.revise",
    ].includes(c.action)
  ) {
    source = "sindri";
    const [resource, verb] = c.action.split(".");
    path = `/v1/${resource}s/${id}/${verb}`;
  } else if (["execution.assess", "execution.export"].includes(c.action)) {
    source = "sindri";
    path = `/v1/executions/${id}/${c.action.endsWith("export") ? "pr" : "assess"}`;
  } else if (c.action === "execution.resolve") {
    source = "sindri";
    if (!/^[\w.-]{1,200}$/.test(c.taskId ?? ""))
      throw Error("Invalid plan task ID");
    path = `/v1/executions/${id}/escalations/${c.taskId}`;
  } else if (
    [
      "project.create",
      "project.bootstrap",
      "intake.create",
      "spec.draft",
      "plan.propose",
      "execution.create",
    ].includes(c.action)
  ) {
    source = "sindri";
    path = {
      "project.create": "/v1/projects",
      "project.bootstrap": `/v1/projects/${id}/bootstrap`,
      "intake.create": "/v1/intakes",
      "spec.draft": "/v1/director/draft",
      "plan.propose": "/v1/plans/propose",
      "execution.create": "/v1/executions",
    }[c.action];
  } else if (["crew.pause", "crew.resume"].includes(c.action)) {
    source = "mimir";
    path = `/v1/crews/${id}/${c.action.split(".")[1]}`;
  } else if (c.action === "task.verify") {
    source = "mimir";
    path = `/v1/tasks/${id}/verify`;
  } else throw Error("Unsupported operator action");
  if (JSON.stringify(body).length > 500000)
    throw Error("Command body too large");
  return { source, path, body };
}
