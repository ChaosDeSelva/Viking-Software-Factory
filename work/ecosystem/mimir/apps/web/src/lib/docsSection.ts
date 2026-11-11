// Reads page text, so only lazily loaded code may import it (see HelpDialog in Layout).
import { getPage, parseDocHref, screenHref, slugify } from "@factory/docs";
import type { ScreenId } from "../components/Screen.js";

/** The markdown under a screen's heading in its docs page (up to the next heading of that level). */
export function screenSection(
  screen: ScreenId,
): { title: string; markdown: string; href: string } | null {
  const href = screenHref("mimir", screen);
  const ref = href ? parseDocHref(href) : null;
  const page = ref ? getPage(ref.slug) : undefined;
  if (!href || !ref || !page || !ref.anchor) return null;
  const lines = page.markdown.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (start < 0 && slugify(m[2]!) === ref.anchor) {
      start = i;
      level = m[1]!.length;
    } else if (start >= 0 && m[1]!.length <= level) {
      return {
        title: m2title(lines[start]!),
        markdown: lines
          .slice(start + 1, i)
          .join("\n")
          .trim(),
        href,
      };
    }
  }
  return start < 0
    ? null
    : {
        title: m2title(lines[start]!),
        markdown: lines
          .slice(start + 1)
          .join("\n")
          .trim(),
        href,
      };
}

const m2title = (line: string) => line.replace(/^#+\s+/, "");
