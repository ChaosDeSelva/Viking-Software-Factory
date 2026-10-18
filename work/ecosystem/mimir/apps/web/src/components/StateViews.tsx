import type { ReactNode } from "react";

export function LoadingState({ label }: { label: string }) {
  return (
    <p role="status" className="py-4 text-zinc-700 dark:text-zinc-300">
      Loading {label}…
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="my-2 rounded border border-red-700 bg-red-50 p-3 text-red-900 dark:bg-red-950 dark:text-red-100"
    >
      <p>Error: {message}</p>
      {onRetry && (
        <button type="button" className="btn mt-2" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-4 text-zinc-700 italic dark:text-zinc-300">{children}</p>;
}
