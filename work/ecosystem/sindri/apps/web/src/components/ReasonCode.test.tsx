import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GateFailureList, ReasonCode } from "./ReasonCode.js";

describe("ReasonCode", () => {
  it("shows plain words, with the raw code in a tooltip reachable by keyboard", async () => {
    render(<ReasonCode gateId="brokkr" reason="verification_report_missing" />);
    const words = screen.getByText("Verification report missing");
    expect(words.getAttribute("data-reason-code")).toBe("brokkr verification_report_missing");
    expect(screen.queryByText(/verification_report_missing/)).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(words);
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toContain(
        "brokkr verification_report_missing",
      ),
    );
  });

  it("shows an unknown code raw, without a tooltip trigger", () => {
    render(<ReasonCode reason="brand_new_code" />);
    const raw = screen.getByText("brand_new_code");
    expect(raw.getAttribute("tabindex")).toBeNull();
  });

  it("lists several failures in plain words", () => {
    const { container } = render(
      <GateFailureList
        failures={[
          { gateId: "brokkr", reason: "verification_report_missing" },
          { gateId: "review-verdict", reason: "review_missing" },
          { gateId: "lint", reason: "odd_code" },
        ]}
      />,
    );
    expect(container.textContent).toBe(
      "Verification report missing; Review verdict missing; lint odd_code",
    );
    const codes = [...container.querySelectorAll("[data-reason-code]")].map((e) =>
      e.getAttribute("data-reason-code"),
    );
    expect(codes).toEqual([
      "brokkr verification_report_missing",
      "review-verdict review_missing",
      "lint odd_code",
    ]);
  });
});
