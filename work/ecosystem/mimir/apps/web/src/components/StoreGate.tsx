import type { ReactNode } from "react";
import { useStore } from "../store/StoreProvider.js";
import { ErrorState, LoadingState } from "./StateViews.js";

/** Renders children once the snapshot is loaded; loading and error states otherwise. */
export function StoreGate({ label, children }: { label: string; children: ReactNode }) {
  const { state, reconnect } = useStore();
  if (state.status === "loading") return <LoadingState label={label} />;
  if (state.status === "error") {
    return <ErrorState message={state.error ?? "Could not load data"} onRetry={reconnect} />;
  }
  return <>{children}</>;
}
