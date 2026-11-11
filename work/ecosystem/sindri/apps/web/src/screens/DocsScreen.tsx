import { Card } from "../components/ui.js";
import { docHref, getPage, headingAnchors, pages, SECTIONS } from "@factory/docs";
import {
  DocsView,
  EmptyState,
  glossarySlug,
  Input,
  Page,
  PageHeader,
  RecordList,
  RecordRow,
} from "@factory/ui";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/context.js";
import { appHref } from "../store/route.js";

export const DEFAULT_DOC = "how-the-factory-works";

interface Hit {
  key: string;
  title: string;
  where: string;
  href: string;
}

/** Page and heading matches for every query word (case-insensitive), headings first. */
export function searchDocs(query: string, limit = 20): Hit[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length === 0) return [];
  const all = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const headings: Hit[] = [];
  const bodies: Hit[] = [];
  for (const p of pages) {
    for (const h of headingAnchors(p.markdown))
      if (h.depth > 1 && all(h.text))
        headings.push({
          key: `${p.slug}#${h.anchor}`,
          title: h.text,
          where: p.title,
          href: docHref(p.slug, h.anchor),
        });
    if (all(`${p.title} ${p.summary} ${p.markdown}`))
      bodies.push({ key: p.slug, title: p.title, where: p.summary, href: docHref(p.slug) });
  }
  return [...headings, ...bodies].slice(0, limit);
}

/** Element for a docs anchor: the Markdown renderer's heading ids differ slightly from docs anchors. */
function anchorElement(markdown: string, anchor: string): HTMLElement | null {
  const byId = document.getElementById(anchor);
  if (byId) return byId;
  const h = headingAnchors(markdown).find((x) => x.anchor === anchor);
  return h ? document.getElementById(glossarySlug(h.text)) : null;
}

/**
 * The shared factory docs (`@factory/docs`) inside the shell: contents on the left, the page on
 * the right, search across pages and headings. `#/docs/<slug>?section=<anchor>` deep-links.
 */
export function DocsScreen() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const page = getPage(state.docsSlug ?? DEFAULT_DOC) ?? getPage(DEFAULT_DOC)!;
  const section = SECTIONS.find((s) => s.pages.some((p) => p.slug === page.slug));
  // The page title is the H1 of the PageHeader; the Markdown's own `# Title` would repeat it.
  const body = useMemo(() => page.markdown.replace(/^# .*\n+/, ""), [page.markdown]);
  const hits = useMemo(() => searchDocs(query), [query]);

  // Following a result (or any docs link) ends the search and shows the page.
  useEffect(() => setQuery(""), [state.docsSlug, state.docsSection]);
  useEffect(() => {
    const el = state.docsSection ? anchorElement(page.markdown, state.docsSection) : null;
    if (el) el.scrollIntoView?.({ block: "start" });
    else window.scrollTo?.({ top: 0 });
  }, [page.slug, page.markdown, state.docsSection]);

  return (
    <Page>
      <PageHeader
        title={page.title}
        description={page.summary}
        scope={{ global: true }}
        breadcrumbs={[{ label: "Docs", href: "/docs" }, { label: section?.title ?? "Docs" }]}
        actions={
          <div className="w-full sm:w-72">
            <Input
              type="search"
              prefix="search"
              aria-label="Search the docs"
              placeholder="Search the docs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      />
      {query.trim() ? (
        <Card title="Search results" count={hits.length} flush>
          {hits.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title={`Nothing matches “${query.trim()}”`}
              body="Try a shorter word, or open the Glossary."
              action={
                <a
                  className="text-sm font-medium text-accent-fg underline"
                  href={appHref("/docs/glossary", state.projectId)!}
                >
                  Open the Glossary
                </a>
              }
            />
          ) : (
            <RecordList label="Search results">
              {hits.map((h) => (
                <RecordRow key={h.key} title={h.title} meta={h.where} href={h.href} />
              ))}
            </RecordList>
          )}
        </Card>
      ) : (
        <DocsView
          sections={SECTIONS}
          activeSlug={page.slug}
          hrefFor={(slug) => docHref(slug)}
          markdown={body}
        />
      )}
    </Page>
  );
}
