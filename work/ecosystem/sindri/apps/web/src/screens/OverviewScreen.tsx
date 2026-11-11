import {
  CardGroup,
  EmptyState,
  Grid,
  GridItem,
  MetricCard,
  Page,
  RecordList,
  RecordRow,
  Stack,
} from "@factory/ui";
import type { ExecutionSummary, Plan, ReviewsInbox } from "../api/delivery-types.js";
import type { Decision } from "../api/steward-types.js";
import type { Intake, Spec } from "../api/types.js";
import { AskGuide } from "../components/Layout.js";
import { Button, LoadState, ScreenHeader, Status, Card } from "../components/ui.js";
import { useApi, useLoad, useStore } from "../store/context.js";
import { runNumbers } from "./RunsScreen.js";
import { routeHash } from "../store/route.js";
import type { View } from "../store/reducer.js";

/** One failed source must not blank the whole dashboard: each part is null when it failed. */
interface Snapshot {
  intakes: Intake[] | null;
  specs: Spec[] | null;
  plans: Plan[] | null;
  runs: ExecutionSummary[] | null;
  deliveries: ExecutionSummary[] | null;
  reviews: ReviewsInbox | null;
  decisions: Decision[] | null;
}

const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

const ACTIVE_RUNS = new Set([
  "pending",
  "running",
  "awaiting_human",
  "blocked",
  "replan_requested",
]);
const FINISHED_RUNS = new Set(["verified_pending_review", "delivered_pending_merge"]);

const count = (xs: { status: string | null }[] | null, keep?: (s: string) => boolean) =>
  xs === null ? "—" : keep ? xs.filter((x) => keep(x.status ?? "")).length : xs.length;

/** Three starter questions for the Guide, picked from what is going on in the project. */
export function suggestedQuestions(s: Snapshot | null): string[] {
  const out: string[] = [];
  if ((s?.reviews?.escalations.length ?? 0) > 0)
    out.push("Why is a task escalated and what should I do?");
  if ((s?.reviews?.budgetAlerts.length ?? 0) > 0)
    out.push("A run is blocked by its budget. How do I raise it?");
  if ((s?.reviews?.approvals.length ?? 0) > 0) out.push("What is waiting for my approval?");
  if ((s?.decisions?.length ?? 0) > 0) out.push("What does the steward want me to decide?");
  if (s?.runs?.some((r) => r.status === "verified_pending_review"))
    out.push("A run is verified pending review. What do I do next?");
  out.push("What should I do next in this project?", "How does a ticket become a delivery?");
  return [...new Set(out)].slice(0, 3);
}

/**
 * Project dashboard: counts by stage, what needs the operator, recent runs, and the read-only
 * Guide ("Ask the factory"). Every number is for the selected project only.
 */
export function OverviewScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const load = useLoad<Snapshot>(
    projectId
      ? async () => {
          const [intakes, specs, plans, runs, deliveries, reviews, decisions] = await Promise.all([
            settle(api.listIntakes(projectId)),
            settle(api.listSpecs(projectId)),
            settle(api.listPlans(projectId)),
            settle(api.listExecutions(projectId)),
            settle(api.listDeliveries(projectId)),
            settle(api.reviews(projectId)),
            settle(api.listDecisions({ projectId, status: "pending", limit: 20 })),
          ]);
          return { intakes, specs, plans, runs, deliveries, reviews, decisions };
        }
      : null,
    [projectId],
  );
  const href = (view: View, extra: Partial<Parameters<typeof routeHash>[0]> = {}) =>
    routeHash({
      view,
      projectId,
      specId: null,
      planId: null,
      executionId: null,
      deliveryId: null,
      docsSlug: null,
      docsSection: null,
      ...extra,
    });

  if (!projectId)
    return (
      <Page>
        <ScreenHeader
          screen="overview"
          title="Overview"
          description="Where the selected project stands and what needs you."
        />
        <Card>
          <EmptyState
            icon="folder"
            title="No project yet"
            body="Add a repository as a project, then bootstrap it so the Director and planner can read it."
            action={
              <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
                Add a project
              </Button>
            }
          />
        </Card>
      </Page>
    );

  return (
    <Page>
      <ScreenHeader
        screen="overview"
        title="Overview"
        description="Where this project stands, what needs you, and answers about either."
        actions={
          <>
            <Button variant="secondary" icon="refresh" onClick={load.reload}>
              Refresh
            </Button>
            <Button icon="plus" onClick={() => dispatch({ type: "navigate", view: "inbox" })}>
              New idea or ticket
            </Button>
          </>
        }
      />
      <LoadState state={load.state} what="the project overview" onRetry={load.reload}>
        {(s) => (
          <Stack gap={8}>
            <CardGroup min={150}>
              <MetricCard
                label="Inbox"
                term="Inbox"
                value={count(s.intakes)}
                href={href("inbox")}
                description="Ideas and tickets"
              />
              <MetricCard
                label="Specs in review"
                term="Spec"
                value={count(s.specs, (x) => x === "review")}
                href={href("specs")}
                description={`${count(s.specs, (x) => x === "approved")} approved`}
              />
              <MetricCard
                label="Plans to approve"
                term="Plan"
                value={count(s.plans, (x) => x === "review" || x === "draft")}
                href={href("plans")}
                description={`${count(s.plans, (x) => x === "approved")} approved`}
              />
              <MetricCard
                label="Active runs"
                term="Run"
                value={count(s.runs, (x) => ACTIVE_RUNS.has(x))}
                href={href("runs")}
                description={`${count(s.runs, (x) => FINISHED_RUNS.has(x))} verified or delivered`}
              />
              <MetricCard
                label="Deliveries"
                term="Delivery"
                value={count(s.deliveries)}
                href={href("deliveries")}
                description="Verified results to review"
              />
            </CardGroup>
            <Grid gap={6}>
              <GridItem span={7}>
                <Stack gap={6}>
                  <NeedsYou s={s} href={href} />
                  <RecentRuns runs={s.runs} href={href} />
                </Stack>
              </GridItem>
              <GridItem span={5}>
                <Card>
                  <AskGuide
                    screen="overview"
                    suggestions={suggestedQuestions(s)}
                    title="Ask the factory"
                    intro="Plain answers from the docs and this project's state. The Guide never acts; it links to where you do."
                  />
                </Card>
              </GridItem>
            </Grid>
          </Stack>
        )}
      </LoadState>
    </Page>
  );
}

