import type { Heading } from "./types.js";

export const DOCS_BASE = "/docs";

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Lines outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

/** Headings with their anchors; repeated anchors get `-1`, `-2` like GitHub. */
export function headingAnchors(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const out: Heading[] = [];
  for (const line of proseLines(markdown)) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    // Plain text for tables of contents: links keep their label, emphasis and code marks go.
    const text = (m[2] ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "");
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ depth: (m[1] ?? "").length, text, anchor: n === 0 ? base : `${base}-${n}` });
  }
  return out;
}

/** Every markdown link target outside code. */
export function linkTargets(markdown: string): string[] {
  const out: string[] = [];
  for (const line of proseLines(markdown)) {
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(/\]\(([^)\s]+)\)/g)) if (m[1]) out.push(m[1]);
  }
  return out;
}

/** `/docs/<slug>#<anchor>` split into parts; null for anything else. */
export function parseDocHref(href: string): { slug: string; anchor: string | null } | null {
  const m = /^\/docs\/([a-z0-9-]+)(?:#([^#\s]+))?$/.exec(href);
  if (!m || !m[1]) return null;
  return { slug: m[1], anchor: m[2] ?? null };
}

export const docHref = (slug: string, anchor?: string | null): string =>
  `${DOCS_BASE}/${slug}${anchor ? `#${anchor}` : ""}`;
