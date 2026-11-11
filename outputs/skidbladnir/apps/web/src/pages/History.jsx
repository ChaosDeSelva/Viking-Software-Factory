import React, { useMemo } from 'react';
import { Button, Card, Field, Select, Toolbar } from '@factory/ui';
import { href, navigate } from '../routes.js';
import { FleetFrame } from './Fleet.jsx';
import { WorkerTimeline } from './WorkerTools.jsx';

const ALL = '__all__';

/** Fleet events for the selected project, optionally narrowed to one worker (`?worker=` in the hash). */
export function HistoryPage({ fleet, scoped, project, aws, route }) {
  const workers = useMemo(() => scoped?.workers ?? [], [scoped]);
  const names = useMemo(() => new Map(workers.map((w) => [w.id, w.name])), [workers]);
  const worker = workers.find((w) => w.id === route.workerId);
  const events = (scoped?.events ?? []).filter((e) => !worker || e.workerId === worker.id);
  return (
    <FleetFrame
      title="Event history"
      description="Everything that happened to your workers, newest first. History stays after a worker is terminated."
      screen="history"
      project={project}
      fleet={fleet}
      aws={aws}
      notice={false}
    >
      <Card
        title={worker ? `History · ${worker.name}` : 'Fleet history'}
        count={events.length}
        headingLevel={2}
        actions={
          <Toolbar label="History filters">
            <Field label="Worker" className="w-56 max-sm:w-full">
              <Select
                value={worker?.id ?? ALL}
                onValueChange={(id) => navigate(href.history(id === ALL ? null : id))}
                options={[
                  { value: ALL, label: 'All workers' },
                  ...workers.map((w) => ({ value: w.id, label: w.name })),
                ]}
              />
            </Field>
          </Toolbar>
        }
      >
        <WorkerTimeline
          events={events}
          names={worker ? undefined : names}
          emptyAction={
            !worker && (
              <Button variant="primary" icon="plus" onClick={() => navigate(href.launch())}>
                Launch a worker
              </Button>
            )
          }
        />
      </Card>
    </FleetFrame>
  );
}
