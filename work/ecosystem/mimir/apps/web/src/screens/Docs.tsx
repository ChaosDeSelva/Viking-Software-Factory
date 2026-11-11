import { getPage, searchDocs, SECTIONS, slugify } from "@factory/docs";
import { DocsView, Input, Link } from "@factory/ui";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";
import { Screen } from "../components/Screen.js";
import { EmptyState } from "../components/StateViews.js";
import { DOCS_HOME } from "../lib/docs.js";

const HOME_SLUG = DOCS_HOME.replace("/docs/", "");

/**
 * Shared factory docs inside the Mimir shell: contents from @factory/docs, a search box, and deep
 * links (`/docs/<slug>#<anchor>`) that scroll to the heading.
 */
export function Docs() {
  const { slug = HOME_SLUG } = useParams();
  const { hash } = useLocation();
  const [query, setQuery] = useState("");
  const page = getPage(slug);
  const results = useMemo(() => searchDocs(query), [query]);

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
    // query: clicking a search hit for the current URL changes nothing else, yet must still scroll.
  }, [hash, slug, query]);

  return (
    <Screen
      screen="docs"
      title={query.trim() || !page ? "Docs" : page.title}
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
              {results.map((hit) => (
                <li key={hit.key} className="flex flex-col gap-1 px-4 py-3">
                  <Link
                    href={hit.href}
                    onClick={() => setQuery("")}
                    className="font-medium text-accent-fg"
                  >
                    {hit.title}
                  </Link>
                  <span className="text-sm text-muted">{hit.where}</span>
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
          // The page title is the screen's H1, so the body without its own "# Title" line.
          {...(page ? { markdown: page.body } : {})}
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
