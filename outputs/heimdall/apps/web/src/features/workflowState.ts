// Pure view logic for specifications, plans, deliveries and projects. Sindri and Mimir stay authoritative.
type R = Record<string, any>;

/** Only the highest version of each lineage; earlier versions stay reachable through the record itself. */
export function latestVersions<T extends R>(rows: T[]): T[] {
  const newest = new Map<string, number>();
  for (const r of rows) {
    const key = r.lineageId ?? r.id;
    newest.set(key, Math.max(newest.get(key) ?? -Infinity, r.version ?? 0));
  }
  return rows.filter(
    (r) => (r.version ?? 0) === newest.get(r.lineageId ?? r.id),
  );
}

/** Open questions of a specification, blocking ones first, otherwise in the drafter's order. */
export function orderedQuestions(spec: R | null | undefined): R[] {
  const questions: R[] = spec?.body?.openQuestions ?? [];
  return [
    ...questions.filter((q) => q.blocking),
    ...questions.filter((q) => !q.blocking),
  ];
}

/** Badge text for a record, or undefined for kinds that carry no status at all. */
export function statusBadge(kind: string, row: R): string | undefined {
  // Intakes carry only the tracker's status, which manual requests lack.
  return (
    row.status ?? row.type ?? (kind === "intakes" ? "received" : undefined)
  );
}

const needs: Record<string, [string[], string]> = {
  "spec.submit": [["draft"], "Only a draft can be submitted for review"],
  "plan.submit": [["draft"], "Only a draft can be submitted for review"],
  "spec.approve": [["review"], "Submit it for review before approving"],
  "plan.approve": [["review"], "Submit it for review before approving"],
  "plan.propose": [
    ["approved"],
    "Approve the specification before proposing a plan",
  ],
  "execution.create": [["approved"], "Approve the plan before starting it"],
  "execution.export": [
    ["verified_pending_review"],
    "A local export can be requested once the run is verified and awaiting review",
  ],
};

/** Why a Sindri-routed action cannot be sent right now; an empty string when it can. */
export function actionBlock(
  action: string,
  status: unknown,
  session: { operator?: boolean; pairedSindri?: boolean },
): string {
  if (!session.operator)
    return "Unlock operator controls under Connections first.";
  if (!session.pairedSindri) return "Pair with Sindri under Connections first.";
  const rule = needs[action];
  if (rule && !rule[0].includes(String(status)))
    return `${rule[1]} (status is ${status ?? "not reported"}).`;
  return "";
}

/** The spec.revise body holding only what the person changed, or null when nothing changed. */
export function specRevision(
  spec: R,
  edits: { title: string; problem: string; goals: string },
): R | null {
  const body: R = {};
  if (edits.problem !== spec.body.problem) body.problem = edits.problem;
  if (edits.goals !== (spec.body.goals ?? []).join("\n"))
    body.goals = edits.goals.split("\n").filter(Boolean);
  const revision: R = {
    ...(edits.title !== spec.title ? { title: edits.title } : {}),
    ...(Object.keys(body).length ? { body } : {}),
  };
  return Object.keys(revision).length ? revision : null;
}

/** Adds a freshly fetched first page to the events already loaded, newest first, without dropping older pages. */
export function mergeEventPages(fresh: R[], loaded: R[]): R[] {
  const bySequence = new Map<number, R>();
  for (const e of [...loaded, ...fresh]) bySequence.set(e.cacheSequence, e);
  return [...bySequence.values()].sort(
    (a, b) => b.cacheSequence - a.cacheSequence,
  );
}

/** A repository path compared as Mimir stores it: older Sindri rows keep a typed trailing slash. */
export const repoKey = (path: unknown): string =>
  typeof path === "string" && path ? path.replace(/\/+$/, "") || "/" : "";
/** Whether two repository paths name the same repository; never true for missing paths. */
export const sameRepo = (a: unknown, b: unknown): boolean =>
  !!repoKey(a) && repoKey(a) === repoKey(b);

/** Stable across the switch from a Sindri-only project to Mimir's record of the same repository. */
export const projectKey = (p: R): string => repoKey(p.repoPath) || p.id;

/** One row per repository: Mimir's record (under Sindri's name) once it exists, Sindri's otherwise. */
export function mergeProjects(mimir: R[], sindri: R[]): R[] {
  return [
    ...mimir.map((p) => ({
      ...p,
      name:
        sindri.find((sp) => sameRepo(sp.repoPath, p.repoPath))?.name ?? p.name,
    })),
    ...sindri.filter(
      (sp) => !mimir.some((mp) => sameRepo(mp.repoPath, sp.repoPath)),
    ),
  ];
}

/** Every ID one repository is known by, so archiving survives the ID change when a run starts. */
export function projectAliases(p: R, sindri: R[]): string[] {
  return [
    ...new Set([
      p.id,
      ...sindri
        .filter((sp) => sameRepo(sp.repoPath, p.repoPath))
        .map((sp) => sp.id),
    ]),
  ];
}

/**
 * The request text a specification is drafted from when it starts from a saved intake. Sindri
 * stores an empty body for a ticket without a description and refuses an empty request.
 */
export function intakeRequest(intake: R): string {
  return intake.body?.trim() ? intake.body : intake.title;
}

/** A delivery row is an execution; its plan or specification names what was delivered. */
export function deliveryTitle(
  row: R,
  executions: R[],
  specs: R[],
): string | undefined {
  const plan = executions.find(
    (e) => e.execution?.id === (row.executionId ?? row.id),
  )?.plan;
  return (
    specs.find((spec) => spec.id === plan?.specId)?.title ??
    plan?.title ??
    // A research question or a pull request's title, from the snapshot's summary.
    (row.work?.title || undefined)
  );
}

export const recordLabel = (r: R) =>
  r.title ??
  r.objective ??
  r.name ??
  r.template ??
  r.action ??
  (r.agentKind ? `${r.agentKind} · ${r.role}` : null) ??
  r.type ??
  r.id;

export const runTitle = (e: R, specs: R[]): string =>
  specs.find((spec) => spec.id === e.plan?.specId)?.title ??
  e.plan?.title ??
  "Run " + e.execution.id;

/** The specification behind the run that created a Mimir mission, when Sindri started it. */
export const missionSpecTitle = (
  mission: R,
  executions: R[],
  specs: R[],
): string | undefined =>
  specs.find(
    (spec) =>
      spec.id ===
      executions.find((e) => e.execution.mimirMissionId === mission.id)?.plan
        ?.specId,
  )?.title;