function NeedsYou({ s, href }: { s: Snapshot; href: (v: View, e?: object) => string }) {
  const r = s.reviews;
  const rows = [
    ...(r?.approvals ?? []).map((a) => ({
      key: `a:${a.id}`,
      title: `Approve ${a.action}${a.planTaskId ? ` for ${a.planTaskId}` : ""}`,
      meta: "A gated agent action is waiting",
      status: <Status value="pending" domain="approval" tooltip={false} />,
      to: href("needs-you"),
    })),
    ...(r?.escalations ?? []).map((e) => ({
      key: `e:${e.executionId}:${e.planTaskId}`,
      title: `Escalated: ${e.planTaskId}`,
      meta: `After ${e.attempts} failed attempt(s)`,
      status: <Status value={e.escalation} domain="escalation" tooltip={false} />,
      to: href("needs-you"),
    })),
    ...(r?.budgetAlerts ?? []).map((b) => ({
      key: `b:${b.id}`,
      title: `Budget used up: ${b.planTaskId ?? "mission"}`,
      meta: "Raise the crew budget in Mimir, then retry",
      status: <Status value="budget_exceeded" domain="blocked-reason" tooltip={false} />,
      to: href("needs-you"),
    })),
    ...(s.decisions ?? []).map((d) => ({
      key: `d:${d.id}`,
      title: d.subject.label,
      meta: `Steward recommends: ${d.recommendation.value}`,
      status: <Status value={d.status} domain="steward-decision" tooltip={false} />,
      to: href("autonomy"),
    })),
  ];
  return (
    <Card title="Needs you" term="Needs attention" count={rows.length} flush>
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon="check"
          title="Nothing needs you"
          body={
            r === null
              ? "The review inbox could not be loaded; open Needs you to retry."
              : "No approvals, escalations, budget blocks or steward decisions are waiting."
          }
          className="m-4"
        />
      ) : (
        <RecordList label="Waiting for you">
          {rows.slice(0, 8).map((x) => (
            <RecordRow key={x.key} title={x.title} meta={x.meta} status={x.status} href={x.to} />
          ))}
        </RecordList>
      )}
    </Card>
  );
}

function RecentRuns({
  runs,
  href,
}: {
  runs: ExecutionSummary[] | null;
  href: (v: View, e?: object) => string;
}) {
  const numbers = runNumbers(runs ?? []);
  const recent = [...(runs ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return (
    <Card title="Recent runs" term="Run" count={runs?.length} flush>
      {recent.length === 0 ? (
        <EmptyState
          compact
          icon="clock"
          title={runs === null ? "Runs could not be loaded" : "No runs yet"}
          body="Approve a plan, then start a run from Plans."
          className="m-4"
        />
      ) : (
        <RecordList label="Recent runs">
          {recent.map((r) => (
            <RecordRow
              key={r.id}
              title={`Run ${numbers.get(r.id) ?? "?"} · Plan v${r.planVersion}`}
              meta={`Started ${new Date(r.createdAt).toLocaleString()}`}
              status={<Status value={r.status} domain="run" tooltip={false} />}
              href={href("runs", { executionId: r.id })}
            />
          ))}
        </RecordList>
      )}
    </Card>
  );
}
