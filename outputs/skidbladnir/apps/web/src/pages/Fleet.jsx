import React, { useState } from 'react';
import {
  Button,
  Callout,
  Card,
  CardGroup,
  Cluster,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Id,
  KeyValue,
  Link,
  MetricCard,
  Page,
  PageHeader,
  RecordList,
  RecordRow,
  SkeletonCard,
  SplitView,
  Stack,
  Tabs,
  Timestamp,
  Tooltip,
  useToast,
} from '@factory/ui';
import { screenHref } from '@factory/docs';
import { LearnMore, Status, templateLabel } from '../components.jsx';
import { href, navigate } from '../routes.js';
import { RemoteExecution, TerminalAndFiles, WorkerTimeline } from './WorkerTools.jsx';
import { isActive } from '../../../../packages/contracts/worker.mjs';

const ENDED = ['terminated', 'failed', 'terminating'];

/** Simulation vs cloud, said once at the top of the page in the same words as the docs. */
export function ModeNotice({ aws }) {
  return aws ? (
    <Callout tone="warning" title="Cloud mode">
      Workers are real machines in your AWS account and cost money until they are terminated. Independent expiration is
      checked before every launch.
    </Callout>
  ) : (
    <Callout tone="info" title="Simulation mode">
      Lifecycle and event history work locally. Simulation creates no virtual machines, cloud resources or charges.
    </Callout>
  );
}

/** Page frame shared by the fleet pages: header, mode, provider error, then loading/error/content. */
export function FleetFrame({
  title,
  description,
  screen,
  project,
  actions = undefined,
  fleet,
  aws,
  notice = true,
  detailOpen = false,
  children,
}) {
  return (
    <Page>
      <PageHeader
        title={title}
        description={description}
        learnMore={<LearnMore href={screenHref('skidbladnir', screen)} />}
        scope={{ project }}
        actions={actions}
      />
      {/* On a phone an open detail replaces the list; the simulation notice steps aside for it, but the
          cloud-mode warning stays because actions there cost money. */}
      {fleet.data && notice && (
        <div className={detailOpen && !aws ? 'max-md:hidden' : undefined}>
          <ModeNotice aws={aws} />
        </div>
      )}
      {fleet.data?.providerError && (
        <div role="alert">
          <Callout tone="danger" title="The cloud provider did not answer">
            {fleet.data.providerError}
          </Callout>
        </div>
      )}
      {fleet.sessionError ? (
        <ErrorState
          title="Cannot reach the local API"
          message={fleet.sessionError}
          onRetry={fleet.reconnect}
          retryLabel="Reconnect"
        />
      ) : !fleet.data ? (
        <div aria-busy="true" aria-label="Loading the fleet">
          <SkeletonCard lines={4} />
        </div>
      ) : (
        children
      )}
    </Page>
  );
}

export function FleetPage({ fleet, scoped, project, aws, route, setProject }) {
  const workers = scoped?.workers ?? [];
  const worker = workers.find((w) => w.id === route.workerId);
  const max = fleet.data?.maxWorkers ?? 5;
  const fleetActive = (fleet.data?.workers ?? []).filter(isActive).length;
  const launch = (
    <Tooltip
      content={
        fleetActive >= max
          ? 'The worker limit is reached. Terminate a worker first.'
          : 'Choose a name, template and lifetime for a new worker.'
      }
    >
      <Button variant="primary" icon="plus" onClick={() => navigate(href.launch())}>
        Launch a worker
      </Button>
    </Tooltip>
  );
  return (
    <FleetFrame
      title="Worker fleet"
      description="Launch, inspect and retire disposable workers."
      screen="fleet"
      project={project}
      actions={launch}
      fleet={fleet}
      aws={aws}
      detailOpen={Boolean(worker)}
    >
      <div className={worker ? 'max-md:hidden' : undefined}>
        <CardGroup min={220}>
          <MetricCard
            label="Active workers"
            term="Slot"
            value={`${fleetActive} / ${max}`}
            description={
              project
                ? 'Across all projects: the limit is shared.'
                : aws
                  ? 'Configured fleet limit'
                  : 'Local simulation limit'
            }
          />
          <MetricCard
            label="Running"
            value={workers.filter((w) => w.state === 'running').length}
            description={project ? `In ${project}` : aws ? 'Observed AWS state' : 'Simulated environments'}
          />
          <MetricCard
            label="Cloud spend"
            value={aws ? 'Not measured' : '$0'}
            description={
              aws
                ? 'Review charges in AWS Billing; not measured does not mean free.'
                : 'Simulation creates no resources'
            }
          />
        </CardGroup>
      </div>
      {!workers.length ? (
        <Card>
          <FleetEmpty project={project} total={fleet.data?.workers.length ?? 0} aws={aws} setProject={setProject} />
        </Card>
      ) : (
        <SplitView
          showDetail={Boolean(worker)}
          onBack={() => navigate(href.fleet())}
          backLabel="All workers"
          list={
            <Card title="Workers" count={workers.length} headingLevel={2} flush>
              <RecordList label="Workers">
                {workers.map((w) => (
                  <RecordRow
                    key={w.id}
                    title={w.name}
                    meta={
                      <>
                        {templateLabel(w.template)} · {w.project ?? 'No project'}
                        {!ENDED.includes(w.state) && w.state !== 'unknown' && (
                          <>
                            {' '}
                            · ends <Timestamp value={w.expiresAt} />
                          </>
                        )}
                      </>
                    }
                    status={<Status value={w.state} tooltip={false} />}
                    selected={w.id === worker?.id}
                    onClick={() => navigate(href.fleet(w.id))}
                  />
                ))}
              </RecordList>
            </Card>
          }
          detail={
            worker ? (
              <WorkerDetail key={worker.id} worker={worker} fleet={fleet} scoped={scoped} aws={aws} />
            ) : (
              <Card>
                <EmptyState
                  compact
                  icon="arrowRight"
                  title="Select a worker"
                  body="Its lifecycle controls, evidence and history open here."
                />
              </Card>
            )
          }
        />
      )}
    </FleetFrame>
  );
}

