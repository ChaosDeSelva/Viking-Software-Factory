import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { setup } from "../test/render.js";
import { Button } from "./controls.js";
import { GlossaryProvider } from "./overlay.js";
import { Card, CardGroup, KeyValue, Page, PageHeader, Section, SplitView } from "./layout.js";
import { Callout, EmptyState, LoadState } from "./status.js";

describe("page structure", () => {
  it("PageHeader, Section and Card expose headings and labelled regions", async () => {
    const { container } = render(
      <Page>
        <PageHeader
          title="Runs"
          description="Every run for this project."
          info="A run executes a plan."
          scope={{ project: null }}
          actions={<Button>Refresh</Button>}
          breadcrumbs={[{ label: "demo-app", href: "/p" }, { label: "Runs" }]}
        />
        <Section title="Needs you" description="Waiting on a person">
          <CardGroup>
            <Card title="Reviews" count={2} actions={<Button size="sm">View all</Button>}>
              <p>Body</p>
            </Card>
            <Card title="Details">
              <KeyValue items={[{ label: "Run", value: "Alpha" }]} />
            </Card>
          </CardGroup>
        </Section>
      </Page>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    expect(screen.getByText("All projects")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Reviews/ })).toBeTruthy();
    expect(screen.getByRole("term").textContent).toBe("Run");
    await expectNoSeriousA11yViolations(container);
  });

  it("Card and Section headings carry only the title; count and hint sit beside them", async () => {
    const { container } = render(
      <GlossaryProvider entries={[{ term: "Review", short: "A person verdict." }]}>
        <Section title="Needs you" term="Review">
          <Card title="Reviews" count={2} term="Review">
            <p>One</p>
            <p>Two</p>
          </Card>
        </Section>
      </GlossaryProvider>,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Needs you");
    const h3 = screen.getByRole("heading", { level: 3 });
    expect(h3.textContent).toBe("Reviews");
    expect(screen.getByRole("region", { name: "Reviews" })).toBeTruthy();
    expect(h3.parentElement!.textContent).toContain("2");
    expect(screen.getByText("One").parentElement!.className).toMatch(/\bspace-y-group\b/);
    await expectNoSeriousA11yViolations(container);
  });

  it("Card and Callout accept aria-label and pass other aria/role props through", () => {
    render(
      <>
        <Card title="Budget" aria-label="Budget for demo-app" data-testid="card">
          <p>body</p>
        </Card>
        <Callout tone="warning" title="Blocked" aria-label="Blocked task" role="status" />
        <Callout tone="info" aria-live="polite" aria-label="Sync note" />
      </>,
    );
    const region = screen.getByRole("region", { name: "Budget for demo-app" });
    expect(region.getAttribute("aria-labelledby")).toBeNull();
    expect(screen.getByTestId("card")).toBe(region);
    expect(screen.getByRole("status", { name: "Blocked task" }).textContent).toMatch("Blocked");
    expect(screen.getByRole("note", { name: "Sync note" }).getAttribute("aria-live")).toBe(
      "polite",
    );
  });

  it("PageHeader keeps Learn more and the InfoHint in one no-wrap run", () => {
    render(
      <PageHeader
        title="Runs"
        description="Every run for this project."
        info="A run executes a plan."
        learnMore={<a href="/docs/runs">Learn more</a>}
      />,
    );
    const link = screen.getByRole("link", { name: "Learn more" });
    const run = link.parentElement!;
    expect(run.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(within(run).getByRole("button")).toBeTruthy();
    expect(run.parentElement!.textContent).toMatch(/^Every run for this project\. Learn more/);
  });

  it("SplitView shows a Back button for the detail pane", () => {
    const onBack = vi.fn();
    render(<SplitView list={<p>list</p>} detail={<p>detail</p>} showDetail onBack={onBack} />);
    screen.getByRole("button", { name: "Back to list" }).click();
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("states", () => {
  it("EmptyState has a title, body and action; never italic", () => {
    const { container } = render(
      <EmptyState
        title="No runs yet"
        body="Approve a plan."
        action={<Button>Open plans</Button>}
      />,
    );
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open plans" })).toBeTruthy();
    expect(container.innerHTML).not.toMatch("italic");
  });

  it("LoadState goes loading → error → empty → content", async () => {
    const onRetry = vi.fn();
    const { rerender, user } = setup(
      <LoadState loading>
        <p>content</p>
      </LoadState>,
    );
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    rerender(
      <LoadState loading={false} error={new Error("Sindri is down")} onRetry={onRetry}>
        <p>content</p>
      </LoadState>,
    );
    expect(screen.getByRole("alert").textContent).toMatch("Sindri is down");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(
      <LoadState loading={false} empty emptyState={<p>none yet</p>}>
        <p>content</p>
      </LoadState>,
    );
    expect(screen.getByText("none yet")).toBeTruthy();
    rerender(
      <LoadState loading={false}>
        <p>content</p>
      </LoadState>,
    );
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("danger Callouts are alerts; others are notes", () => {
    render(
      <>
        <Callout tone="danger" title="Gate failed" />
        <Callout tone="info" title="Read-only" />
      </>,
    );
    expect(screen.getByRole("alert").textContent).toMatch("Gate failed");
    expect(screen.getByRole("note").textContent).toMatch("Read-only");
  });
});
