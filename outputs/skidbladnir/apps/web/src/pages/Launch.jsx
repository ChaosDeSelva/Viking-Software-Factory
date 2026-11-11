import React, { useState } from 'react';
import { Button, Card, Checkbox, Field, Grid, GridItem, Input, Progress, Select, Stack, useToast } from '@factory/ui';
import { isActive } from '../../../../packages/contracts/worker.mjs';
import { templateLabel } from '../components.jsx';
import { href, navigate } from '../routes.js';
import { FleetFrame } from './Fleet.jsx';

const LIFETIMES = [5, 15, 30, 60, 120, 240];

export function LaunchPage({ fleet, project, aws }) {
  const toast = useToast();
  const templates = fleet.data?.templates ?? ['node', 'python', 'general'];
  const [name, setName] = useState('');
  // Follows the top-bar project until the operator types their own (null = not typed).
  const [typedProject, setTypedProject] = useState(null);
  const workerProject = typedProject ?? project ?? '';
  const [chosenTemplate, setTemplate] = useState(templates[0]);
  // AWS offers only its approved templates; fall back when the choice is not one of them.
  const template = templates.includes(chosenTemplate) ? chosenTemplate : templates[0];
  const [minutes, setMinutes] = useState('30');
  const [approve, setApprove] = useState(false);

  const max = fleet.data?.maxWorkers ?? 5;
  const active = (fleet.data?.workers ?? []).filter(isActive).length;
  const blocked = !fleet.token
    ? 'Waiting for the local session.'
    : active >= max
      ? `The worker limit is reached (${active} of ${max} active). Terminate a worker first.`
      : aws && !approve
        ? 'Confirm that a billable AWS worker may be created.'
        : undefined;

  async function submit(event) {
    event.preventDefault();
    if (blocked) return;
    try {
      const worker = await fleet.post('/api/workers', {
        name,
        template,
        minutes: Number(minutes),
        ...(workerProject.trim() ? { project: workerProject.trim() } : {}),
      });
      toast({
        tone: 'success',
        title: `${worker.name} launched`,
        description: aws
          ? 'AWS launch accepted. Independent expiration applies.'
          : 'Simulated worker created. Nothing real was started.',
      });
      setName('');
      setApprove(false);
      navigate(href.fleet(worker.id));
    } catch (e) {
      toast({ tone: 'danger', title: 'The worker was not launched', description: e.message });
    }
  }

  return (
    <FleetFrame
      title="Launch"
      description="Start a disposable worker from an approved template."
      screen="launch"
      project={project}
      fleet={fleet}
      aws={aws}
    >
      <Grid>
        <GridItem span={8}>
          <Card title="Launch a worker" headingLevel={2}>
            <form className="flex flex-col gap-field" onSubmit={submit}>
              <Field label="Worker name" required hint="1–64 letters, numbers, spaces, underscores or dashes.">
                <Input
                  required
                  maxLength={64}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9 _\-]*"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. saga-api-tests"
                />
              </Field>
              <Field
                label="Project"
                info="Optional. Tags the worker with a factory project so it shows when that project is selected in the top bar. Leave blank for none."
                hint="The factory project this worker serves, e.g. demo-app."
              >
                <Input
                  maxLength={100}
                  pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                  value={workerProject}
                  onChange={(e) => setTypedProject(e.target.value)}
                  placeholder="No project"
                />
              </Field>
              <Field label="Environment template" term="Environment template">
                <Select
                  value={template}
                  onValueChange={setTemplate}
                  options={templates.map((t) => ({ value: t, label: templateLabel(t) }))}
                />
              </Field>
              <Field
                label="Maximum lifetime"
                term="Maximum lifetime"
                hint={
                  aws
                    ? 'AWS expiration runs independently of this application.'
                    : 'The local simulator enforces expiry while the API runs, and reconciles it when the API restarts.'
                }
              >
                <Select
                  value={minutes}
                  onValueChange={setMinutes}
                  options={LIFETIMES.map((m) => ({ value: String(m), label: `${m} minutes` }))}
                />
              </Field>
              {aws && (
                <Checkbox
                  checked={approve}
                  onChange={(e) => setApprove(e.target.checked)}
                  label="I approve creating a billable worker in this AWS account."
                  description="Real resources cost money until the worker is terminated."
                />
              )}
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  icon="plus"
                  loading={fleet.busy}
                  disabledReason={blocked}
                >
                  {aws ? 'Launch AWS worker' : 'Launch simulated worker'}
                </Button>
              </div>
            </form>
          </Card>
        </GridItem>
        <GridItem span={4}>
          <Stack gap={4}>
            <Card title="Capacity" term="Slot" description="The limit is shared by every project.">
              <Stack gap={2}>
                <p className="text-sm">
                  <span className="text-lg font-semibold">{active}</span> of {max} workers active
                </p>
                <Progress value={active} max={max} label={`${active} of ${max} workers active`} />
              </Stack>
            </Card>
            <Card title="What happens next">
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted">
                {aws ? (
                  <>
                    <li>Skidbladnir reserves the launch, then asks AWS for the machine.</li>
                    <li>The worker is terminated when its lifetime ends, even if this app is closed.</li>
                    <li>Run commands and collect files from the worker's page.</li>
                  </>
                ) : (
                  <>
                    <li>A simulated worker appears in the fleet, running.</li>
                    <li>No machine, runtime or cloud resource is created; the template is only a label.</li>
                    <li>It is terminated when its lifetime ends.</li>
                  </>
                )}
              </ul>
            </Card>
          </Stack>
        </GridItem>
      </Grid>
    </FleetFrame>
  );
}