/** The reference empty state: what this is, why it is empty, and the one next step. */
function FleetEmpty({ project, total, aws, setProject }) {
  if (project && total) {
    return (
      <EmptyState
        icon="folder"
        title={`No workers for ${project}`}
        body={`Workers launched with the project ${project} appear here. ${total} ${total === 1 ? 'worker belongs' : 'workers belong'} to other projects or to none.`}
        action={
          <Button variant="primary" icon="plus" onClick={() => navigate(href.launch())}>
            Launch a worker for {project}
          </Button>
        }
        secondaryAction={
          <Button variant="secondary" onClick={() => setProject(null)}>
            Show all projects
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon="apps"
      title="Your first voyage starts here."
      body={
        aws
          ? 'Launch an approved template and inspect its execution evidence.'
          : 'Create a simulated worker to explore its lifecycle and evidence. Nothing real is started.'
      }
      action={
        <Button variant="primary" icon="plus" onClick={() => navigate(href.launch())}>
          Launch a worker
        </Button>
      }
      secondaryAction={
        <Link
          href={href.docs('skidbladnir-screens', 'launch')}
          className="text-sm text-accent-fg underline underline-offset-4"
        >
          How launching works
        </Link>
      }
    />
  );
}

function WorkerDetail({ worker, fleet, scoped, aws }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const act = async (action, done) => {
    try {
      await fleet.post(`/api/workers/${worker.id}/${action}`);
      done?.();
    } catch (e) {
      toast({ tone: 'danger', title: `Could not ${action} ${worker.name}`, description: e.message });
    }
  };
  const controls = [
    worker.state === 'running' && ['stop', 'Stop', 'Shut the worker down. It keeps its slot and can be started again.'],
    worker.state === 'running' && ['reboot', 'Reboot', 'Restart the machine. The lifetime clock keeps counting.'],
    worker.state === 'stopped' && ['start', 'Start', 'Start the stopped worker again.'],
  ].filter(Boolean);
  const events = scoped.events.filter((e) => e.workerId === worker.id);
  const history = (
    <WorkerTimeline events={events.slice(0, 8)} more={events.length > 8 ? events.length : 0} workerId={worker.id} />
  );
  return (
    <Stack gap={6}>
      <Card
        title={worker.name}
        headingLevel={2}
        actions={<Status value={worker.state} />}
        footer={
          <Cluster gap={2}>
            {controls.map(([action, label, tip]) => (
              <Tooltip key={action} content={tip}>
                <Button disabled={fleet.busy} onClick={() => act(action)}>
                  {label}
                </Button>
              </Tooltip>
            ))}
            {!ENDED.includes(worker.state) && (
              <Tooltip content="Delete the worker. Its history and collected files stay.">
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  Terminate
                </Button>
              </Tooltip>
            )}
            {!controls.length && ENDED.includes(worker.state) && (
              <p className="text-sm text-muted">This worker has ended. Its history stays available.</p>
            )}
          </Cluster>
        }
      >
        <Stack gap={4}>
          {worker.attention && (
            <Callout tone="warning" title="Needs a check">
              {worker.attention}
            </Callout>
          )}
          <KeyValue
            columns={2}
            items={[
              { label: 'Worker ID', value: <Id value={worker.id} label="Worker ID" /> },
              { label: 'Project', value: worker.project ?? <span className="text-muted">None</span> },
              { label: 'Template', term: 'Environment template', value: templateLabel(worker.template) },
              { label: 'Lifetime', term: 'Maximum lifetime', value: `${worker.minutes} minutes` },
              { label: 'Created', value: <Timestamp value={worker.createdAt} /> },
              { label: 'Expires', value: <Timestamp value={worker.expiresAt} /> },
              {
                label: 'Provider',
                value: aws ? (
                  <>
                    AWS EC2 ·{' '}
                    {worker.instanceId ? <Id value={worker.instanceId} label="Instance ID" /> : 'Awaiting identity'}
                  </>
                ) : (
                  'Local simulation · no virtual machine'
                ),
              },
            ]}
          />
        </Stack>
      </Card>
      {aws ? (
        <Tabs
          label="Worker tools"
          items={[
            {
              value: 'commands',
              label: 'Remote execution',
              content: <RemoteExecution worker={worker} fleet={fleet} scoped={scoped} />,
            },
            {
              value: 'terminal',
              label: 'Terminal and files',
              content: <TerminalAndFiles worker={worker} fleet={fleet} scoped={scoped} />,
            },
            { value: 'history', label: 'History', count: events.length, content: <Card>{history}</Card> },
          ]}
        />
      ) : (
        <Card
          title="Recent history"
          description="Newest first."
          actions={
            <Link href={href.history(worker.id)} className="text-sm text-accent-fg underline underline-offset-4">
              Full history
            </Link>
          }
        >
          {history}
        </Card>
      )}
      <ConfirmDialog
        open={confirm && !ENDED.includes(worker.state)}
        onOpenChange={setConfirm}
        title={`Terminate ${worker.name}?`}
        description="This worker cannot be restarted after termination. Its history remains available."
        confirmLabel="Confirm termination"
        cancelLabel="Keep worker"
        busy={fleet.busy}
        onConfirm={() => act('terminate', () => setConfirm(false))}
      />
    </Stack>
  );
}
