import React, { useEffect, useMemo, useState } from 'react';
import { DocsView, EmptyState, Input, Link, Page, PageHeader, Stack } from '@factory/ui';
import { SECTIONS, getPage, pages } from '@factory/docs';
import { href } from '../routes.js';

const SECTIONS_VIEW = SECTIONS.map((s) => ({
  title: s.title,
  pages: s.pages.map((p) => ({ slug: p.slug, title: p.title })),
}));
const DEFAULT_SLUG = 'skidbladnir-screens';

/** Words in title, summary or body; every word must match. */
function search(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return pages.filter((p) => {
    const text = `${p.title} ${p.summary} ${p.markdown}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** `#/docs/<slug>#<anchor>`: the shared @factory/docs pages, a contents sidebar, search and deep links. */
export function DocsPage({ route }) {
  const slug = route.slug ?? DEFAULT_SLUG;
  const page = getPage(slug);
  const [query, setQuery] = useState('');
  const results = useMemo(() => search(query), [query]);

  // Deep links: scroll the heading into view once the article has rendered.
  useEffect(() => {
    if (!route.anchor) {
      window.scrollTo(0, 0);
      return;
    }
    const target = document.getElementById(route.anchor);
    target?.scrollIntoView({ block: 'start' });
  }, [slug, route.anchor]);

  return (
    <Page>
      <PageHeader
        title="Docs"
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
                {results.map((p) => (
                  <li key={p.slug}>
                    <Link
                      href={href.docs(p.slug)}
                      onClick={() => setQuery('')}
                      className="block rounded-md px-3 py-2 hover:bg-hover"
                    >
                      <span className="block text-sm font-medium">{p.title}</span>
                      <span className="block text-sm text-muted">{p.summary}</span>
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
        <DocsView sections={SECTIONS_VIEW} activeSlug={slug} hrefFor={(s) => href.docs(s)} markdown={page.markdown} />
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
