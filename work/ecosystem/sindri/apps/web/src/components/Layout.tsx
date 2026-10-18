import { useEffect, type ReactNode } from "react";
import { useStore } from "../store/context.js";
import type { View } from "../store/reducer.js";
import { Button, inputClass } from "./ui.js";

export const VIEWS: { view: View; label: string }[] = [
  { view: "projects", label: "Projects" },
  { view: "inbox", label: "Inbox" },
  { view: "director", label: "Director" },
  { view: "specs", label: "Specs" },
  { view: "knowledge", label: "Knowledge" },
  { view: "settings", label: "Settings" },
  { view: "plans", label: "Plans" },
  { view: "runs", label: "Runs" },
  { view: "reviews", label: "Reviews" },
  { view: "deliveries", label: "Deliveries" },
  { view: "harnesses", label: "Harnesses" },
];

/** Alt+1..9 then Alt+0 switch screens, in nav order (the eleventh has no shortcut). */
const SHORTCUT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

export function NoticeRegion() {
  const { state, dispatch } = useStore();
  const n = state.notice;
  const box = (kind: "info" | "error", text: string) => (
    <div
      className={`flex items-start justify-between gap-4 rounded border p-3 text-sm ${
        kind === "error"
          ? "border-red-500 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-50"
          : "border-emerald-500 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50"
      }`}
    >
      <p>
        <span className="font-semibold">{kind === "error" ? "Error: " : "Done: "}</span>
        {text}
      </p>
      <Button variant="secondary" onClick={() => dispatch({ type: "notice/dismiss" })}>
        Dismiss
      </Button>
    </div>
  );
  // Errors are assertive and stay until dismissed (audit S-I5); confirmations are polite.
  return (
    <>
      <div aria-live="polite" role="status" className="min-h-0">
        {n && n.kind !== "error" ? box(n.kind, n.text) : null}
      </div>
      <div role="alert" className="min-h-0">
        {n && n.kind === "error" ? box("error", n.text) : null}
      </div>
    </>
  );
}

export function Layout(props: { children: ReactNode }) {
  const { state, dispatch } = useStore();

  // Keyboard-first: Alt+1..9, Alt+0 switch screens. `code` keeps it working where Alt
  // changes the produced character (macOS).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      // Never steal keys while the user types (audit S-I4).
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const digit = /^Digit(\d)$/.exec(e.code)?.[1] ?? e.key;
      const v = VIEWS[SHORTCUT_KEYS.indexOf(digit)];
      if (v) {
        e.preventDefault();
        dispatch({ type: "navigate", view: v.view });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const current = VIEWS.find((v) => v.view === state.view)?.label ?? "";
  useEffect(() => {
    document.title = current ? `${current} · Sindri` : "Sindri";
  }, [current]);
  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:p-2 focus:text-black"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-300 dark:border-slate-700">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <h1 className="project-brand text-2xl font-semibold"><span className="project-initial" aria-hidden="true">S</span>Sindri</h1>
          <nav aria-label="Main" aria-describedby="nav-shortcuts" className="flex-1">
            <ul className="flex flex-wrap gap-1">
              {VIEWS.map((v, i) => (
                <li key={v.view}>
                  <button
                    type="button"
                    aria-current={state.view === v.view ? "page" : undefined}
                    aria-keyshortcuts={
                      SHORTCUT_KEYS[i] === undefined ? undefined : `Alt+${SHORTCUT_KEYS[i]}`
                    }
                    onClick={() => dispatch({ type: "navigate", view: v.view })}
                    className={`rounded px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 ${
                      state.view === v.view
                        ? "bg-indigo-700 text-white dark:bg-indigo-400 dark:text-black"
                        : "hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    {v.label}
                  </button>
                </li>
              ))}
            </ul>
            <p id="nav-shortcuts" className="mt-1 text-xs text-slate-600 dark:text-slate-300">
              Alt+1 to Alt+0 switch screens (outside text fields).
            </p>
          </nav>
          <div className="flex items-center gap-2">
            <label htmlFor="project-select" className="text-sm">
              Project
            </label>
            <select
              id="project-select"
              className={`${inputClass} w-48`}
              value={state.projectId ?? ""}
              onChange={(e) => dispatch({ type: "project/select", projectId: e.target.value })}
              disabled={state.projects.length === 0}
            >
              {state.projects.length === 0 ? <option value="">No projects</option> : null}
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              aria-label={`Switch to ${state.theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => dispatch({ type: "theme/toggle" })}
            >
              {state.theme === "dark" ? "Light" : "Dark"}
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: "token/clear" })}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-6xl space-y-4 px-4 py-6 focus:outline-none"
      >
        <h2 className="sr-only">{current}</h2>
        <NoticeRegion />
        {props.children}
      </main>
    </div>
  );
}
