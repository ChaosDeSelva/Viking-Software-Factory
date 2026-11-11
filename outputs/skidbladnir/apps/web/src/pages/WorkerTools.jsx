import React, { useState } from 'react';
import {
  Button,
  Card,
  CodeBlock,
  Cluster,
  DataTable,
  EmptyState,
  Field,
  Id,
  Input,
  Link,
  Stack,
  Textarea,
  Timeline,
  Timestamp,
  Tooltip,
  useToast,
} from '@factory/ui';
import { Status } from '../components.jsx';
import { href } from '../routes.js';

// SSM end states: no further refresh is useful and nothing is left to cancel.
const COMMAND_DONE = ['Success', 'Failed', 'Cancelled', 'TimedOut'];

/** Event list for one worker or the fleet; `names` labels events with their worker. */
export function WorkerTimeline({ events, names = undefined, more = 0, workerId = undefined, emptyAction = undefined }) {
  if (!events.length)
    return (
      <EmptyState
        compact
        icon="clock"
        title="No events yet"
        body="Launches, stops, expirations and commands appear here as they happen."
        action={emptyAction}
      />
    );
  return (
    <Stack gap={4}>
      <Timeline
        items={events.map((e) => ({
          id: String(e.sequence),
          time: e.at,
          title: e.message,
          icon: 'clock',
          meta: names ? (
            <Link href={href.fleet(e.workerId)} className="text-accent-fg underline underline-offset-4">
              {names.get(e.workerId) ?? 'Removed worker'}
            </Link>
          ) : undefined,
        }))}
      />
      {more > 0 && (
        <Link href={href.history(workerId)} className="text-sm text-accent-fg underline underline-offset-4">
          Show all {more} events
        </Link>
      )}
    </Stack>
  );
}

function useAction(fleet) {
  const toast = useToast();
  return async (path, body, title) => {
    try {
      return await fleet.post(path, body);
    } catch (e) {
      toast({ tone: 'danger', title, description: e.message });
      return null;
    }
  };
}

export function RemoteExecution({ worker, fleet, scoped }) {
  const [command, setCommand] = useState('');
  const run = useAction(fleet);
  const commands = scoped.commands.filter((c) => c.workerId === worker.id);
  const notRunning = worker.state !== 'running' ? 'Start the worker to run commands on it.' : undefined;
  return (
    <Stack gap={6}>
      <Card
        title="Run a command"
        description="Runs through SSM with the instance agent's privileges. Review the command before sending."
        term="SSM"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(`/api/workers/${worker.id}/commands`, { command }, 'The command was not sent'))
              setCommand('');
          }}
        >
          <Field
            label="Shell command"
            hint="Up to 7,000 characters. It is not resent automatically if the outcome is unknown."
          >
            <Textarea
              required
              maxLength={7000}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="printf 'hello'"
              className="font-mono"
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={fleet.busy} disabledReason={notRunning}>
              Run command
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Commands" count={commands.length} description="Newest first.">
        {commands.length ? (
          <Stack gap={6}>
            {commands.map((c) => (
              <Stack gap={3} key={c.id} className="border-t border-line pt-4 first:border-0 first:pt-0">
                <Cluster gap={3} justify="between">
                  <Cluster gap={3}>
                    <Status value={c.status} domain="ssm-command" />
                    {c.commandId ? (
                      <Id value={c.commandId} label="Command ID" />
                    ) : (
                      <span className="text-sm text-muted">
                        Submission outcome unknown. Inspect AWS before retrying.
                      </span>
                    )}
                  </Cluster>
                  {c.createdAt && <Timestamp value={c.createdAt} className="text-sm text-muted" />}
                </Cluster>
                {c.stdout && <CodeBlock title="Output" code={c.stdout} wrap maxHeight="360px" />}
                {c.stderr && <CodeBlock title="Errors" code={c.stderr} wrap maxHeight="360px" />}
                <Cluster gap={2}>
                  <Tooltip content="Ask SSM for the latest status and output.">
                    <Button
                      size="sm"
                      disabled={fleet.busy}
                      disabledReason={c.commandId ? undefined : 'No confirmed remote command identity.'}
                      onClick={() => run(`/api/commands/${c.id}/refresh`, {}, 'Could not refresh the result')}
                    >
                      Refresh result
                    </Button>
                  </Tooltip>
                  {!COMMAND_DONE.includes(c.status) && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={fleet.busy}
                      disabledReason={c.commandId ? undefined : 'No confirmed remote command identity.'}
                      onClick={() => run(`/api/commands/${c.id}/cancel`, {}, 'Could not cancel the command')}
                    >
                      Cancel command
                    </Button>
                  )}
                </Cluster>
              </Stack>
            ))}
          </Stack>
        ) : (
          <EmptyState
            compact
            icon="send"
            title="No commands yet"
            body="Commands you run on this worker, with their output, appear here."
          />
        )}
      </Card>
    </Stack>
  );
}

