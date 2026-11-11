// Operator pages in the bottom bar: Notifications and Connections (services, access, display,
// audit), plus the unlock and pairing forms the bottom-bar session popover reuses.
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGroup,
  Cluster,
  DataTable,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValue,
  Page,
  PageHeader,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Timestamp,
  Toolbar,
  type Column,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import { download, post, type R } from "../lib/api";
import { navigate } from "../lib/router";
import { DEFAULT_STAGES } from "../pages/Pipeline";
import { FeedbackGraphStatus } from "./Autonomy";
import { newAlerts, toggleDesktopAlerts } from "./alerts";
import { scopeOf, scopedNotifications } from "./scope";

const LOCKED = "Unlock operator controls under Connections first.";
const NOTIFICATIONS_PER_PAGE = 10;
const AUDIT_PER_PAGE = 8;

/** Bottom-bar page: Heimdall's notifications, for every project or the selected one. */
export function NotificationsPage() {
  const { state, scope, projectName, open, notify, savePreferences, href } =
    useHeimdall();
  const [filter, setFilter] = useState("unread");
  const [facet, setFacet] = useState("all");
  const [page, setPage] = useState(1);
  const desktop = !!state?.preferences?.desktopNotifications;
  // The page is global; the facet narrows it to the picker's project when one is selected.
  const narrowed = facet === "selected" && projectName !== null;
  const items = scopedNotifications(
    state?.notifications ?? [],
    narrowed ? scope : scopeOf(state, "all"),
  );
  const rows = items.filter(
    (n) => filter === "all" || (filter === "unread" ? !n.seen : n.active),
  );
  const pageCount = Math.max(
    1,
    Math.ceil(rows.length / NOTIFICATIONS_PER_PAGE),
  );
  const current = Math.min(page, pageCount);
  const unread = rows.filter((n) => !n.seen);

  // The snapshot stream brings the read state back; nothing to refresh here.
  const read = (id: string) =>
    void post("notifications/read", { id }).catch((e) =>
      notify(e.message, "danger"),
    );
  const inspect = (n: R) => {
    if (!n.seen) read(n.id);
    if (n.kind === "connection") navigate(href("connections", {}, "services"));
    else open(n.kind, n.row ?? {});
  };
  const toggleDesktop = () =>
    toggleDesktopAlerts(
      desktop,
      "Notification" in window ? () => Notification.requestPermission() : null,
      savePreferences,
      (message) => notify(message, "warning"),
    );

  const columns: Column<R>[] = [
    {
      key: "title",
      header: "Notification",
      primary: true,
      cell: (n) => (
        <span className="break-words">{String(n.title ?? n.id)}</span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      cell: (n) => (
        <Status value={n.severity} domain="notification" size="sm" />
      ),
    },
    {
      key: "at",
      header: "Time",
      cell: (n) => (n.at ? <Timestamp value={String(n.at)} /> : "Not reported"),
    },
    {
      key: "state",
      header: "State",
      cell: (n) => (
        <span className="text-sm text-muted">
          {n.active ? "Active" : "Resolved or no longer present"} ·{" "}
          {n.seen ? "Read" : <Badge tone="accent">Unread</Badge>}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      label: "Actions",
      cell: (n) =>
        n.seen ? null : (
          <Button size="sm" variant="ghost" onClick={() => read(n.id)}>
            Mark read
          </Button>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Notifications"
        description={
          <>
            Problems, decisions and completions Heimdall noticed across the
            factory.
          </>
        }
        learnMore={<LearnMore screen="notifications" />}
        scope={narrowed ? { project: projectName } : { global: true }}
        actions={
          <Cluster gap={4}>
            <Switch
              label="Enable desktop alerts"
              checked={desktop}
              onCheckedChange={() => void toggleDesktop()}
            />
            <Button
              disabledReason={
                unread.length ? undefined : "Everything in this view is read."
              }
              onClick={() => unread.forEach((n) => read(n.id))}
            >
              Mark view read
            </Button>
          </Cluster>
        }
      />
      <Card flush>
        <div className="border-b border-line p-4">
          <Toolbar label="Notification filters">
            <SegmentedControl
              label="Notification filter"
              value={filter}
              onValueChange={(value) => {
                setFilter(value);
                setPage(1);
              }}
              options={[
                { value: "unread", label: "Unread" },
                { value: "active", label: "Still active" },
                { value: "all", label: "All recent" },
              ]}
            />
            <Select
              aria-label="Project"
              className="min-w-0 sm:w-56"
              value={narrowed ? "selected" : "all"}
              onValueChange={(value) => {
                setFacet(value);
                setPage(1);
              }}
              options={[
                { value: "all", label: "All projects" },
                ...(projectName
                  ? [{ value: "selected", label: projectName }]
                  : []),
              ]}
            />
          </Toolbar>
        </div>
        <DataTable
          caption="Notifications"
          columns={columns}
          rows={rows.slice(
            (current - 1) * NOTIFICATIONS_PER_PAGE,
            current * NOTIFICATIONS_PER_PAGE,
          )}
          rowKey={(n) => String(n.id)}
          onRowClick={inspect}
          rowLabel={(n) => `Open ${n.title ?? n.id}`}
          layout="stack"
          empty={
            <EmptyState
              compact
              className="m-4"
              title="No notifications in this view."
              action={
                filter !== "all" && (
                  <Button size="sm" onClick={() => setFilter("all")}>
                    Show all recent
                  </Button>
                )
              }
            />
          }
        />
        <Pagination
          page={current}
          pageCount={pageCount}
          onPageChange={setPage}
          className="p-4"
        />
      </Card>
    </Page>
  );
}

/** Desktop alerts for new active, unread notifications (only after the first snapshot). */
export function useDesktopAlerts(
  items: R[] | undefined,
  enabled: boolean,
  onInspect: (k: string, r: R) => void,
  shown?: (n: R) => boolean,
) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const [next, fresh] = newAlerts(seen.current, items, shown);
    seen.current = next;
    for (const n of fresh) {
      if (
        enabled &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        const alert = new Notification("Heimdall · " + n.severity, {
          body: n.title,
          tag: n.id,
        });
        alert.onclick = () => {
          window.focus();
          onInspect(n.kind, n.row);
          alert.close();
        };
      }
    }
  }, [items, enabled]);
}

const SECTIONS = ["services", "access", "display", "audit"] as const;

/** Bottom-bar page: source connections, operator access, display settings and the audit log. */
export function ConnectionsPage({ section }: { section: string }) {
  const { api, state, session, notify, savePreferences, href } = useHeimdall();
  const [auditPage, setAuditPage] = useState(1);
  const value = (SECTIONS as readonly string[]).includes(section)
    ? section
    : "services";
  const audit: R[] = state?.audit ?? [];
  const auditPages = Math.max(1, Math.ceil(audit.length / AUDIT_PER_PAGE));
  const auditCurrent = Math.min(auditPage, auditPages);
  const sources: R = state?.sources ?? {};

  const auditColumns: Column<R>[] = [
    {
      key: "at",
      header: "Time",
      cell: (a) => (a.at ? <Timestamp value={String(a.at)} /> : "Not reported"),
    },
    {
      key: "action",
      header: "Action",
      primary: true,
      cell: (a) => (
        <code className="text-xs break-all">{String(a.action ?? "")}</code>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      cell: (a) => <Status value={a.outcome} size="sm" />,
    },
    {
      key: "reason",
      header: "Reason",
      cell: (a) => (
        <span className="break-words">{a.reason ? String(a.reason) : "—"}</span>
      ),
    },
  ];

  const services = (
    <Stack gap={4}>
      <CardGroup min={320}>
        {(["mimir", "sindri"] as const).map((name) => {
          const source: R | undefined = sources[name];
          const label = name === "mimir" ? "Mimir" : "Sindri";
          return (
            <Card
              key={name}
              title={label}
              term={label}
              actions={<Status value={source?.status} domain="source" />}
            >
              <Stack gap={4}>
                <KeyValue
                  columns={1}
                  items={[
                    {
                      label: "Service origin",
                      value: (
                        <span className="break-all">
                          {source?.url ?? "Optional connection not configured"}
                        </span>
                      ),
                    },
                    {
                      label: "Last successful snapshot",
                      term: "Snapshot",
                      value: source?.lastSuccess ? (
                        <Timestamp value={String(source.lastSuccess)} />
                      ) : (
                        "Not reported"
                      ),
                    },
                    {
                      label: "Event stream",
                      term: "Event stream",
                      value: (
                        <span className="break-words">
                          {source?.stream ?? "Waiting for execution streams"}
                        </span>
                      ),
                    },
                  ]}
                />
                {source?.error && (
                  <Callout tone="danger" title={`${label} reported an error`}>
                    <span className="break-words">{String(source.error)}</span>
                  </Callout>
                )}
                <ConnectionEditor
                  source={name}
                  current={source}
                  enabled={!!session.operator}
                  send={(value) => post("connections", value)}
                />
              </Stack>
            </Card>
          );
        })}
      </CardGroup>
      {sources.sindri?.status === "connected" && <FeedbackGraphStatus />}
    </Stack>
  );

  const access = (
    <CardGroup min={320}>
      <Card
        title="Operator controls"
        term="Operator controls"
        description="Monitoring is read-only by default. Enter Heimdall's operator code from the Terminal to unlock controls."
      >
        <UnlockForm />
      </Card>
      <Card
        title="Sindri human approval"
        term="Approval pairing code"
        description="Specification, plan and integrated execution decisions keep Sindri's separate human approval check."
      >
        <PairForm />
      </Card>
    </CardGroup>
  );

  const display = (
    <Card title="Display preferences">
      <Stack gap={4}>
        <PipelineSettings
          stages={state?.preferences?.stages ?? DEFAULT_STAGES}
          onSave={(stages) =>
            void savePreferences({ stages }).catch((e) =>
              notify(e.message, "danger"),
            )
          }
        />
        <Cluster>
          <Button
            icon="external"
            onClick={() =>
              void api("config")
                .then((config) =>
                  download(
                    "heimdall-configuration.json",
                    JSON.stringify(config, null, 2),
                    "application/json",
                  ),
                )
                .catch((e) => notify(e.message, "danger"))
            }
          >
            Export configuration (no credentials)
          </Button>
        </Cluster>
      </Stack>
    </Card>
  );

  const auditTab = (
    <Card
      title="Operator audit"
      count={audit.length}
      description="Heimdall stores its own display cache, cursors and audit receipts. It does not edit factory databases."
      flush
    >
      <DataTable
        caption="Operator audit receipts"
        columns={auditColumns}
        rows={audit.slice(
          (auditCurrent - 1) * AUDIT_PER_PAGE,
          auditCurrent * AUDIT_PER_PAGE,
        )}
        rowKey={(a) => String(a.id ?? `${a.at}:${a.action}`)}
        layout="stack"
        empty={
          <EmptyState
            compact
            className="m-4"
            title="No operator actions recorded yet."
            body="Every confirmed command leaves a receipt here."
          />
        }
      />
      <Pagination
        page={auditCurrent}
        pageCount={auditPages}
        onPageChange={setAuditPage}
        className="p-4"
      />
    </Card>
  );

  return (
    <Page>
      <PageHeader
        title="Connections"
        description={
          <>
            How Heimdall reaches Mimir and Sindri, who may act, and what
            operators did.
          </>
        }
        learnMore={<LearnMore screen="connections" />}
        scope={{ global: true }}
      />
      <Tabs
        label="Connection settings sections"
        value={value}
        onValueChange={(v) =>
          navigate(href("connections", {}, v), { replace: true })
        }
        items={[
          { value: "services", label: "Services", content: services },
          { value: "access", label: "Access", content: access },
          { value: "display", label: "Display", content: display },
          {
            value: "audit",
            label: "Audit history",
            count: audit.length,
            content: auditTab,
          },
        ]}
      />
    </Page>
  );
}

/** Operator unlock: the code Heimdall printed in its Terminal window. */
export function UnlockForm() {
  const { session, refreshSession, notify } = useHeimdall();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    try {
      await post("unlock", { code });
      setCode("");
      await refreshSession();
    } catch (err) {
      notify((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Cluster gap={2}>
        <span className="text-sm text-muted">Session</span>
        <Status
          value={session.operator ? "unlocked" : "read_only"}
          domain="operator"
        />
      </Cluster>
      <Field label="Heimdall operator code" term="Operator code">
        <Input
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Cluster>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabledReason={code ? undefined : "Enter the operator code first."}
        >
          {session.operator ? "Unlock again" : "Unlock controls"}
        </Button>
      </Cluster>
    </form>
  );
}

/** Sindri approval pairing; needs the operator unlock first. */
export function PairForm() {
  const { session, refreshSession, notify } = useHeimdall();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const why = !session.operator
    ? "Unlock operator controls first."
    : code
      ? ""
      : "Enter the pairing code first.";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (why || busy) return;
    setBusy(true);
    try {
      await post("pair", { code });
      setCode("");
      await refreshSession();
      notify("Sindri approval session paired.", "success");
    } catch (err) {
      notify((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Cluster gap={2}>
        <span className="text-sm text-muted">Approval session</span>
        <Status
          value={session.pairedSindri ? "paired" : "not_paired"}
          domain="pairing"
        />
      </Cluster>
      <Field label="Sindri pairing code" term="Approval pairing code">
        <Input
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Cluster>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabledReason={why || undefined}
        >
          Pair approval session
        </Button>
      </Cluster>
    </form>
  );
}

/** Origin and token for one source. Tokens never come back to the browser. */
export function ConnectionEditor({
  source,
  current,
  enabled,
  send,
}: {
  source: string;
  current?: R | undefined;
  enabled: boolean;
  send: (b: R) => Promise<unknown>;
}) {
  const [url, setUrl] = useState(current?.url ?? ""),
    [token, setToken] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => setUrl(current?.url ?? ""), [current?.url]);
  const name =
    source === "mimir" ? "Mimir" : source === "sindri" ? "Sindri" : source;
  async function act(action: string) {
    setBusy(true);
    try {
      await send({ source, url, token, action });
      setStatus(
        action === "test"
          ? "Authentication check passed."
          : action === "disconnect"
            ? "Disconnected."
            : "Connection saved. Approval pairing must be renewed.",
      );
      setToken("");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const actions = [
    ["test", "Test connection"],
    ["save", "Save connection"],
    ["disconnect", "Disconnect"],
  ] as const;
  return (
    <Disclosure title={`Configure ${name} connection`}>
      <Stack gap={4}>
        <p className="text-sm text-muted">
          Loopback HTTP only. Source tokens are stored privately on this Mac and
          never returned to the browser. Changing a connection clears its old
          display cache and approval pairing.
        </p>
        <Field label="Service origin">
          <Input
            value={url}
            placeholder={
              source === "mimir"
                ? "http://127.0.0.1:7700"
                : "http://127.0.0.1:4310"
            }
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Source access token" term="Access token">
          <Input
            type="password"
            value={token}
            autoComplete="off"
            placeholder="Leave blank to keep the current token"
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Cluster gap={2}>
          {actions.map(([action, label]) => (
            <Button
              key={action}
              variant={
                action === "save"
                  ? "primary"
                  : action === "disconnect"
                    ? "danger"
                    : "secondary"
              }
              loading={busy}
              disabledReason={
                !enabled
                  ? LOCKED
                  : action !== "disconnect" && !url
                    ? "Enter the service origin first."
                    : undefined
              }
              onClick={() => void act(action)}
            >
              {label}
            </Button>
          ))}
        </Cluster>
        <p role="status" className="text-sm break-words">
          {status}
        </p>
      </Stack>
    </Disclosure>
  );
}

/** Pipeline column order: presentation only, stages still come from the source states. */
export function PipelineSettings({
  stages,
  onSave,
}: {
  stages: string[];
  onSave: (stages: string[]) => void;
}) {
  const [order, setOrder] = useState(stages);
  const move = (i: number, by: -1 | 1) =>
    setOrder((a) => {
      const b = [...a];
      [b[i + by], b[i]] = [b[i], b[i + by]];
      return b;
    });
  return (
    <Disclosure title="Configure pipeline stage order">
      <Stack gap={4}>
        <p className="text-sm text-muted">
          This changes presentation only. Stages still come from authoritative
          source states.
        </p>
        <ol
          aria-label="Stage order"
          className="flex flex-col divide-y divide-line rounded-md border border-line"
        >
          {order.map((s, i) => (
            <li
              key={s}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <span className="min-w-0 break-words">{s}</span>
              <Cluster gap={1}>
                <IconButton
                  icon="chevronUp"
                  size="sm"
                  variant="ghost"
                  label={"Move " + s + " earlier"}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <IconButton
                  icon="chevronDown"
                  size="sm"
                  variant="ghost"
                  label={"Move " + s + " later"}
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                />
              </Cluster>
            </li>
          ))}
        </ol>
        <Cluster>
          <Button onClick={() => onSave(order)}>Save stage order</Button>
        </Cluster>
      </Stack>
    </Disclosure>
  );
}
