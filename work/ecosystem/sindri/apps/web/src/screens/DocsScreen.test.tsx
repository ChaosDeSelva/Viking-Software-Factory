import { getPage, pages } from "@factory/docs";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderWithStore } from "../test/utils.js";
import { DEFAULT_DOC, DocsScreen, searchDocs } from "./DocsScreen.js";

const render = (docsSlug: string | null, docsSection: string | null = null) =>
  renderWithStore(<DocsScreen />, mockApi(), { view: "docs", docsSlug, docsSection });

describe("DocsScreen", () => {
  it("renders the page from @factory/docs named in the route, without repeating its title", () => {
    render("sindri-screens");
    const page = getPage("sindri-screens")!;
    expect(screen.getByRole("heading", { level: 1, name: page.title })).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: page.title })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Project settings" })).toBeTruthy();
  });

  it("falls back to the first page for no or an unknown slug", () => {
    const title = getPage(DEFAULT_DOC)!.title;
    const { unmount } = render(null);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    unmount();
    render("no-such-page");
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
  });

  it("links every page from the sidebar through the hash router, keeping the project", () => {
    render("sindri-screens");
    for (const p of pages) {
      const link = screen
        .getAllByRole("link", { name: p.title })
        .find((a) => a.getAttribute("href")?.startsWith(`#/docs/${p.slug}`));
      expect(link, p.slug).toBeTruthy();
      expect(link!.getAttribute("href")).toBe(`#/docs/${p.slug}?project=p1`);
    }
  });

  it("finds a heading and links to its section", async () => {
    render("sindri-screens");
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search the docs" }),
      "pairing code",
    );
    const results = screen.getByRole("list", { name: "Search results" });
    const hit = within(results).getByRole("link", { name: /Pairing code refused/ });
    expect(hit.getAttribute("href")).toBe(
      "#/docs/troubleshooting?project=p1&section=pairing-code-refused",
    );
  });

  it("says when nothing matches and offers the Glossary", async () => {
    render("sindri-screens");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search the docs" }), "zzqxv");
    expect(screen.getByText("Nothing matches “zzqxv”")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Glossary" }).getAttribute("href")).toBe(
      "#/docs/glossary?project=p1",
    );
  });
});

describe("searchDocs", () => {
  it("needs every word, lists headings before pages, and ignores an empty query", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("  ")).toEqual([]);
    const hits = searchDocs("Escalation");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.href).toMatch(/^\/docs\/[a-z0-9-]+#/);
    expect(searchDocs("escalation zzqxv")).toEqual([]);
    expect(searchDocs("escalation", 2)).toHaveLength(2);
  });
});