export function TerminalAndFiles({ worker, fleet, scoped }) {
  const [path, setPath] = useState('');
  const run = useAction(fleet);
  const terminals = scoped.terminals.filter((t) => t.workerId === worker.id);
  const artifacts = scoped.artifacts.filter((a) => a.workerId === worker.id);
  return (
    <Stack gap={6}>
      <Card
        title="Terminal"
        description="Open an interactive shell from the Skidbladnir project directory. The AWS Session Manager plugin is required."
      >
        <Stack gap={4}>
          <CodeBlock title="Terminal command" code={`node scripts/terminal.mjs ${worker.id}`} />
          <p className="text-sm text-muted">
            Append the recorded terminal identity to reconnect with a fresh shell. Shell variables and foreground
            processes do not persist; factory jobs run separately.
          </p>
          {terminals.map((t) => (
            <Cluster key={t.id} gap={3} justify="between" className="border-t border-line pt-3">
              <Cluster gap={3}>
                <Status value={t.status} domain="ssm-terminal" />
                <Id value={t.id} label="Terminal ID" />
              </Cluster>
              {t.status !== 'closed' && (
                <Button
                  size="sm"
                  disabled={fleet.busy}
                  onClick={() =>
                    run(`/api/workers/${worker.id}/terminals/${t.id}/close`, {}, 'Could not end the terminal')
                  }
                >
                  End terminal
                </Button>
              )}
            </Cluster>
          ))}
        </Stack>
      </Card>
      <Card
        title="Collect a file"
        description="Copy a file of up to 12 KiB from /tmp/skidbladnir-workspace. Hash-verified copies stay available after the worker expires."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(`/api/workers/${worker.id}/artifacts`, { path }, 'The file was not collected')) setPath('');
          }}
        >
          <Field label="Artifact path" hint="Relative to the workspace, for example reports/result.json.">
            <Input required value={path} onChange={(e) => setPath(e.target.value)} placeholder="reports/result.json" />
          </Field>
          <div>
            <Button
              type="submit"
              disabled={fleet.busy}
              disabledReason={worker.state !== 'running' ? 'Start the worker to collect files.' : undefined}
            >
              Collect artifact
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Collected files" count={artifacts.length} flush>
        <DataTable
          caption="Collected files"
          rows={artifacts}
          rowKey={(a) => a.id}
          empty={
            <EmptyState
              compact
              icon="folder"
              title="No files collected"
              body="Collected files are kept here with their SHA-256 hash."
            />
          }
          columns={[
            {
              key: 'path',
              header: 'File',
              primary: true,
              cell: (a) => (
                <a href={`/api/artifacts/${a.id}`} download className="text-accent-fg underline underline-offset-4">
                  {a.path}
                </a>
              ),
            },
            { key: 'bytes', header: 'Size', align: 'right', cell: (a) => `${a.bytes} bytes` },
            { key: 'sha', header: 'SHA-256', cell: (a) => <Id value={a.sha256} label="SHA-256" /> },
            { key: 'at', header: 'Collected', cell: (a) => (a.createdAt ? <Timestamp value={a.createdAt} /> : '—') },
          ]}
        />
      </Card>
    </Stack>
  );
}
