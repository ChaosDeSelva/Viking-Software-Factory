import { lazy, type ComponentType } from "react";
import { ErrorState } from "../components/StateViews.js";

/**
 * React.lazy whose failed import (a chunk gone after a redeploy, a network blip) renders a reload
 * prompt in place instead of throwing: the app has no error boundary, so a throw would blank it.
 */
export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(() =>
    load()
      .then((component) => ({ default: component }))
      .catch(() => ({
        default: (() => (
          <ErrorState
            title="This part of Mimir did not load"
            message="The app may have been updated since this page opened. Reload to get the current version."
            onRetry={() => window.location.reload()}
          />
        )) as ComponentType<P>,
      })),
  );
}
