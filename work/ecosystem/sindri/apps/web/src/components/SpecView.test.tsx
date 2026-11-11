import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockingQuestions } from "./SpecView.js";

describe("BlockingQuestions", () => {
  it("fills the answer from the recommendation and submits what the person leaves in the box", async () => {
    const onAnswer = vi.fn();
    render(
      <BlockingQuestions
        busy={false}
        onAnswer={onAnswer}
        questions={[
          {
            id: "Q1",
            text: "Which columns?",
            blocking: true,
            recommendation: "Date and total",
            rationale: "The reports page lists them.",
          },
          { id: "Q2", text: "File name?", blocking: true },
        ]}
      />,
    );
    expect(screen.getByText(/The reports page lists them\./)).toBeTruthy();
    // A question the drafter had no suggestion for offers nothing to accept.
    expect(screen.queryByRole("button", { name: "Use recommendation for Q2" })).toBeNull();

    const submit = screen.getByRole("button", { name: "Submit answer to Q1" });
    expect(submit).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Use recommendation for Q1" }));
    const box = screen.getByLabelText("Q1: Which columns?") as HTMLTextAreaElement;
    expect(box.value).toBe("Date and total");
    // Accepting is a starting point: the person can still edit before submitting.
    await userEvent.type(box, " and customer");
    await userEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith("Q1", "Date and total and customer");
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});
