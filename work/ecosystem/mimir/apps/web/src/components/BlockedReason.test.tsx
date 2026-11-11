import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BlockedReason } from "./BlockedReason.js";

describe("BlockedReason", () => {
  it("shows plain words, with the raw reason in a tooltip reachable by keyboard", async () => {
    render(<BlockedReason reason="budget_exceeded" />);
    const words = screen.getByText("Budget used up");
    expect(words.dataset.blockedReason).toBe("budget_exceeded");
    expect(screen.queryByText(/budget_exceeded/)).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(words);
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toContain("budget_exceeded"),
    );
  });

  it("shows an unknown reason raw, not focusable", () => {
    render(<BlockedReason reason="waiting on a person" />);
    expect(screen.getByText("waiting on a person").getAttribute("tabindex")).toBeNull();
  });
});
