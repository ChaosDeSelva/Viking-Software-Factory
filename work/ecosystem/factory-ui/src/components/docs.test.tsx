import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/render.js";
import { FACTORY_ADDRESSES } from "./architecture.js";
import {
  DocsView,
  GuideChat,
  Markdown,
  ResearchDoc,
  stripPrivateCitations,
  withoutSourcesSection,
  type GuideAnswer,
  type ResearchSource,
} from "./docs.js";

describe("Markdown", () => {
  it("renders headings with anchors, lists, tables, code and inline marks", () => {
    const { container } = render(
      <Markdown
        source={
          "# Runs\n\nA **run** is *one* execution with `code`.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nsindri run\n```"
        }
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Runs" }).id).toBe("runs");
    expect(container.querySelector("strong")?.textContent).toBe("run");
    expect(container.querySelector("em")?.textContent).toBe("one");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe("sindri run");
  });

  it("gives headings the GitHub-style anchors the docs index and search link to", () => {
    render(
      <Markdown
        source={
          "## Crews & agents\n\n## Delete a project's data\n\n## 5. Watch: **Execute › Runs**\n\n## See [Runs](/docs/runs)\n\n## Usage\n\n## Usage"
        }
      />,
    );
    const ids = screen.getAllByRole("heading", { level: 2 }).map((h) => h.id);
    expect(ids).toEqual([
      "crews--agents",
      "delete-a-projects-data",
      "5-watch-execute--runs",
      "see-runs",
      "usage",
      "usage-1",
    ]);
  });

  it("never renders HTML or unsafe links from the source", () => {
    const { container } = render(
      <Markdown
        source={
          "<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](/docs/runs) [ext](https://example.com)"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByRole("link", { name: "ok" }).getAttribute("href")).toBe("/docs/runs");
    expect(screen.getByRole("link", { name: "ext" }).getAttribute("rel")).toMatch("noopener");
  });
});

describe("DocsView", () => {
  it("marks the current page in the table of contents", () => {
    render(
      <DocsView
        activeSlug="runs"
        hrefFor={(s) => `/docs/${s}`}
        sections={[
          {
            title: "Sindri",
            pages: [
              { slug: "runs", title: "Runs" },
              { slug: "plans", title: "Plans" },
            ],
          },
        ]}
        markdown="# Runs"
      />,
    );
    const current = screen
      .getAllByRole("link", { name: "Runs" })
      .map((l) => l.getAttribute("aria-current"));
    expect(current).toContain("page");
    expect(screen.getAllByRole("link", { name: "Plans" })[0]!.getAttribute("href")).toBe(
      "/docs/plans",
    );
  });
});

describe("GuideChat", () => {
  it("asks with the context, shows the answer and its links", async () => {
    let resolve: (a: GuideAnswer) => void = () => undefined;
    const ask = vi.fn(() => new Promise<GuideAnswer>((r) => (resolve = r)));
    const context = { app: "heimdall", projectId: "p1" };
    const { user } = setup(
      <GuideChat ask={ask} context={context} suggestions={["Why is a run waiting?"]} />,
    );
    await user.click(screen.getByRole("button", { name: "Why is a run waiting?" }));
    expect(ask).toHaveBeenCalledWith("Why is a run waiting?", context);
    expect(screen.getByRole("status").textContent).toMatch("looking this up");
    resolve({ answer: "It **passed** checks.", links: [{ label: "Open run", href: "/runs/1" }] });
    expect(await screen.findByText("passed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/runs/1");
    expect(screen.queryByRole("list", { name: "Suggested questions" })).toBeNull();
  });

  it("sends on Enter, keeps Shift+Enter for new lines, and offers Retry on failure", async () => {
    const ask = vi
      .fn<(q: string, c: null) => Promise<GuideAnswer>>()
      .mockRejectedValueOnce(new Error("The guide is unavailable (503)."))
      .mockResolvedValueOnce({ answer: "Second try worked.", links: [] });
    const { user } = setup(<GuideChat ask={ask} context={null} />);
    const box = screen.getByRole("textbox", { name: "Your question" });
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect((box as HTMLTextAreaElement).value).toBe("line one\nline two");
    await user.keyboard("{Enter}");
    expect(ask).toHaveBeenCalledWith("line one\nline two", null);
    expect(await screen.findByText(/unavailable \(503\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Second try worked.")).toBeTruthy());
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not send empty questions", async () => {
    const ask = vi.fn();
    const { user } = setup(<GuideChat ask={ask} context={null} />);
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "   {Enter}");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("architecture diagram", () => {
  it("renders for a factory-architecture fence, with a link to every local web app", () => {
    render(<Markdown source={"Intro\n\n```factory-architecture\n```\n\nAfter"} />);
    const figure = screen.getByRole("img", { name: "How the factory's programs connect" });
    expect(figure).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const href of Object.values(FACTORY_ADDRESSES)) expect(hrefs).toContain(href);
    expect(screen.getByRole("link", { name: /Open Sindri/ }).getAttribute("target")).toBe("_blank");
    expect(screen.getByText("After")).toBeTruthy();
  });

  it("other fences stay code blocks", () => {
    const { container } = render(<Markdown source={"```text\nplain\n```"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("plain");
  });
});

describe("Markdown code fences", () => {
  it("supports ~~~ fences and only closes on a matching fence", () => {
    const { container } = render(
      <Markdown source={"~~~\na\n```\nb\n~~~\n\n````md\n```\ninner\n```\n````\n\nAfter"} />,
    );
    const blocks = [...container.querySelectorAll("pre code")].map((c) => c.textContent);
    expect(blocks).toEqual(["a\n```\nb", "```\ninner\n```"]);
    expect(screen.getByText("After").tagName).toBe("P");
  });
});

const sources: ResearchSource[] = [
  { id: "s1", kind: "url", ref: "https://example.com/rfc", title: "The RFC" },
  { id: "s2", kind: "file", ref: "src/server/auth.ts" },
  { id: "s3", kind: "lesson", ref: "lesson-42", title: "Retry flaky gates once" },
  { id: "s4", kind: "file", ref: "notes/internal.md", private: true },
  { id: "s5", kind: "url", ref: "javascript:alert(1)", title: "Bad link" },
  { id: "s6", kind: "url", ref: "//evil.example/x", title: "Protocol-relative" },
  { id: "s7", kind: "url", ref: "/docs/runs", title: "Relative" },
];

describe("withoutSourcesSection", () => {
  it("removes the last Sources/References/Bibliography section up to a same-or-higher heading", () => {
    expect(withoutSourcesSection("Body\n\n## Sources\n\n1. a\n2. b\n")).toBe("Body\n");
    expect(withoutSourcesSection("Body\n\n### References:\n- x\n#### Sub\n- y\n## Next\nz")).toBe(
      "Body\n\n## Next\nz",
    );
    expect(withoutSourcesSection("# Bibliography\nx")).toBe("");
    expect(withoutSourcesSection("## Sources\na\n\n## Sources\nb\n\n## Appendix\nc")).toBe(
      "## Sources\na\n\n## Appendix\nc",
    );
  });

  it("ignores headings inside code fences and other headings", () => {
    const md = "Body\n\n```\n## Sources\n```\n\n~~~\n## References\n~~~\n\n## Sourcery\nx";
    expect(withoutSourcesSection(md)).toBe(md);
  });
});

describe("stripPrivateCitations", () => {
  it("only drops the Sources section when nothing is private", () => {
    expect(stripPrivateCitations("Claim [1].\n\n## Sources\n\n1. One", [sources[0]!])).toBe(
      "Claim [1].",
    );
  });

  it("removes single private citations and the space before them", () => {
    expect(stripPrivateCitations("Retries help [3]. Auth lives here [2].", sources)).toBe(
      "Retries help. Auth lives here [2].",
    );
  });

  it("handles adjacent citations like [1][3] and [3][1]", () => {
    expect(stripPrivateCitations("A [1][3] and B [3][1] and C [3][4].", sources)).toBe(
      "A [1] and B [1] and C.",
    );
  });

  it("filters grouped citations like [1, 3] and [3,4]", () => {
    expect(stripPrivateCitations("A [1, 3]; B [3,4]; C [4, 2, 1].", sources)).toBe(
      "A [1]; B; C [2, 1].",
    );
  });

  it("leaves indexing, reference-style links and [n](url) links alone", () => {
    const md = "items[3] is null, see [docs][3], f(x)[3] and [3](https://example.com).";
    expect(stripPrivateCitations(md, sources)).toBe(md);
  });

  it("strips a private [n]: mid-paragraph but drops only line-start definitions", () => {
    expect(stripPrivateCitations("As shown in [3]: x.\n\n[4]: notes\n[2]: auth", sources)).toBe(
      "As shown in: x.\n\n[2]: auth",
    );
  });

  it("leaves code fences and inline code alone, using the same fence rules as Markdown", () => {
    const md = [
      "Use `arr [3]` here [3].",
      "```ts",
      "const x = [3]; // [1, 3]",
      "```",
      "~~~",
      "[3]",
      "```",
      "[3]",
      "~~~",
      "Out [3].",
    ].join("\n");
    expect(stripPrivateCitations(md, sources)).toBe(
      [
        "Use `arr [3]` here.",
        "```ts",
        "const x = [3]; // [1, 3]",
        "```",
        "~~~",
        "[3]",
        "```",
        "[3]",
        "~~~",
        "Out.",
      ].join("\n"),
    );
    const { container } = render(<Markdown source={md} />);
    expect([...container.querySelectorAll("pre code")].map((c) => c.textContent)).toEqual([
      "const x = [3]; // [1, 3]",
      "[3]\n```\n[3]",
    ]);
  });

  it("drops the document's own Sources section", () => {
    const md = "Body [1][3].\n\n## Sources\n\n1. The RFC\n3. Lesson\n[4]: notes\n";
    expect(stripPrivateCitations(md, sources)).toBe("Body [1].\n");
  });
});

describe("ResearchDoc", () => {
  it("renders the markdown, then numbered sources by kind", () => {
    const { container } = render(
      <ResearchDoc
        markdown={"# Findings\n\nAuth is weak [2][3]."}
        sources={sources}
        fileHref={(ref) => `/files/${ref}`}
      />,
    );
    expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
    expect(screen.getByText(/Auth is weak \[2\]\[3\]/)).toBeTruthy();
    const list = within(screen.getByRole("region", { name: "Sources" })).getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("value"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);

    const ext = within(items[0]!).getByRole("link", { name: /The RFC/ });
    expect(ext.getAttribute("href")).toBe("https://example.com/rfc");
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toMatch("noopener");

    const file = within(items[1]!).getByRole("link", { name: "src/server/auth.ts" });
    expect(file.getAttribute("href")).toBe("/files/src/server/auth.ts");
    expect(file.querySelector("code")).toBeTruthy();

    expect(within(items[2]!).getByText("Private lesson")).toBeTruthy();
    expect(within(items[2]!).getByText("Retry flaky gates once")).toBeTruthy();
    expect(within(items[3]!).getByText("Private")).toBeTruthy();

    for (const i of [4, 5, 6]) expect(within(items[i]!).queryByRole("link")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('a[href^="//"]')).toBeNull();
  });

  it("does not repeat the document's own Sources section", () => {
    render(
      <ResearchDoc markdown={"Body [1].\n\n## Sources\n\n1. Old list entry"} sources={sources} />,
    );
    expect(screen.queryByText("Old list entry")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Sources" })).toHaveLength(1);
  });

  it("shows file refs as code without a link when no fileHref is given", () => {
    render(<ResearchDoc markdown="x" sources={[sources[1]!]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("src/server/auth.ts").tagName).toBe("CODE");
  });

  it("hides private sources and their citations, keeping the original numbers", () => {
    render(<ResearchDoc markdown={"Auth is weak [2][3]."} sources={sources} hidePrivate />);
    expect(screen.getByText("Auth is weak [2].")).toBeTruthy();
    const items = within(screen.getByRole("region", { name: "Sources" })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("value"))).toEqual(["1", "2", "5", "6", "7"]);
    expect(screen.queryByText("Private lesson")).toBeNull();
    expect(screen.queryByText("notes/internal.md")).toBeNull();
  });

  it("omits the Sources section when there is nothing to list", () => {
    render(<ResearchDoc markdown="Only private." sources={[sources[2]!]} hidePrivate />);
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
  });
});

describe("citation numbers follow source ids", () => {
  const sources = [
    { id: "2", kind: "lesson" as const, ref: "lesson:abc" },
    { id: "1", kind: "url" as const, ref: "https://example.com/rfc", title: "The RFC" },
  ];

  it("strips by id, not list position", () => {
    expect(stripPrivateCitations("Claim [1][2].", sources)).toBe("Claim [1].");
  });

  it("numbers the list by id and orders it", () => {
    render(<ResearchDoc markdown="Claim [1][2]." sources={sources} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("value")).toBe("1");
    expect(items[0]?.textContent).toContain("The RFC");
    expect(items[1]?.getAttribute("value")).toBe("2");
  });
});
