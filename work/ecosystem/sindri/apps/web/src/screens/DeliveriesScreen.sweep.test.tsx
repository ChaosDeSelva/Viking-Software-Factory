import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport } from "../api/delivery-types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { delivery, trace } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { DeliveriesScreen } from "./DeliveriesScreen.js";

function Where() {
  const { state } = useStore();
  return (
    <output data-testid="where">{`${state.view}:${state.deliveryId ?? ""}:${state.specId ?? ""}`}</output>
  );
}
const ui = (
  <>
    <NoticeRegion />
    <DeliveriesScreen />
    <Where />
  </>
);
const summary = (id: string) => ({
  id,
  executionId: id,
  planId: "pl1",
  planVersion: 1,
  projectId: "p1",
  status: "verified_pending_review",
  mimirMissionId: "msn_1",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
});
const base = () => ({
  listDeliveries: [summary("e1"), summary("e2")],
  getDelivery: delivery(),
  localDelivery: null,
  deliveryTrace: trace(),
  listReworks: [],
});

afterEach(() => vi.useRealTimers());
/** The detail is split into tabs; Report is open first. */
const openTab = async (name: RegExp) => userEvent.click(await screen.findByRole("tab", { name }));

describe("DeliveriesScreen report", () => {
  it("describes every kind of requirement, task, test, change, review and rollback", async () => {
    const r = delivery().report;
    const report: DeliveryReport = {
      ...r,
      status: "delivered_pending_merge",
      requirements: [
        { ...r.requirements[0]!, criterionId: "AC1", status: "satisfied", tasks: [], evidence: [] },
        {
          ...r.requirements[0]!,
          criterionId: "AC2",
          tasks: [
            { planTaskId: "a", mimirTaskId: null, gatePassed: true },
            { planTaskId: "b", mimirTaskId: null, gatePassed: null },
          ],
        },
      ],
      tasks: [
        {
          ...r.tasks[0]!,
          planTaskId: "a",
          brokkr: { verdict: "pass", reportArtifactId: "art_2" },
          gate: { evaluationId: "g", passed: true, failures: [] },
        },
        { ...r.tasks[0]!, planTaskId: "b", gate: null },
      ],
      summary: { sentences: [], stripped: [{ text: "uncited" }, { text: "also uncited" }] },
      testResults: [
        {
          eventId: "t1",
          planTaskId: null,
          command: "pnpm lint",
          passed: false,
          exitCode: 1,
          durationMs: null,
        },
      ],
      changedFiles: [
        { planTaskId: "a", path: "src/a.ts", status: "modified" },
        { planTaskId: null, path: "src/b.ts", status: null },
      ],
      reviews: [
        {
          reviewId: "rv1",
          planTaskId: "a",
          role: "security",
          verdict: "request_changes",
          reason: "unsafe input",
          findings: [
            { severity: "high", message: "escape it" },
            { severity: "low", message: "rename" },
          ],
        },
        { reviewId: "rv2", planTaskId: "b", role: "qa", verdict: null, reason: null, findings: [] },
      ],
      limitations: [],
      rollback: {
        branches: [{ planTaskId: "a", branch: "sindri/a", baseSha: "0123456789abcdef0123" }],
        commits: [],
        note: "Revert the branch.",
      },
    };
    renderWithStore(ui, mockApi({ ...base(), getDelivery: { ...delivery(), report } }), {
      deliveryId: "e1",
    });
    const section = await screen.findByRole("region", { name: "Delivery report" });
    expect(screen.getAllByText("Exported, not merged").length).toBeGreaterThan(0);
    const rows = within(within(section).getByRole("table", { name: "Requirements" }))
      .getAllByRole("row")
      .map((row) => row.textContent);
    expect(rows[1]).toBe("AC1 A CSV button existsSatisfiedNoneNone");
    expect(rows[2]).toContain("a (gate passed), b (gate not run)");
    const tasks = within(within(section).getByRole("table", { name: "Tasks and quality gates" }))
      .getAllByRole("row")
      .map((row) => row.textContent);
    // An unknown Brokkr verdict ("pass") degrades to its raw text.
    expect(tasks[1]).toBe("aimplementerCompletedfrontend-react@1.1.0passPassed");
    expect(tasks[2]).toBe("bimplementerCompletedfrontend-react@1.1.0No reportNot evaluated");
    const text = section.textContent ?? "";
    expect(text).toContain("No evidence-backed summary.");
    expect(text).toContain("2 uncited sentence(s) were removed from the summary.");
    expect(text).toContain("Failedpnpm lint (unattributed)");
    expect(text).not.toMatch(/ in \d+ ms/);
    expect(text).toContain("modifiedsrc/a.ts");
    expect(within(section).getByText("src/b.ts").textContent).toBe("src/b.ts");
    expect(text).toContain("security review of aRequest changesunsafe inputhighescape itlowrename");
    expect(text).toContain("qa review of bPending");
    expect(text).toContain("None recorded.");
    expect(text).toContain("branch sindri/a from 0123456789ab");
    expect(text).toContain("Revert the branch.");
  });
});

