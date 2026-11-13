import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { delivery, trace } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { deliverySummary, researchDelivery } from "../test/work-fixtures.js";
import { DeliveriesScreen } from "./DeliveriesScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <DeliveriesScreen />
  </>
);

function setup(over: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    listDeliveries: [deliverySummary],
    getDelivery: researchDelivery(),
    ...over,
  });
  renderWithStore(ui, api, { deliveryId: "e1" });
  return api;
}

describe("research delivery", () => {
  it("shows the document with sources in citation order, private badge and no export tab", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "How are invoices totalled?" })).toBeTruthy();
    expect(screen.getByText("Contains private lessons")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Local export/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export local result/ })).toBeNull();
    const doc = screen.getByRole("region", { name: "Research document" });
    const items = within(doc).getAllByRole("listitem");
    // Source id 1 is listed first even though sources.json put it second.
    expect(items[0]!.textContent).toContain("src/totals.ts:10-20");
    expect(items[1]!.textContent).toContain("Private lesson");
    // The document's own Sources section is replaced by the numbered list.
    expect(within(doc).getAllByRole("heading", { name: "Sources" })).toHaveLength(1);
  });

  it("copies the document as Markdown without private lesson citations", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Copy as Markdown" }));
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain("summed in the service [1]");
    expect(copied).toContain("See [1].");
    expect(copied).not.toMatch(/\[2\]|\[1, 2\]|## Sources/);
    expect(await screen.findByText(/Copied the document without private lessons/)).toBeTruthy();
  });

  it("accepts with the approval secret flow", async () => {
    const api = setup({ acceptDocument: {}, hasApprovalSession: () => false });
    const accept = await screen.findByRole("button", { name: /^Accept/ });
    expect(accept.getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    api.hasApprovalSession.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(api.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(api.acceptDocument).toHaveBeenCalledWith("e1");
    expect(await screen.findByText(/Document accepted/)).toBeTruthy();
    expect(api.getDelivery).toHaveBeenCalledTimes(2);
  });

  it("does not accept a document whose checks failed", async () => {
    setup({
      getDelivery: researchDelivery({
        gate: {
          passed: false,
          failures: [{ gateId: "research-citations", reason: "citation_unresolved:3" }],
        },
      }),
    });
    const accept = await screen.findByRole("button", { name: /^Accept/ });
    expect(accept.textContent).toMatch(/quality checks have not passed/);
    await userEvent.click(screen.getByRole("tab", { name: /Checks/ }));
    expect(await screen.findByText(/citation_unresolved|citation/i)).toBeTruthy();
  });

  it("shows the decision and blocks a second one", async () => {
    setup({
      getDelivery: researchDelivery({
        decision: {
          decision: "rejected",
          actor: "local:me",
          reason: "too thin",
          decidedAt: "2026-01-02T00:00:00Z",
        },
      }),
    });
    expect(await screen.findByText("Rejected")).toBeTruthy();
    expect(screen.getByText(/too thin/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Accept/ }).textContent).toMatch(/already rejected/);
  });

  it("rejects only with a reason and reports server errors", async () => {
    const api = setup();
    api.rejectDocument
      .mockRejectedValueOnce(new ApiError(409, "invalid_state", "already decided"))
      .mockResolvedValueOnce({});
    await userEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    const form = screen.getByRole("form", { name: "Reject the document" });
    const submit = () => within(form).getByRole("button", { name: /^Reject document/ });
    expect(submit().textContent).toMatch(/Give a reason first/);
    await userEvent.click(submit());
    expect(api.rejectDocument).not.toHaveBeenCalled();
    await userEvent.type(
      within(form).getByLabelText("Why is it rejected?"),
      " Misses the tax rule ",
    );
    await userEvent.click(submit());
    expect(api.rejectDocument).toHaveBeenCalledWith("e1", "Misses the tax rule");
    expect(await screen.findByText(/already decided/)).toBeTruthy();
    await userEvent.click(submit());
    expect(await screen.findByText(/Document rejected/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Reject the document" })).toBeNull();
  });

  it("asks a follow-up question", async () => {
    const api = setup({ followUp: { id: "i9" } });
    await userEvent.click(await screen.findByRole("button", { name: "Ask a follow-up…" }));
    const form = screen.getByRole("form", { name: "Ask a follow-up question" });
    await userEvent.type(within(form).getByLabelText("Follow-up question"), "What about refunds?");
    await userEvent.click(within(form).getByRole("button", { name: "Add follow-up" }));
    expect(api.followUp).toHaveBeenCalledWith("e1", "What about refunds?");
    expect(await screen.findByText(/Follow-up question added to the inbox/)).toBeTruthy();
  });

  it("lists fact-check findings read-only and the guidance used", async () => {
    setup();
    await userEvent.click(await screen.findByRole("tab", { name: /Checks/ }));
    const table = await screen.findByRole("table", { name: "Fact-check findings" });
    expect(within(table).getByText("Claim 2 is loosely supported")).toBeTruthy();
    expect(within(table).queryByRole("checkbox")).toBeNull();
    expect(within(table).queryByRole("button", { name: /Edit/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Guidance" }));
    const skills = screen.getByRole("region", { name: "Skills used" });
    expect(within(skills).getByText("code-review")).toBeTruthy();
    expect(within(skills).getByText("abcdef012345")).toBeTruthy();
    expect(screen.getByText("feedface0011")).toBeTruthy();
  });

  it("shows an unknown work kind as a code change with a notice", async () => {
    const d = delivery();
    setup({
      getDelivery: { ...d, report: { ...d.report, workKind: "translation" } },
      deliveryTrace: trace(),
      localDelivery: null,
    });
    expect(await screen.findByText("Unrecognised kind of work")).toBeTruthy();
    expect(screen.getByText(/\(translation\)/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Local export/ })).toBeTruthy();
  });
});
