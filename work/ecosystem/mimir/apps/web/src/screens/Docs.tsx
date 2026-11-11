import { getPage, pages, SECTIONS, slugify } from "@factory/docs";
import { DocsView, Input, Link } from "@factory/ui";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";
import { Screen } from "../components/Screen.js";
import { EmptyState } from "../components/StateViews.js";
import { DOCS_HOME } from "../lib/docs.js";

const HOME_SLUG = DOCS_HOME.replace("/docs/", "");

/** Pages whose title, summary or text contain every word of the query, title hits first. */
function search(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return pages
    .map((p) => {
      const title = p.title.toLowerCase();
      const text = `${title} ${p.summary.toLowerCase()} ${p.markdown.toLowerCase()}`;
      if (!words.every((w) => text.includes(w))) return null;
      return { page: p, score: words.filter((w) => title.includes(w)).length };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

/**
 * Shared factory docs inside the Mimir shell: contents from @factory/docs, a search box, and deep
 * links (`/docs/<slug>#<anchor>`) that scroll to the heading.
 */
export function Docs() {
  const { slug = HOME_SLUG } = useParams();
  const { hash } = useLocation();
  const [query, setQuery] = useState("");
  const page = getPage(slug);
  const results = useMemo(() => search(query), [query]);

  // The renderer and the docs index slug headings slightly differently; match either.
  useEffect(() => {
    const anchor = decodeURIComponent(hash.replace(/^#/, ""));
    if (!anchor) return;
    const target =
      document.getElementById(anchor) ??
      [
        ...document.querySelectorAll<HTMLElement>("article h1, article h2, article h3, article h4"),
      ].find((h) => slugify(h.textContent ?? "") === anchor);
    target?.scrollIntoView({ block: "start" });
  }, [hash, slug]);

  return (
    <Screen
      screen="docs"
      title="Docs"
      description="How the factory fits together, every screen, every status and the glossary. The same text in every factory app."
      global
    >
      <div className="max-w-xl">
        <label htmlFor="docs-search" className="sr-only">
          Search the docs
        </label>
        <Input
          id="docs-search"
          type="search"
          prefix="search"
          placeholder="Search the docs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {query.trim() ? (
        <section aria-labelledby="docs-results" className="flex flex-col gap-3">
          <h2 id="docs-results" className="text-lg font-semibold">
            {results.length} {results.length === 1 ? "result" : "results"}
          </h2>
          {results.length === 0 ? (
            <EmptyState body="Try fewer or different words, or browse the contents.">
              No page matches “{query.trim()}”
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              {results.map(({ page: p }) => (
                <li key={p.slug} className="flex flex-col gap-1 px-4 py-3">
                  <Link
                    href={`/docs/${p.slug}`}
                    onClick={() => setQuery("")}
                    className="font-medium text-accent-fg"
                  >
                    {p.title}
                  </Link>
                  <span className="text-sm text-muted">{p.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <DocsView
          sections={SECTIONS.map((s) => ({ title: s.title, pages: s.pages }))}
          activeSlug={slug}
          hrefFor={(s) => `/docs/${s}`}
          title="Docs"
          {...(page ? { markdown: page.markdown } : {})}
        >
          {page ? null : (
            <EmptyState action={<Link href={DOCS_HOME}>Open Finding your way</Link>}>
              No docs page called “{slug}”
            </EmptyState>
          )}
        </DocsView>
      )}
    </Screen>
  );
}
