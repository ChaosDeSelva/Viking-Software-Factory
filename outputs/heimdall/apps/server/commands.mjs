// Drafting and planning read the repository and Sindri allows them 600 s, so wait longer than that.
const TIMEOUTS = {
  "spec.draft": 900000,
  "plan.propose": 900000,
  "delivery.rework": 900000,
  "task.verify": 180000,
  "execution.create": 120000,
  "plan.revise": 120000,
  // Sindri stops the background run and cancels the Mimir mission before it answers.
  "execution.cancel": 120000,
};
export const commandTimeout = (action) => TIMEOUTS[action] ?? 30000;
// Accepting a recommendation of these types performs the approval, so it needs the human factor.
export const APPROVAL_DECISION_TYPES = ["spec.approve", "plan.approve"];
// Types known to need no approval factor; any other (newer) type is treated as an approval.
const PLAIN_DECISION_TYPES = [
  "spec.answer",
  "escalation.resolve",
  "rework.suggest",
];
export const decisionNeedsApproval = (type) =>
  APPROVAL_DECISION_TYPES.includes(type) ||
  !PLAIN_DECISION_TYPES.includes(type);
const STEWARD_MODES = ["off", "recommend", "auto"];
const text = (value, what, max = 20000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error(`${what} is required`);
  return value;
};
const optionalText = (value, what) =>
  value === undefined || value === null ? undefined : text(value, what);
const projectRef = (value) => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[\w-]{1,200}$/.test(value))
    throw Error("Invalid project ID");
  return value;
};
/** Steward and Feedback Graph controls; null for any other action. */
function stewardRoute(c, id) {
  const b = c.body ?? {};
  const decision = `/v1/steward/decisions/${id}`;
  switch (c.action) {
    case "steward.mode":
      if (typeof b.type !== "string" || !/^[\w.-]{1,100}$/.test(b.type))
        throw Error("Invalid decision type");
      if (!STEWARD_MODES.includes(b.mode)) throw Error("Unknown steward mode");
      return {
        method: "PUT",
        path: "/v1/steward/modes",
        body: { type: b.type, mode: b.mode },
        approval: true,
      };
    case "steward.pause":
    case "steward.resume":
      return { path: "/v1/steward/" + c.action.split(".")[1], body: {} };
    case "steward.accept": {
      // The browser names the type; the server checks it against Sindri's record before sending.
      if (
        typeof c.decisionType !== "string" ||
        !/^[\w.-]{1,100}$/.test(c.decisionType)
      )
        throw Error("The decision type is required");
      const value = optionalText(b.value, "An answer");
      return {
        path: decision + "/accept",
        body: value === undefined ? {} : { value },
        approval: decisionNeedsApproval(c.decisionType),
      };
    }
    case "steward.reject": {
      const reason =
        typeof b.reason === "string" && b.reason.trim() ? b.reason : undefined;
      return {
        path: decision + "/reject",
        body: reason === undefined ? {} : { reason },
      };
    }
    case "steward.rollback":
      return {
        path: decision + "/rollback",
        body: { reason: text(b.reason, "A rollback reason", 2000) },
      };
    case "steward.note":
      return {
        path: decision + "/notes",
        body: { text: text(b.text, "Note text") },
      };
    case "steward.globalNote":
      return {
        path: "/v1/steward/notes",
        body: {
          projectId: projectRef(b.projectId ?? null),
          text: text(b.text, "Note text"),
        },
      };
    case "project.feedbackGraph": {
      const key = b.projectKey ?? null;
      if (
        key !== null &&
        (typeof key !== "string" || !key.trim() || key.length > 500)
      )
        throw Error("Invalid Feedback Graph project key");
      return {
        method: "PUT",
        path: `/v1/projects/${id}/feedback-graph`,
        body: { projectKey: key },
      };
    }
  }
  return null;
}
export function commandRoute(c) {
  const id = String(c.id ?? "");
  if (!/^[\w-]{1,200}$/.test(id)) throw Error("Invalid resource ID");
  const steward = stewardRoute(c, id);
  if (steward) {
    const route = {
      source: "sindri",
      method: "POST",
      approval: false,
      ...steward,
    };
    if (JSON.stringify(route.body).length > 500000)
      throw Error("Command body too large");
    return route;
  }
  const body = { ...(c.body ?? {}) };
  let source,
    path,
    method = "POST";
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
    [
      "supervisor.state",
      "supervisor.message",
      "supervisor.resolve",
      "supervisor.policy",
      "supervisor.authorize",
    ].includes(c.action)
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
  } else if (c.action === "execution.cancel") {
    source = "sindri";
    path = `/v1/executions/${id}/cancel`;
  } else if (c.action === "project.profile") {
    // The body is the whole profile; Sindri replaces the stored one with it.
    source = "sindri";
    method = "PUT";
    path = `/v1/projects/${id}/profile`;
  } else if (c.action === "delivery.rework") {
    // Sindri drafts a follow-up specification that builds on the delivered results.
    source = "sindri";
    path = `/v1/deliveries/${id}/rework`;
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
  } else if (c.action === "budget.raise") {
    // Mimir's way out of a budget block: new limits for budget_exceeded, `onUnknown` for
    // budget_uncertain (and for a new hard budget when the runtime reports no usage). Only these
    // and the expected version are forwarded; Mimir validates and bounds them.
    source = "mimir";
    method = "PATCH";
    const scope = body.scope ?? "crew";
    if (!["crew", "mission"].includes(scope))
      throw Error("Unknown budget scope");
    path = `/v1/${scope}s/${id}/budget`;
    const limit = (value, what, integer) => {
      if (value === undefined || value === null) return undefined;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        (integer && !Number.isInteger(value))
      )
        throw Error(`${what} must be a positive number`);
      return value;
    };
    const limitTokens = limit(body.limitTokens, "The token limit", true);
    const limitCost = limit(body.limitCost, "The cost limit", false);
    const { onUnknown } = body;
    // Mimir's BudgetOnUnknownSchema.
    if (onUnknown !== undefined && !["allow", "block"].includes(onUnknown))
      throw Error("Unknown usage must be allow or block");
    if (
      limitTokens === undefined &&
      limitCost === undefined &&
      onUnknown === undefined
    )
      throw Error("A new token or cost limit, or onUnknown, is required");
    const { expectedVersion } = body;
    if (
      expectedVersion !== undefined &&
      (!Number.isInteger(expectedVersion) || expectedVersion < 0)
    )
      throw Error("Invalid budget version");
    for (const key of Object.keys(body)) delete body[key];
    Object.assign(
      body,
      limitTokens === undefined ? {} : { limitTokens },
      limitCost === undefined ? {} : { limitCost },
      onUnknown === undefined ? {} : { onUnknown },
      expectedVersion === undefined ? {} : { expectedVersion },
    );
  } else if (["crew.pause", "crew.resume"].includes(c.action)) {
    source = "mimir";
    path = `/v1/crews/${id}/${c.action.split(".")[1]}`;
  } else if (c.action === "task.verify") {
    source = "mimir";
    path = `/v1/tasks/${id}/verify`;
  } else throw Error("Unsupported operator action");
  if (JSON.stringify(body).length > 500000)
    throw Error("Command body too large");
  // Every non-steward Sindri control carries the approval secret.
  return { source, path, body, method, approval: source === "sindri" };
}
