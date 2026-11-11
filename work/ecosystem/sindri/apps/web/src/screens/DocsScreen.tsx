import { Card } from "../components/ui.js";
import { docHref, getPage, headingAnchors, searchDocs, SECTIONS } from "@factory/docs";
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
