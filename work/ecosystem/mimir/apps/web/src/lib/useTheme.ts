import { useEffect, useSyncExternalStore } from "react";
import {
  applyTheme,
  getThemePref,
  setThemePref,
  subscribeThemePref,
  type ThemePref,
} from "./theme.js";

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribeThemePref, getThemePref, getThemePref);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system" || typeof window.matchMedia !== "function") return;
    // Follow live OS changes while on "system".
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [pref]);
  return [pref, setThemePref];
}
