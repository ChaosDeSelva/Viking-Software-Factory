import { useEffect } from "react";

export const SHORTCUTS: readonly { keys: string; description: string; path?: string }[] = [
  { keys: "g o", description: "Go to Overview", path: "/" },
  { keys: "g m", description: "Go to Missions", path: "/missions" },
  { keys: "g r", description: "Go to Reviews", path: "/reviews" },
  { keys: "?", description: "Show this help" },
  { keys: "Esc", description: "Close dialogs" },
];

const GO_TARGETS: Record<string, string> = { o: "/", m: "/missions", r: "/reviews" };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Two-key "g x" navigation plus "?" for help. Ignored while typing or with modifiers. */
export function useShortcuts(
  navigate: (path: string) => void,
  openHelp: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        openHelp();
        pendingG = 0;
        return;
      }
      const now = Date.now();
      if (pendingG > 0 && now - pendingG < 1500) {
        const target = GO_TARGETS[e.key];
        pendingG = 0;
        if (target) {
          e.preventDefault();
          navigate(target);
        }
        return;
      }
      pendingG = e.key === "g" ? now : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openHelp, enabled]);
}
