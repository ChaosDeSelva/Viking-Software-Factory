import type { ProjectId } from "@mimir/protocol";
import { Badge, CardGroup, KeyValue, Link, MetricCard, RecordList, RecordRow } from "@factory/ui";
import { useMemo } from "react";
import type { AttentionItem } from "../api/client.js";
import { ActionLink } from "../components/ActionLink.js";
import { ProgressText, StatusBadge, UsageChips } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { deriveAttention, taskProgress } from "../lib/derive.js";
import { crewEffectiveStatus, crewLabel, isCrewActive, missionName } from "../lib/names.js";
import { attentionInScope, useProjectScope, useScoped } from "../lib/scope.js";
import { useAsync } from "../lib/useAsync.js";
import { useNow } from "../lib/useNow.js";
import { useStore } from "../store/StoreProvider.js";

function attentionLink(item: AttentionItem): { to: string; label: string } | null {
  if (item.kind === "approval") return { to: "/reviews", label: "Review" };
  if (item.sessionId) return { to: `/agents/${item.sessionId}`, label: "Inspect agent" };
  if (item.missionId) return { to: `/missions/${item.missionId}`, label: "Open mission" };
  return null;
}

/** Runtime capability flags, in words. */
const FEATURE_LABEL: Record<string, string> = {
  createSession: "Start sessions",
  softStop: "Soft stop",
  forceStop: "Force stop",
  terminalRead: "Read terminal",
  sendInput: "Send instructions",
  events: "Event stream",
};

function FleetHealth() {
  const { client } = useStore();
  const health = useAsync(() => client.health(), "health");
  const caps = useAsync(() => client.capabilities(), "caps");
  return (
    <Section
      title="Fleet health"
      term="Runtime"
      description="The Mimir server and the runtime that hosts agent sessions."
    >
      {health.status === "loading" || caps.status === "loading" ? (
        <LoadingState label="fleet health" lines={2} />
      ) : health.status === "error" ? (
        <ErrorState message={health.error} onRetry={health.reload} />
      ) : caps.status === "error" ? (
        <ErrorState message={caps.error} onRetry={caps.reload} />
      ) : (
        <KeyValue
          items={[
            {
              label: "Server",
              value: <StatusBadge status={health.data.status} />,
            },
            {
              label: "Runtime",
              term: "Runtime",
              value: caps.data.runtime
                ? `${caps.data.runtime.runtime} ${caps.data.runtime.version}${
                    health.data.runtime
                      ? health.data.runtime.ok
                        ? " (healthy)"
                        : ` (unhealthy: ${health.data.runtime.detail ?? "no detail"})`
                      : ""
                  }`
                : "No runtime configured",
            },
            ...(caps.data.runtime
              ? [
                  {
                    label: "Capabilities",
                    term: "Capabilities",
                    value: (
                      <span className="flex flex-wrap gap-1">
                        {Object.entries(caps.data.runtime.features)
                          .filter(([, on]) => on)
                          .map(([k]) => (
                            <Badge key={k} tooltip={k}>
                              {FEATURE_LABEL[k] ?? k}
                            </Badge>
                          ))}
                        {!Object.values(caps.data.runtime.features).some(Boolean) && "none"}
                      </span>
                    ),
                  },
                  {
                    label: "Agent kinds",
                    term: "Agent kind",
                    value: caps.data.runtime.agentKinds.join(", ") || "none",
                  },
                ]
              : []),
          ]}
        />
      )}
    </Section>
  );
}

/** Usage for the selected project from the server, or the snapshot totals for All projects. */
function Usage() {
  const { client, state } = useStore();
  const { projectId } = useProjectScope();
  const scoped = useAsync(
    () =>
      projectId ? client.usage.get({ projectId: projectId as ProjectId }) : Promise.resolve(null),
    `usage:${projectId ?? "all"}`,
  );
  const totals = projectId ? scoped.data?.totals : state.usage;
  return (
    <Section
      title="Usage"
      term="Usage source"
      description="Tokens and estimated cost reported by agents."
    >
      {projectId && scoped.status === "loading" ? (
        <LoadingState label="usage" lines={1} />
      ) : projectId && scoped.status === "error" ? (
        <ErrorState message={scoped.error} onRetry={scoped.reload} />
      ) : totals ? (
        <UsageChips totals={totals} />
      ) : (
        <EmptyState body="Agents report usage as they work.">No usage reported</EmptyState>
      )}
    </Section>
  );
}

