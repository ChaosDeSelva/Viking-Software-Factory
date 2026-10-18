/** Theme preference: follow `prefers-color-scheme` unless the operator picks one. Not a secret. */
export type ThemePref = "system" | "light" | "dark";
const KEY = "mimir.theme";

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "light";
}

export function saveThemePref(pref: ThemePref): void {
  localStorage.setItem(KEY, pref);
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  const mm =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  return mm?.matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

// Shared, subscribable preference so the header toggle and Settings stay in sync.
const listeners = new Set<() => void>();
let current: ThemePref | null = null;

export function getThemePref(): ThemePref {
  if (current === null) current = loadThemePref();
  return current;
}

export function setThemePref(pref: ThemePref): void {
  current = pref;
  saveThemePref(pref);
  applyTheme(pref);
  for (const l of listeners) l();
}

export function subscribeThemePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
