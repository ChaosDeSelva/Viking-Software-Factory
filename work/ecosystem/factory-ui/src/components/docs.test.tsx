import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/render.js";
import { FACTORY_ADDRESSES } from "./architecture.js";
import { DocsView, GuideChat, Markdown, type GuideAnswer } from "./docs.js";

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
