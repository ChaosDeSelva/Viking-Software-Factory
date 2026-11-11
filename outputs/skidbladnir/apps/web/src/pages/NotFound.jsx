import React from 'react';
import { Button, EmptyState, Page } from '@factory/ui';
import { href, navigate } from '../routes.js';

export function NotFoundPage() {
  return (
    <Page>
      <h1 className="sr-only" tabIndex={-1}>
        Page not found
      </h1>
      <EmptyState
        icon="search"
        title="This page does not exist"
        body="The link may be from an older version of Skidbladnir."
        action={
          <Button variant="primary" onClick={() => navigate(href.fleet())}>
            Go to the worker fleet
          </Button>
        }
      />
    </Page>
  );
}
