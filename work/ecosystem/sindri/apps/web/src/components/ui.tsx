import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Loadable } from "../store/context.js";

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const styles = {
    primary:
      "bg-indigo-700 text-white hover:bg-indigo-800 dark:bg-indigo-500 dark:text-black dark:hover:bg-indigo-400",
    secondary:
      "border border-slate-400 text-slate-900 hover:bg-slate-100 dark:border-slate-500 dark:text-slate-100 dark:hover:bg-slate-800",
    danger: "bg-red-700 text-white hover:bg-red-800 dark:bg-red-400 dark:text-black",
  }[variant];
  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
      {...rest}
    />
  );
}

export const inputClass =
  "block w-full rounded border border-slate-400 bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline focus:outline-2 focus:outline-indigo-600 dark:focus:outline-indigo-300 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100";

export function Field(props: { label: string; id: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={props.id} className="block text-sm font-medium">
        {props.label}
      </label>
      {props.children}
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-slate-600 dark:text-slate-300">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

export function Card(props: { title?: string; children: ReactNode; headingLevel?: 2 | 3 }) {
  const H = props.headingLevel === 3 ? "h3" : "h2";
  return (
    <section className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
      {props.title ? <H className="text-lg font-semibold">{props.title}</H> : null}
      {props.children}
    </section>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="text-sm italic text-slate-600 dark:text-slate-300">{props.children}</p>;
}

export function Badge(props: { children: ReactNode; tone?: "neutral" | "warn" | "ok" }) {
  const tone = {
    neutral: "bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100",
    warn: "bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50",
    ok: "bg-emerald-200 text-emerald-950 dark:bg-emerald-800 dark:text-emerald-50",
  }[props.tone ?? "neutral"];
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {props.children}
    </span>
  );
}

/** Loading / error / ready switch with consistent copy. */
export function LoadState<T>(props: {
  state: Loadable<T>;
  what: string;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) {
  if (props.state.status === "loading")
    return (
      <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
        Loading {props.what}…
      </p>
    );
  if (props.state.status === "error")
    return (
      <div
        role="alert"
        className="space-y-2 rounded border border-red-400 p-3 text-sm dark:border-red-500"
      >
        <p>
          Could not load {props.what}: {props.state.error}
        </p>
        {props.onRetry ? (
          <Button variant="secondary" onClick={props.onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  return <>{props.children(props.state.data)}</>;
}

/**
 * A detail-view heading that takes focus when it first appears, so keyboard and screen-reader
 * users land on what they opened (review I4).
 */
export function DetailHeading(props: { id?: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2
      ref={ref}
      id={props.id}
      tabIndex={-1}
      className={`focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 ${props.className ?? "text-xl font-semibold"}`}
    >
      {props.children}
    </h2>
  );
}
