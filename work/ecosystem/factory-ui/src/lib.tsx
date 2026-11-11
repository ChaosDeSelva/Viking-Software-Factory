import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { twMerge } from "tailwind-merge";

export const cn = (...values: (string | undefined | null | false)[]) =>
  twMerge(values.filter(Boolean).join(" "));

/** Shared focus treatment for custom controls (brand-coloured ring). */
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
type LinkRenderer = (props: LinkProps) => ReactNode;
const LinkContext = createContext<LinkRenderer>((props) => <a {...props} />);

/** Lets a router (react-router, hash routing, …) render every link the library draws. */
export function LinkProvider({ render, children }: { render: LinkRenderer; children: ReactNode }) {
  return <LinkContext.Provider value={render}>{children}</LinkContext.Provider>;
}
export function Link(props: LinkProps) {
  return useContext(LinkContext)(props);
}

/** Appends `?project=` so app-switcher and cross-app links keep the selected project. */
export function withProject(href: string, projectId: string | null | undefined): string {
  if (!projectId) return href;
  const [path, hash] = href.split("#") as [string, string | undefined];
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}project=${encodeURIComponent(projectId)}${hash ? `#${hash}` : ""}`;
}

/**
 * Heading anchor as `@factory/docs` computes it (`headingAnchors`), before repeats get `-1`, `-2`:
 * GitHub style, so the docs table of contents, search hits and glossary links land on the heading.
 */
export function headingSlug(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const urlListeners = new Set<() => void>();
function subscribeUrl(listener: () => void) {
  urlListeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    urlListeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** A string state mirrored in a query parameter (replaceState, so Back is not flooded). */
export function useUrlState(param: string, fallback: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribeUrl,
    () => new URLSearchParams(window.location.search).get(param) ?? fallback,
    () => fallback,
  );
  const set = useCallback(
    (next: string) => {
      const url = new URL(window.location.href);
      if (next === fallback) url.searchParams.delete(param);
      else url.searchParams.set(param, next);
      window.history.replaceState(window.history.state, "", url);
      urlListeners.forEach((l) => l());
    },
    [param, fallback],
  );
  return [value, set];
}

export type ThemePreference = "light" | "dark" | "system";
const THEME_KEY = "factory-theme";
const themeListeners = new Set<() => void>();
function readTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
/** Inline this in <head> to apply the saved theme before first paint. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

/** Light / Dark / System preference, persisted per browser and applied to <html data-theme>. */
export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(
    (l) => {
      themeListeners.add(l);
      return () => themeListeners.delete(l);
    },
    readTheme,
    () => "system" as const,
  );
  useEffect(() => applyTheme(pref), [pref]);
  const set = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage blocked: still apply for this page */
    }
    applyTheme(next);
    themeListeners.forEach((l) => l());
  }, []);
  return [pref, set];
}

/** True below the 640px breakpoint; components switch to their compact layouts. */
export function useNarrow(): boolean {
  const query = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setNarrow(mql.matches);
    mql.addEventListener("change", update);
    update();
    return () => mql.removeEventListener("change", update);
  }, []);
  return narrow;
}

export const VisuallyHidden = ({ children, id }: { children: ReactNode; id?: string }) => (
  <span id={id} className="sr-only">
    {children}
  </span>
);
