import { useSyncExternalStore } from "react";

/** WCAG 2.1.4: single-key shortcuts can be turned off. On by default (spec-mandated keys). */
const KEY = "mimir.shortcuts";
const listeners = new Set<() => void>();

export function getShortcutsEnabled(): boolean {
  return localStorage.getItem(KEY) !== "off";
}

export function setShortcutsEnabled(enabled: boolean): void {
  localStorage.setItem(KEY, enabled ? "on" : "off");
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
