import { useState } from "react";
import {
  Button,
  Card,
  Field,
  Input,
  Textarea,
  Select,
  Option,
  StatusBadge,
  DialogSurface,
  DialogTitle,
  Disclosure,
  DisclosureTrigger,
  CodeBlock,
  EmptyState,
  Progress,
} from "./ui";
import { RecordRow, TaskCard, MetricCard } from "./factory";
export function ComponentCatalog() {
  const [dialog, setDialog] = useState(false),
    [value, setValue] = useState("codex");
  return (
    <main className="mx-auto max-w-6xl p-6 sm:p-12">
      <p className="eyebrow">HEIMDALL / DESIGN SYSTEM</p>
      <h1 className="mt-3 text-4xl">Components, not one-off screens.</h1>
      <p className="my-5 text-muted">
        Interactive catalog · illustrative data only · React, Tailwind and
        accessible primitives.
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2>Actions</h2>
          <div className="my-5 flex flex-wrap gap-3">
            <Button variant="primary" onClick={() => setDialog(true)}>
              Open dialog
            </Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
          </div>
          <h3>Status signals</h3>
          <div className="mt-4 flex flex-wrap gap-2">
            {["running", "completed", "blocked", "pending", "failed"].map(
              (s) => (
                <StatusBadge key={s} value={s} />
              ),
            )}
          </div>
        </Card>
        <Card>
          <h2>Form controls</h2>
          <Field>
            Agent harness
            <Select value={value} onValueChange={setValue}>
              <Option value="codex">Codex</Option>
              <Option value="claude">Claude Code</Option>
              <Option value="disabled" disabled>
                Unavailable harness
              </Option>
            </Select>
          </Field>
          <Field>
            Project name
            <Input placeholder="A useful small project" />
          </Field>
          <Field>
            Objective
            <Textarea placeholder="Describe the outcome" />
          </Field>
        </Card>
        <Card>
          <h2>Inspectable records</h2>
          <RecordRow
            title="Implement greeting API"
            description="Task record · example"
            status="running"
            onClick={() => setDialog(true)}
          />
          <TaskCard
            title="Independently verify the implementation"
            crew="Review crew"
            status="pending"
            detail="Waiting for implementation"
            onClick={() => setDialog(true)}
          />
        </Card>
        <Card>
          <h2>Evidence and empty states</h2>
          <Progress aria-label="Example task progress" value={60} />
          <Disclosure>
            <DisclosureTrigger>Inspect example evidence</DisclosureTrigger>
            <CodeBlock>
              {JSON.stringify({ example: true, verdict: "passed" }, null, 2)}
            </CodeBlock>
          </Disclosure>
          <EmptyState>No decisions waiting for review.</EmptyState>
        </Card>
        <MetricCard
          name="Example metric"
          value="12"
          description="Illustrative catalog data"
          onClick={() => setDialog(true)}
        />
      </div>
      {dialog && (
        <DialogSurface
          titleId="catalog-dialog"
          onClose={() => setDialog(false)}
        >
          <DialogTitle id="catalog-dialog" className="text-2xl">
            Reusable decision surface
          </DialogTitle>
          <p className="my-4 text-muted">
            Focus is contained. Escape dismisses and restores focus to the
            opener.
          </p>
          <Field>
            Decision note
            <Textarea />
          </Field>
          <Button variant="primary" onClick={() => setDialog(false)}>
            Close dialog
          </Button>
        </DialogSurface>
      )}
    </main>
  );
}
