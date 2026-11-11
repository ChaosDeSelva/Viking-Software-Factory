import { lazy, type ComponentType } from "react";
import { ErrorState } from "../components/StateViews.js";

/** The reload prompt shown in place of a part of the app whose code did not load. */
export function LoadFailed() {
  return (
    <ErrorState
      title="This part of Mimir did not load"
      message="The app may have been updated since this page opened. Reload to get the current version."
      onRetry={() => window.location.reload()}
    />
  );
}

/**
 * React.lazy whose failed import (a chunk gone after a redeploy, a network blip) renders a reload
 * prompt in place instead of throwing: the app has no error boundary, so a throw would blank it.
 * `failed` replaces that prompt for a component that must keep its own frame (a dialog).
 */
export function lazyScreen<P extends object>(
  load: () => Promise<ComponentType<P>>,
  failed: ComponentType<P> = LoadFailed,
) {
  return lazy(() =>
    load()
      .then((component) => ({ default: component }))
      .catch(() => ({ default: failed })),
  );
}