export function Overview() {
  const { state } = useStore();
  const scoped = useScoped();
  const now = useNow(30_000);
  const attention = useMemo(
    () => deriveAttention({ ...state, ...scoped }, now).filter((i) => attentionInScope(i, scoped)),
    [state, scoped, now],
  );
  const missionById = useMemo(
    () => new Map(scoped.missions.map((m) => [m.id as string, m])),
    [scoped.missions],
  );
  const activeCrews = scoped.crews.filter((c) => isCrewActive(c, missionById.get(c.missionId)));
  const activeMissions = scoped.missions.filter(
    (m) => m.status === "active" || m.status === "paused",
  );
  const running = scoped.tasks.filter(
    (t) => t.status === "running" || t.status === "leased" || t.status === "verifying",
  );
  const pending = scoped.approvals.filter((a) => a.status === "pending");
  const recent = scoped.events.slice(-10);

  return (
    <Screen
      screen="overview"
      title="Overview"
      description="What needs you, what is running now, and the health of the fleet."
    >
      <StoreGate label="overview">
        <CardGroup min={150}>
          <MetricCard
            label="Needs attention"
            term="Needs attention"
            value={attention.length}
            href="#needs-attention"
          />
          <MetricCard
            label="Active missions"
            term="Mission"
            value={activeMissions.length}
            href="/missions"
          />
          <MetricCard label="Tasks running" term="Task" value={running.length} href="/missions" />
          <MetricCard
            label="Pending approvals"
            term="Approval"
            value={pending.length}
            href="/reviews"
          />
        </CardGroup>
        <div id="needs-attention" className="scroll-mt-20">
          <Section
            title="Needs attention"
            term="Needs attention"
            count={attention.length}
            flush={attention.length > 0}
          >
            {attention.length === 0 ? (
              <EmptyState
                icon="check"
                body="No pending approvals, blocked or stuck tasks, budget alerts or unknown agents."
              >
                Nothing needs attention
              </EmptyState>
            ) : (
              <RecordList label="Needs attention">
                {attention.map((item) => {
                  const link = attentionLink(item);
                  const status = (
                    <StatusBadge status={item.kind} domain="attention" tooltip={false} />
                  );
                  // Items with nowhere to go are plain rows, not dead buttons.
                  return link ? (
                    <RecordRow
                      key={item.id}
                      href={link.to}
                      title={item.title}
                      meta={item.detail}
                      status={
                        <span className="flex items-center gap-2">
                          {status}
                          <span className="text-sm font-medium text-accent-fg">{link.label}</span>
                        </span>
                      }
                    />
                  ) : (
                    <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium">{item.title}</span>
                        {item.detail && (
                          <span className="truncate text-xs text-muted">{item.detail}</span>
                        )}
                      </span>
                      {status}
                    </div>
                  );
                })}
              </RecordList>
            )}
          </Section>
        </div>
        <Section
          title="Active crews"
          term="Crew"
          count={activeCrews.length}
          description="Crews whose mission can still run work. Finished missions' crews are on the Crews page."
          flush={activeCrews.length > 0}
        >
          {activeCrews.length === 0 ? (
            <EmptyState
              body="A crew becomes active when its mission starts."
              action={<ActionLink href="/missions">Open missions</ActionLink>}
            >
              No active crews
            </EmptyState>
          ) : (
            <RecordList label="Active crews">
              {activeCrews.map((c) => {
                const m = missionById.get(c.missionId);
                const status = crewEffectiveStatus(c, m, scoped.agents);
                return (
                  <RecordRow
                    key={c.id}
                    href={`/crews/${c.id}`}
                    title={`${crewLabel(c)} · ${m ? missionName(m, scoped.tasks) : c.missionId}`}
                    meta={<ProgressText progress={taskProgress(scoped.tasks, c.missionId)} />}
                    status={
                      <StatusBadge status={status.value} domain={status.domain} tooltip={false} />
                    }
                  />
                );
              })}
            </RecordList>
          )}
        </Section>
        <CardGroup min={360}>
          <Section
            title="Recent events"
            term="Event stream"
            description="Live events since this page opened."
            actions={
              <Link href="/activity" className="text-sm font-medium text-accent-fg">
                Open Activity
              </Link>
            }
          >
            <EventList
              events={recent}
              tasks={scoped.tasks}
              empty="No events since this page opened"
              emptyBody="Events appear here as they stream in. Activity can replay older events."
              emptyAction={<ActionLink href="/activity">Replay history in Activity</ActionLink>}
            />
          </Section>
          <div className="flex min-w-0 flex-col gap-group">
            <FleetHealth />
            <Usage />
          </div>
        </CardGroup>
      </StoreGate>
    </Screen>
  );
}
