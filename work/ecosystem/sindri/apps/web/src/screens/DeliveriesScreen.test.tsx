import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { delivery, trace } from "../test/delivery-fixtures.js";
import { useStore } from "../store/context.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { DeliveriesScreen } from "./DeliveriesScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <DeliveriesScreen />
  </>
);
/** Where the store says the app is, so a test can assert navigation. */
function Where() {
  const { state } = useStore();
  return <output data-testid="where">{`${state.view}:${state.specId ?? ""}`}</output>;
}
/** The detail is split into tabs; Report is open first. */
const openTab = async (name: RegExp) => userEvent.click(await screen.findByRole("tab", { name }));
const summary = {
  id: "e1",
  executionId: "e1",
  planId: "pl1",
  planVersion: 1,
  projectId: "p1",
  status: "verified_pending_review",
  mimirMissionId: "msn_1",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
};

describe("DeliveriesScreen", () => {
  it("shows and approves the local export gate without needing a GitHub workflow", async () => {
    const request = {
      deliveryId: "d1",
      status: "built",
      prs: [
        { planTaskId: "docs", mimirTaskId: "t1", status: "awaiting_approval", approvalId: "a1" },
      ],
    };
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      deliveryTrace: trace(),
      localDelivery: null,
      requestPr: request,
      decideApproval: {},
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Export local result" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve local export: docs" }),
    );
    expect(api.decideApproval).toHaveBeenCalledWith(
      "e1",
      "a1",
      "approved",
      "Approve verified local export",
    );
  });

  it("requests changes: sends the feedback, opens the drafted specification, and keeps the text on failure", async () => {
    const base = {
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
    };
    const api = mockApi({
      ...base,
      requestRework: { rework: { id: "rwk_1" }, spec: { id: "s9" } },
    });
    const { unmount } = renderWithStore(
      <>
        {ui}
        <Where />
      </>,
      api,
      { deliveryId: "e1" },
    );
    await openTab(/Request changes/);
    const form = await screen.findByRole("form", { name: "Request changes to this delivery" });
    // A soft-disabled button's name carries its reason, so match the start.
    const send = () => within(form).getByRole("button", { name: /^Request changes/ });
    expect(send().getAttribute("aria-disabled")).toBe("true");
    expect(send().textContent).toMatch(/Describe what should change/);
    await userEvent.type(within(form).getByLabelText("What should change"), "  Use ISO dates  ");
    await userEvent.click(send());
    expect(api.requestRework).toHaveBeenCalledWith("e1", "Use ISO dates");
    expect(await screen.findByText(/A specification was drafted from your feedback/)).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("specs:s9");
    unmount();

    const failing = mockApi(base);
    failing.requestRework.mockRejectedValue(new ApiError(409, "invalid_state", "no result yet"));
    renderWithStore(ui, failing, { deliveryId: "e1" });
    await openTab(/Request changes/);
    const again = await screen.findByRole("form", { name: "Request changes to this delivery" });
    const box = within(again).getByLabelText("What should change") as HTMLTextAreaElement;
    await userEvent.type(box, "Rename the column");
    await userEvent.click(within(again).getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText(/no result yet/)).toBeTruthy();
    expect(box.value).toBe("Rename the column");
    const retry = within(again).getByRole("button", { name: "Request changes" });
    expect(retry.hasAttribute("disabled") || retry.hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows an empty state", async () => {
    renderWithStore(ui, mockApi({ listDeliveries: [] }));
    expect(await screen.findByText(/No deliveries yet/)).toBeTruthy();
  });

  it("shows the report, PR text with a copy button and the trace tree", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const report = await screen.findByRole("region", { name: "Delivery report" });
    expect(report.textContent).toMatch(/AC1/);
    expect(report.textContent).toMatch(/pnpm test/);
    expect(report.textContent).toMatch(/Unverified/);
    expect(report.textContent).toMatch(/Verification report missing/);
    expect(
      report.querySelector('[data-reason-code="brokkr verification_report_missing"]'),
    ).toBeTruthy();
    expect(report.textContent).toMatch(/\[ref:evt_8\]/);
    await openTab(/Local export/);
    expect((await screen.findByLabelText("Delivery description")).textContent).toMatch(
      /## Requirements/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writeText).toHaveBeenCalledWith(delivery().prDescription);
    expect((await screen.findByRole("status")).textContent).toMatch(/copied/i);
    await openTab(/Trace/);
    const tree = await screen.findByRole("list", { name: "Trace" });
    expect(within(tree).getByText(/Mimir mission msn_1/)).toBeTruthy();
    expect(within(tree).getByText(/test.output/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export local result" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reports a refused PR request", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      requestPr: () =>
        Promise.reject(
          new ApiError(
            409,
            "invalid_state",
            "quality gates have not passed for: implement-frontend",
          ),
        ),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Export local result" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/quality gates have not passed/);
  });

  it("keeps Export local result disabled until approvals are unlocked (audit M9)", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      hasApprovalSession: () => false,
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const button = await screen.findByRole("button", { name: /^Export local result/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button);
    expect(api.requestPr).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Approval pairing code")).toBeTruthy();
  });

  it("re-runs the quality checks and reloads the delivery (M11)", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      listReworks: [],
      assessExecution: () => new Promise(() => undefined),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Re-run quality checks" }));
    expect(api.assessExecution).toHaveBeenCalledWith("e1");
    expect(
      screen.getByRole("button", { name: "Re-running quality checks…" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("reloads the delivery after the quality checks finish (M11)", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      listReworks: [],
      assessExecution: [],
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Re-run quality checks" }));
    expect(await screen.findByText(/Quality checks re-run/)).toBeTruthy();
    await waitFor(() => expect(api.getDelivery).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Re-run quality checks" })).toBeTruthy();
  });

  it("lists earlier change requests, links each to its latest spec and reloads after a new one (L3)", async () => {
    const rework = {
      id: "rwk_1",
      feedback: "Use ISO dates",
      createdAt: "2026-01-02T00:00:00Z",
      baseCommits: ["abc"],
      specs: [
        { id: "s7", version: 1, status: "superseded", title: "ISO dates" },
        { id: "s8", version: 2, status: "draft", title: "ISO dates" },
      ],
    };
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      listReworks: [rework],
      requestRework: { rework: { id: "rwk_2" }, spec: { id: "s9" } },
    });
    renderWithStore(
      <>
        {ui}
        <Where />
      </>,
      api,
      { deliveryId: "e1" },
    );
    await openTab(/Request changes/);
    const earlier = await screen.findByRole("region", { name: /Earlier change requests/ });
    expect(within(earlier).getByText(/Use ISO dates/)).toBeTruthy();
    await userEvent.click(within(earlier).getByRole("button", { name: /Open spec v2 \(draft\)/ }));
    expect(screen.getByTestId("where").textContent).toBe("specs:s8");

    expect(api.listReworks).toHaveBeenCalledTimes(1);
    await openTab(/Request changes/);
    const form = screen.getByRole("form", { name: "Request changes to this delivery" });
    await userEvent.type(within(form).getByLabelText("What should change"), "Rename the column");
    await userEvent.click(within(form).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(api.listReworks).toHaveBeenCalledTimes(2));
    expect(api.listReworks).toHaveBeenLastCalledWith("e1");
  });

  const local = {
    baseSha: "a".repeat(40),
    resultCommit: "b".repeat(40),
    // Markup and trailing whitespace must come through untouched.
    patch: "diff --git a/x.html b/x.html\n+<b>bold</b> &amp; <script>alert(1)</script>  \n\t+end\n",
    repoPath: "/repo/demo",
    apply: "git apply result.patch",
    undo: "git apply -R result.patch",
  };

  it("shows the exact patch as plain text, with copy and download", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: local,
      deliveryTrace: trace(),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Local export/);
    const block = await screen.findByRole("region", { name: "Patch" });
    const pre = block.querySelector("pre")!;
    expect(pre.textContent).toBe(local.patch);
    // Text, not markup: nothing in the patch became an element.
    expect(pre.children.length).toBe(0);
    expect(block.textContent).toMatch(/complete and unaltered/);
    expect(block.textContent).not.toMatch(/preview|shortened|truncated/i);
    expect(within(block).getByRole("button", { name: "Download result.patch" })).toBeTruthy();
    await userEvent.click(within(block).getByRole("button", { name: "Copy patch" }));
    expect(writeText).toHaveBeenCalledWith(local.patch);
    expect((await screen.findByRole("status")).textContent).toMatch(/Copied the patch/);
    expect(screen.queryByRole("region", { name: /Follow-up only/ })).toBeNull();
  });

  it("shows a rework's follow-up patch as its own block above the full patch", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const followUp = { baseSha: "c".repeat(40), patch: "diff --git a/y b/y\n+<i>only this</i>\n" };
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: { ...local, followUp },
      deliveryTrace: trace(),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Local export/);
    const follow = await screen.findByRole("region", {
      name: "Follow-up only — use this if you already applied the earlier delivery",
    });
    const full = screen.getByRole("region", { name: "Full patch — the whole change" });
    expect(follow.querySelector("pre")!.textContent).toBe(followUp.patch);
    expect(follow.querySelector("pre")!.children.length).toBe(0);
    expect(follow.textContent).toContain(followUp.baseSha);
    expect(full.querySelector("pre")!.textContent).toBe(local.patch);
    expect(follow.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(follow).getByRole("button", { name: "Download follow-up.patch" })).toBeTruthy();
    await userEvent.click(within(follow).getByRole("button", { name: "Copy follow-up patch" }));
    expect(writeText).toHaveBeenCalledWith(followUp.patch);
    await userEvent.click(within(full).getByRole("button", { name: "Copy patch" }));
    expect(writeText).toHaveBeenLastCalledWith(local.patch);
  });
});

