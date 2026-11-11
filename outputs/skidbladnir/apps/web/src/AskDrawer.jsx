import React from 'react';
import { Callout, Drawer, Link, Stack } from '@factory/ui';
import { SINDRI_OVERVIEW } from './apps.js';

const QUESTIONS = [
  'What does a stopped worker cost?',
  'Why is a worker in Unknown?',
  'How do I give a worker to a project?',
];

/**
 * Skidbladnir holds no Sindri token, so it cannot call the Guide itself. The drawer says so and
 * hands the operator to Sindri's Overview, where the "Ask the factory" Guide runs. Project IDs are
 * per app, so the operator picks the project again there.
 */
export function AskDrawer({ open, onOpenChange, docsHref }) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Ask the Guide"
      description="Plain-words answers about the factory, from the docs and its current state."
    >
      <Stack gap={6}>
        <Callout tone="info" title="The Guide runs in Sindri">
          Skidbladnir has no Sindri token, so it cannot ask the Guide from here. Open Sindri's Overview and use “Ask the
          factory”; choose the project there, as Sindri keeps its own project list. The Guide is read-only: it explains
          and links, it never acts.
        </Callout>
        <Stack gap={2}>
          <p className="text-sm font-semibold">Questions to try there</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
            {QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </Stack>
        <Stack gap={3}>
          <a
            href={SINDRI_OVERVIEW}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-control-md items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Open the Guide in Sindri
          </a>
          <Link
            href={docsHref}
            onClick={() => onOpenChange(false)}
            className="text-center text-sm text-accent-fg underline underline-offset-4"
          >
            Read the docs for this screen instead
          </Link>
        </Stack>
      </Stack>
    </Drawer>
  );
}
