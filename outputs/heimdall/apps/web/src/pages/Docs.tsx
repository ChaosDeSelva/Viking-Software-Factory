// Docs: the shared @factory/docs pages inside Heimdall's shell, with a contents sidebar, a search
// over pages, headings and glossary terms, and `/docs/<page>#<heading>` deep links.
import {
  SECTIONS,
  docsIndex,
  getPage,
  glossary,
  termHref,
} from "@factory/docs";
import {
  DocsView,
  EmptyState,
  Input,
  Link,
  Page,
  PageHeader,
} from "@factory/ui";
import { useEffect, useState } from "react";

const DEFAULT = "heimdall-screens";

interface Hit {
  href: string;
  title: string;
  context: string;
}

/** Pages, headings and glossary terms whose text contains every word of the query. */
export function searchDocs(query: string, limit = 12): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (text: string) =>
    words.every((w) => text.toLowerCase().includes(w));
  const hits: Hit[] = [];
  for (const section of docsIndex.sections)
    for (const page of section.pages) {
      if (has(page.title + " " + page.summary))
        hits.push({
          href: page.href,
          title: page.title,
          context: section.title,
        });
      for (const h of page.headings)
        if (h.depth > 1 && has(h.text))
          hits.push({
            href: `${page.href}#${h.anchor}`,
            title: h.text,
            context: page.title,
          });
    }
  for (const entry of glossary)
    if (has(entry.term + " " + entry.short + " " + entry.aliases.join(" ")))
      hits.push({
        href: termHref(entry),
        title: entry.term,
        context: entry.short,
      });
  return hits.slice(0, limit);
}

export function DocsPage({ slug }: { slug: string }) {
  const [query, setQuery] = useState("");
  const page = getPage(slug || DEFAULT);
  const hits = searchDocs(query);
  // Deep links: scroll to `#heading` once the page is rendered.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id)
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView(),
      );
  }, [slug]);
  return (
    <Page>
      <PageHeader
        title={query.trim() || !page ? "Docs" : page.title}
        description="How the factory fits together, every Heimdall screen, the operator guide, statuses and the glossary."
        scope={{ global: true }}
        actions={
          <Input
            aria-label="Search the docs"
            prefix="search"
            placeholder="Search pages and terms"
            className="w-72 max-w-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />
      {query.trim() ? (
        hits.length ? (
          <ul
            aria-label="Search results"
            className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface"
          >
            {hits.map((h) => (
              <li key={h.href}>
                <Link
                  href={h.href}
                  onClick={() => setQuery("")}
                  className="flex flex-col gap-0.5 px-card py-3 hover:bg-hover"
                >
                  <span className="text-sm font-medium">{h.title}</span>
                  <span className="line-clamp-1 text-xs text-muted">
                    {h.context}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            title="Nothing matches"
            body="Try another word, or browse the contents."
          />
        )
      ) : page ? (
        <DocsView
          sections={SECTIONS}
          activeSlug={page.slug}
          hrefFor={(s) => `/docs/${s}`}
          // The page title is the H1 above; the document's own "# Title" line would repeat it.
          markdown={page.markdown.replace(/^#\s.*\n+/, "")}
        />
      ) : (
        <EmptyState
          title="This docs page does not exist"
          body="It may have moved. Start from the Heimdall screens guide."
          action={<Link href={`/docs/${DEFAULT}`}>Heimdall screens</Link>}
        />
      )}
    </Page>
  );
}