describe("DeliveriesScreen actions", () => {
  it("opens a delivery from the list", async () => {
    const api = mockApi(base());
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: /Delivery 2/ }));
    expect(screen.getByTestId("where").textContent).toBe("deliveries:e2:");
    expect(await screen.findByRole("region", { name: "Delivery report" })).toBeTruthy();
    expect(api.getDelivery).toHaveBeenCalledWith("e2");
  });

  it("enables the export once approvals are unlocked here", async () => {
    let unlocked = false;
    const api = mockApi({
      ...base(),
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "p", expiresAt: "" });
      },
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const exportButton = await screen.findByRole("button", { name: /^Export local result/ });
    expect(exportButton.getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export local result" }).hasAttribute("aria-disabled"),
      ).toBe(false),
    );
    expect(screen.queryByLabelText("Approval pairing code")).toBeNull();
  });

  it("says the export is ready when no approval is needed", async () => {
    const api = mockApi({
      ...base(),
      requestPr: { deliveryId: "d1", status: "exported", prs: [] },
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Export local result" }));
    expect(await screen.findByText(/Local delivery: ready/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve local export/ })).toBeNull();
  });

  it("downloads the exact patch under its file name and releases the link afterwards", async () => {
    const patch = "diff --git a/x b/x\n+<b>x</b>\n";
    const api = mockApi({
      ...base(),
      localDelivery: {
        repoPath: "/repo/demo",
        resultCommit: "a".repeat(40),
        patch,
        apply: "git apply result.patch",
        undo: "git apply -R result.patch",
      },
    });
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:patch-1";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Local export/);
    const button = await screen.findByRole("button", { name: "Download result.patch" });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fireEvent.click(button);
    expect(await blobs[0]!.text()).toBe(patch);
    expect(blobs[0]!.type).toBe("text/plain");
    expect(clicked[0]!.download).toBe("result.patch");
    expect(clicked[0]!.href).toBe("blob:patch-1");
    expect(revoke).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(revoke).toHaveBeenCalledWith("blob:patch-1");
    click.mockRestore();
  });

  it("reports a copy that the browser refuses", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("clipboard blocked")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithStore(ui, mockApi(base()), { deliveryId: "e1" });
    await openTab(/Local export/);
    await userEvent.click(await screen.findByRole("button", { name: "Copy summary" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/clipboard blocked/);
  });
});

describe("DeliveriesScreen change requests", () => {
  it("links each request to its newest spec version, and says nothing for one without a spec", async () => {
    const api = mockApi({
      ...base(),
      listReworks: [
        {
          id: "rw1",
          feedback: "Use ISO dates",
          createdAt: "2026-01-02T00:00:00Z",
          baseCommits: [],
          specs: [
            { id: "s3", version: 3, status: "draft", title: "t" },
            { id: "s2", version: 2, status: "approved", title: "t" },
          ],
        },
        {
          id: "rw2",
          feedback: "Drafting failed",
          createdAt: "2026-01-03T00:00:00Z",
          baseCommits: [],
          specs: [],
        },
      ],
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Request changes/);
    const list = await screen.findByRole("region", { name: /Earlier change requests/ });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0]!).getByRole("button").textContent).toMatch(/^Open spec v3 \(draft\)/);
    expect(items[1]!.textContent).toContain("Drafting failed");
    expect(within(items[1]!).queryByRole("button")).toBeNull();
  });

  it("does not send an empty request when the form is submitted directly", async () => {
    const api = mockApi({ ...base(), requestRework: { rework: { id: "r" }, spec: { id: "s" } } });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Request changes/);
    const form = await screen.findByRole("form", { name: "Request changes to this delivery" });
    await userEvent.type(within(form).getByLabelText("What should change"), "   ");
    fireEvent.submit(form);
    expect(api.requestRework).not.toHaveBeenCalled();
  });

  it("sends a request once even when submitted twice while drafting", async () => {
    const api = mockApi({ ...base(), requestRework: () => new Promise(() => undefined) });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Request changes/);
    const form = await screen.findByRole("form", { name: "Request changes to this delivery" });
    await userEvent.type(within(form).getByLabelText("What should change"), "Rename it");
    fireEvent.submit(form);
    await screen.findByRole("button", { name: "Drafting specification…" });
    fireEvent.submit(form);
    expect(api.requestRework).toHaveBeenCalledTimes(1);
  });

  it("tells, but does not move, someone who opened another delivery while drafting", async () => {
    let finish: (v: unknown) => void = () => undefined;
    const api = mockApi({
      ...base(),
      requestRework: () => new Promise((r) => (finish = r)),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await openTab(/Request changes/);
    const form = await screen.findByRole("form", { name: "Request changes to this delivery" });
    await userEvent.type(within(form).getByLabelText("What should change"), "Rename it");
    await userEvent.click(within(form).getByRole("button", { name: "Request changes" }));
    await userEvent.click(screen.getByRole("button", { name: /Delivery 2/ }));
    await waitFor(() => expect(api.getDelivery).toHaveBeenCalledWith("e2"));
    await act(async () => finish({ rework: { id: "rw" }, spec: { id: "s9" } }));
    expect(await screen.findByText(/drafted from your feedback/)).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("deliveries:e2:");
    // The other delivery's form is its own: empty and ready.
    await openTab(/Request changes/);
    const other = screen.getByRole("form", { name: "Request changes to this delivery" });
    expect((within(other).getByLabelText("What should change") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });
});

describe("DeliveriesScreen sparse report", () => {
  it("says when no tests were recorded", async () => {
    const report = { ...delivery().report, testResults: [] };
    renderWithStore(ui, mockApi({ ...base(), getDelivery: { ...delivery(), report } }), {
      deliveryId: "e1",
    });
    const section = await screen.findByRole("region", { name: "Delivery report" });
    expect(within(section).getByText("No test runs recorded.")).toBeTruthy();
    expect(within(section).getByText("No changed-file manifest recorded.")).toBeTruthy();
    expect(within(section).getByText("No independent reviews recorded.")).toBeTruthy();
  });
});
