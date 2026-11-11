import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ApprovalUnlock } from "./ApprovalUnlock.js";
import { NoticeRegion } from "./Layout.js";
import { TokenPrompt } from "./TokenPrompt.js";
import { Card, LoadState } from "./ui.js";
import { useStore } from "../store/context.js";

function Token() {
  const { state } = useStore();
  return <output data-testid="token">{state.token ?? "none"}</output>;
}

describe("forms that need input", () => {
  it("does not trade a blank pairing code", () => {
    const api = mockApi({ hasApprovalSession: () => false });
    const { container } = renderWithStore(
      <ApprovalUnlock id="code" onUnlocked={() => undefined} />,
      api,
    );
    fireEvent.change(screen.getByLabelText("Approval pairing code"), { target: { value: "  " } });
    fireEvent.submit(container.querySelector("form")!);
    expect(api.unlockApprovals).not.toHaveBeenCalled();
  });

  it("trades the trimmed code once, then tells the parent", async () => {
    const api = mockApi({ hasApprovalSession: () => false });
    const unlocked = vi.fn();
    renderWithStore(<ApprovalUnlock id="code" onUnlocked={unlocked} />, api);
    const input = screen.getByLabelText("Approval pairing code") as HTMLInputElement;
    await userEvent.type(input, "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await waitFor(() => expect(unlocked).toHaveBeenCalledTimes(1));
    expect(api.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    expect(input.value).toBe("");
  });

  it("reports a refused pairing code and lets the person try again", async () => {
    const api = mockApi({
      hasApprovalSession: () => false,
      unlockApprovals: () => Promise.reject(new Error("pairing code is wrong")),
    });
    renderWithStore(
      <>
        <NoticeRegion />
        <ApprovalUnlock id="code" onUnlocked={() => undefined} />
      </>,
      api,
    );
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "WRONG");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/pairing code is wrong/);
    expect(screen.getByRole("button", { name: "Unlock approvals" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("does not sign in with a blank token", () => {
    const { container } = renderWithStore(
      <>
        <TokenPrompt />
        <Token />
      </>,
      mockApi(),
      { token: null },
    );
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "   " } });
    fireEvent.submit(container.querySelector("form")!);
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(sessionStorage.getItem("sindri.token")).toBeNull();
  });
});

describe("notices", () => {
  it("dismisses an error notice", async () => {
    function Raise() {
      const { dispatch } = useStore();
      return (
        <button
          type="button"
          onClick={() => dispatch({ type: "notice", notice: { kind: "error", text: "boom" } })}
        >
          raise
        </button>
      );
    }
    renderWithStore(
      <>
        <NoticeRegion />
        <Raise />
      </>,
      mockApi(),
    );
    await userEvent.click(screen.getByRole("button", { name: "raise" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Error: boom");
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("alert").textContent).toBe("");
  });
});

describe("ui", () => {
  it("renders a card without a heading, and a load error without a retry", () => {
    render(
      <>
        <Card>
          <p>body only</p>
        </Card>
        <LoadState state={{ status: "error", error: "gone" }} what="things">
          {() => null}
        </LoadState>
      </>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("body only")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Could not load things: gone");
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});