describe("DeliveriesScreen layout", () => {
  const base = {
    listDeliveries: [summary],
    getDelivery: delivery(),
    localDelivery: null,
    deliveryTrace: trace(),
    listReworks: [],
  };

  it("opens the most recent delivery from the empty detail", async () => {
    renderWithStore(ui, mockApi(base));
    expect(await screen.findByRole("heading", { level: 1, name: "Deliveries" })).toBeTruthy();
    await userEvent.click(
      await screen.findByRole("button", { name: "Open the most recent delivery" }),
    );
    expect(await screen.findByRole("region", { name: "Delivery report" })).toBeTruthy();
  });

  it("splits the detail into tabs and jumps to the export when exporting", async () => {
    const api = mockApi({
      ...base,
      requestPr: { deliveryId: "d1", status: "exported", prs: [] },
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Report",
      "Local export",
      "Request changes",
      "Trace",
    ]);
    expect(screen.getByRole("tab", { name: "Report" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Export local result" }));
    expect(screen.getByRole("tab", { name: "Local export" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByText("No approved local export yet.")).toBeTruthy();
  });

  it("keeps the patch text collapsed until asked for", async () => {
    const api = mockApi({
      ...base,
      localDelivery: {
        baseSha: "a",
        resultCommit: "b".repeat(40),
        patch: "diff\n+x\n",
        repoPath: "/repo/demo",
        apply: "git apply result.patch",
        undo: "git apply -R result.patch",
      },
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Local export/);
    const block = await screen.findByRole("region", { name: "Patch" });
    const details = block.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(within(block).getByText("Show result.patch (3 lines)"));
    expect(details.open).toBe(true);
  });
});
