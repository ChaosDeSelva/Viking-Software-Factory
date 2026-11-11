import { useSyncExternalStore } from "react";

/** WCAG 2.1.4: single-key shortcuts can be turned off. On by default (spec-mandated keys). */
const KEY = "mimir.shortcuts";
const listeners = new Set<() => void>();
/** The choice for this page when the browser blocks storage (access throws). */
let unstored: boolean | null = null;

export function getShortcutsEnabled(): boolean {
  if (unstored !== null) return unstored;
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "on" : "off");
    unstored = null;
  } catch {
    unstored = enabled;
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShortcutsEnabled(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getShortcutsEnabled, getShortcutsEnabled);
  return [enabled, setShortcutsEnabled];
}
