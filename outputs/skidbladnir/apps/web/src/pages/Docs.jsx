import React, { useEffect, useMemo, useState } from 'react';
import { DocsView, EmptyState, Input, Link, Page, PageHeader, Stack } from '@factory/ui';
import { SECTIONS, getPage, searchDocs } from '@factory/docs';
import { href } from '../routes.js';

const SECTIONS_VIEW = SECTIONS.map((s) => ({
  title: s.title,
  pages: s.pages.map((p) => ({ slug: p.slug, title: p.title })),
}));
const DEFAULT_SLUG = 'skidbladnir-screens';

/** `#/docs/<slug>#<anchor>`: the shared @factory/docs pages, a contents sidebar, search and deep links. */
export function DocsPage({ route }) {
  const slug = route.slug ?? DEFAULT_SLUG;
  const page = getPage(slug);
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchDocs(query), [query]);

  // Deep links: scroll the heading into view once the article has rendered.
  useEffect(() => {
    if (query.trim()) return;
    if (!route.anchor) {
      window.scrollTo(0, 0);
      return;
    }
    const target = document.getElementById(route.anchor);
    target?.scrollIntoView({ block: 'start' });
    // query: following a search hit to the current URL changes nothing else, yet must still scroll.
  }, [slug, route.anchor, query]);

  return (
    <Page>
      <PageHeader
        title={query.trim() || !page ? 'Docs' : page.title}
        description={
          <>
            How the factory fits together, every screen, every status. Setting Skidbladnir up? Read the{' '}
            <Link href="/site/guide.html" className="text-accent-fg underline underline-offset-4">
              setup guide
            </Link>
            .
          </>
        }
        scope={{ global: true }}
      />
      <Stack gap={3}>
        <Input
          type="search"
          prefix="search"
          aria-label="Search the docs"
          placeholder="Search the docs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        {query.trim() && (
          <nav aria-label="Search results" aria-live="polite">
            {results.length ? (
              <ul className="flex flex-col gap-1">
                {results.map((hit) => (
                  <li key={hit.key}>
                    <Link
                      href={hit.href}
                      onClick={() => setQuery('')}
                      className="block rounded-md px-3 py-2 hover:bg-hover"
                    >
                      <span className="block text-sm font-medium">{hit.title}</span>
                      <span className="block text-sm text-muted">{hit.where}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 text-sm text-muted">No page mentions “{query.trim()}”.</p>
            )}
          </nav>
        )}
      </Stack>
      {page ? (
        <DocsView sections={SECTIONS_VIEW} activeSlug={slug} hrefFor={(s) => href.docs(s)} markdown={page.body} />
      ) : (
        <EmptyState
          icon="book"
          title="That page does not exist"
          body={`There is no docs page called “${slug}”. It may have been renamed.`}
          action={
            <Link href={href.docs(DEFAULT_SLUG)} className="text-sm text-accent-fg underline underline-offset-4">
              Open the Skidbladnir screens guide
            </Link>
          }
        />
      )}
    </Page>
  );
}
