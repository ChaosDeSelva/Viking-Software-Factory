import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { ProvenanceBadge, StatusBadge, UsageChips, ProgressText } from "./Badges.js";
import { EmptyState, ErrorState, LoadingState } from "./StateViews.js";
import { TokenPrompt } from "./TokenPrompt.js";

describe("badges", () => {
  it("labels provenance in text, not color alone", () => {
    render(
      <>
        <ProvenanceBadge provenance="observed" />
        <ProvenanceBadge provenance="summarized" />
      </>,
    );
    expect(screen.getByText("observed")).toBeTruthy();
    expect(screen.getByText("summarized")).toBeTruthy();
    expect(screen.getByText("summarized").getAttribute("title")).toMatch(/AI summary/i);
  });

  it("renders status text", () => {
    render(<StatusBadge status="blocked" />);
    expect(screen.getByText("blocked")).toBeTruthy();
  });

  it("shows measured/estimated/unavailable chips with counts", () => {
    render(
      <UsageChips
        totals={{
          tokens: 1200,
          estimatedCost: 0.5,
          samples: 4,
          bySource: { measured: 1, estimated: 2, unavailable: 1 },
        }}
      />,
    );
    expect(screen.getByText("measured: 1")).toBeTruthy();
    expect(screen.getByText("estimated: 2")).toBeTruthy();
    expect(screen.getByText("unavailable: 1")).toBeTruthy();
    expect(screen.getByText(/1,200 tokens/)).toBeTruthy();
  });

  it("marks usage uncertain when any sample is not measured", () => {
    render(
      <UsageChips
        totals={{
          tokens: 0,
          estimatedCost: 0,
          samples: 1,
          bySource: { measured: 0, estimated: 0, unavailable: 1 },
        }}
      />,
    );
    expect(screen.getByText(/incomplete/i)).toBeTruthy();
  });

  it("shows progress as completed/total tasks and never a percentage", () => {
    const { container } = render(<ProgressText progress={{ completed: 2, total: 5 }} />);
    expect(container.textContent).toBe("2 of 5 tasks completed");
    expect(container.textContent).not.toMatch(/%/);
  });
});

describe("state views", () => {
  it("loading is announced politely", () => {
    render(<LoadingState label="missions" />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading missions/);
  });

  it("error view shows the message and retries", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="server down" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toMatch(/server down/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("empty view renders its message", () => {
    render(<EmptyState>No missions yet.</EmptyState>);
    expect(screen.getByText("No missions yet.")).toBeTruthy();
  });
});

describe("TokenPrompt", () => {
  it("submits the token and is accessible", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<TokenPrompt onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/auth token/i), "tok-123");
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onSubmit).toHaveBeenCalledWith("tok-123");
    expect((screen.getByLabelText(/auth token/i) as HTMLInputElement).type).toBe("password");
    await expectNoSeriousA11yViolations(container);
  });

  it("shows a rejection message", () => {
    render(<TokenPrompt onSubmit={() => undefined} rejected />);
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
  });
});
