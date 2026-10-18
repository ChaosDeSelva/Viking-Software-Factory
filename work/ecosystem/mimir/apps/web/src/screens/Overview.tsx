import { useMemo } from "react";
import { Link } from "react-router";
import { ProgressText, StatusBadge, UsageChips } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { deriveAttention, taskProgress } from "../lib/derive.js";
import { useAsync } from "../lib/useAsync.js";
import { useNow } from "../lib/useNow.js";
import { useStore } from "../store/StoreProvider.js";
import type { AttentionItem } from "../api/client.js";

function attentionLink(item: AttentionItem): { to: string; label: string } | null {
  if (item.kind === "approval") return { to: "/reviews", label: "Review" };
  if (item.sessionId) return { to: `/agents/${item.sessionId}`, label: "Inspect agent" };
  if (item.missionId) return { to: `/missions/${item.missionId}`, label: "Open mission" };
  return null;
}

function FleetHealth() {
  const { client } = useStore();
  const health = useAsync(() => client.health(), "health");
  const caps = useAsync(() => client.capabilities(), "caps");
  return (
    <Section title="Fleet health">
      {health.status === "loading" || caps.status === "loading" ? (
        <LoadingState label="fleet health" />
      ) : health.status === "error" ? (
        <ErrorState message={health.error} onRetry={health.reload} />
      ) : caps.status === "error" ? (
        <ErrorState message={caps.error} onRetry={caps.reload} />
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-medium">Server</dt>
          <dd>{health.data.status}</dd>
          <dt className="font-medium">Runtime</dt>
          <dd>
            {caps.data.runtime
              ? `${caps.data.runtime.runtime} ${caps.data.runtime.version}${
                  health.data.runtime
                    ? health.data.runtime.ok
                      ? " (healthy)"
                      : ` (unhealthy: ${health.data.runtime.detail ?? "no detail"})`
                    : ""
                }`
              : "No runtime configured"}
          </dd>
          {caps.data.runtime && (
            <>
              <dt className="font-medium">Capabilities</dt>
              <dd>
                {Object.entries(caps.data.runtime.features)
                  .filter(([, on]) => on)
                  .map(([k]) => k)
                  .join(", ") || "none"}
              </dd>
              <dt className="font-medium">Agent kinds</dt>
              <dd>{caps.data.runtime.agentKinds.join(", ") || "none"}</dd>
            </>
          )}
        </dl>
      )}
    </Section>
  );
}

export function Overview() {
  const { state } = useStore();
  const now = useNow(30_000);
  const attention = useMemo(() => deriveAttention(state, now), [state, now]);
  const activeCrews = state.crews.filter(
    (c) => c.status === "running" || c.status === "configured",
  );
  const recent = state.events.slice(-10);

  return (
    <>
      <PageTitle>Overview</PageTitle>
      <StoreGate label="overview">
        <Section title="Needs attention">
          {attention.length === 0 ? (
            <EmptyState>Nothing needs attention.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {attention.map((item) => {
                const link = attentionLink(item);
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-amber-700 px-2 py-1"
                  >
                    <StatusBadge status={item.kind === "approval" ? "pending" : item.kind} />
                    <span className="font-medium">{item.title}</span>
                    {item.detail && (
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">
                        {item.detail}
                      </span>
                    )}
                    {link && (
                      <Link className="ml-auto underline" to={link.to}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
        <FleetHealth />
        <Section title="Active crews">
          {activeCrews.length === 0 ? (
            <EmptyState>No active crews.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {activeCrews.map((c) => {
                const m = state.missions.find((x) => x.id === c.missionId);
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <Link className="underline" to={`/crews/${c.id}`}>
                      {c.template} crew
                    </Link>
                    <StatusBadge status={c.status} />
                    <span className="text-sm">{m ? m.objective : c.missionId}</span>
                    <span className="text-sm">
                      <ProgressText progress={taskProgress(state.tasks, c.missionId)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
        <Section title="Recent events">
          <EventList events={recent} />
        </Section>
        <Section title="Usage">
          {state.usage ? (
            <UsageChips totals={state.usage} />
          ) : (
            <EmptyState>No usage reported.</EmptyState>
          )}
        </Section>
      </StoreGate>
    </>
  );
}
