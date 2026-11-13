import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import {
  deliverySummary,
  prDelivery,
  preview,
  prReview,
  reviewPost,
} from "../test/work-fixtures.js";
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
    getDelivery: prDelivery(),
    previewReview: preview(),
    ...over,
  });
  renderWithStore(ui, api, { deliveryId: "e1" });
  return api;
}

const openPreview = async () => {
  await userEvent.click(await screen.findByRole("tab", { name: "Preview and post" }));
  return screen.findByRole("region", { name: "Review preview" });
};
const postButton = () => screen.getByRole("button", { name: /^Post review to GitHub/ });
const rejectPost = (err: ApiError) => ({ postReview: () => Promise.reject(err) });

describe("PR review delivery", () => {
  it("shows the PR, the draft version and starts from the draft, not the agent's verdict", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Add CSV export" })).toBeTruthy();
    const link = screen.getByRole("link", { name: /acme\/shop#7/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/shop/pull/7");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    // The agent said approve; draft version 0 is `comment`.
    expect((screen.getByLabelText("Verdict") as HTMLSelectElement).value).toBe("comment");
    expect(screen.getByText(/Draft version 0/)).toBeTruthy();
    expect(screen.getByText("Local only")).toBeTruthy();
    // The placement note shows next to the finding.
    expect(screen.getByText(/file not in the PR/)).toBeTruthy();
  });

  it("shows an edited draft with its version and editor", async () => {
    setup({
      getDelivery: prDelivery(
        {},
        {
          version: 3,
          verdict: "request_changes",
          summary: "Edited summary",
          editedBy: "local:me",
          editedAt: "2026-01-02T00:00:00Z",
          findings: [
            {
              id: "f1",
              severity: "major",
              message: "Edited finding",
              placement: "general",
              included: false,
            },
          ],
        },
      ),
    });
    await screen.findByRole("heading", { name: "Add CSV export" });
    expect(screen.getByText(/Draft version 3/)).toBeTruthy();
    expect(screen.getByText(/edited by local:me/)).toBeTruthy();
    expect((screen.getByLabelText("Verdict") as HTMLSelectElement).value).toBe("request_changes");
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Edited summary");
    expect(screen.getByText("Edited finding")).toBeTruthy();
    expect(screen.queryByText("Unescaped commas break the CSV")).toBeNull();
  });

  it("edits and saves the draft, then shows the new version", async () => {
    const saved = prReview(
      {},
      { version: 1, verdict: "request_changes", summary: "Needs escaping." },
    );
    const api = setup({ saveReview: saved });
    await screen.findByRole("heading", { name: "Add CSV export" });
    const save = () => screen.getByRole("button", { name: /^Save edits/ });
    expect(save().getAttribute("aria-disabled")).toBe("true");
    await userEvent.selectOptions(screen.getByLabelText("Verdict"), "request_changes");
    const summary = screen.getByLabelText("Summary");
    await userEvent.clear(summary);
    await userEvent.type(summary, "Needs escaping.");
    const table = screen.getByRole("table", { name: "Review findings" });
    await userEvent.click(within(table).getByRole("checkbox", { name: /Consider a changelog/ }));
    await userEvent.click(within(table).getByRole("button", { name: /Edit finding: Unescaped/ }));
    const box = within(table).getByLabelText("Finding message");
    await userEvent.clear(box);
    await userEvent.type(box, "Quote fields that contain commas");
    await userEvent.click(within(table).getByRole("button", { name: "Save" }));
    expect(screen.getByText("Unsaved edits")).toBeTruthy();
    await openPreview();
    expect(postButton().textContent).toMatch(/Save your edits first/);
    await userEvent.click(screen.getByRole("tab", { name: "Review" }));
    api.getDelivery.mockResolvedValue(
      prDelivery({}, { version: 1, verdict: "request_changes", summary: "Needs escaping." }),
    );
    await userEvent.click(save());
    expect(api.saveReview).toHaveBeenCalledWith("e1", {
      verdict: "request_changes",
      summary: "Needs escaping.",
      findings: [
        { id: "f1", included: true, message: "Quote fields that contain commas" },
        { id: "f2", included: false, message: "Consider a changelog entry" },
      ],
    });
    expect(await screen.findByText(/saved as draft version 1/)).toBeTruthy();
    expect(screen.getByText(/Draft version 1/)).toBeTruthy();
    await waitFor(() => expect(api.previewReview).toHaveBeenCalledTimes(2));
  });

  it("explains a save refused for unknown finding ids or an already posted review", async () => {
    const api = setup({
      saveReview: () =>
        Promise.reject(new ApiError(422, "validation_failed", "unknown finding ids")),
    });
    await screen.findByRole("heading", { name: "Add CSV export" });
    await userEvent.type(screen.getByLabelText("Summary"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save edits" }));
    expect(await screen.findByText("Some findings no longer exist")).toBeTruthy();
    api.saveReview.mockRejectedValueOnce(
      new ApiError(409, "already_posted", "posted", { htmlUrl: "https://github.com/x#r1" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save edits" }));
    expect(await screen.findByText("Posted to GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: /github\.com\/x#r1/ })).toBeTruthy();
  });

  it("previews the payload as text with the leak check, comments and the draft version", async () => {
    setup({
      previewReview: preview({
        payload: {
          commit_id: "2222222222222222222222",
          event: "REQUEST_CHANGES",
          body: "<img src=x onerror=alert(1)> body",
          comments: [
            { path: "src/a.ts", line: 9, start_line: 7, side: "RIGHT", body: "Range comment" },
          ],
        },
      }),
    });
    const region = await openPreview();
    expect(within(region).getByText("Ready to post")).toBeTruthy();
    expect(within(region).getByText(/Leak check passed/)).toBeTruthy();
    expect(within(region).getByText("Request changes")).toBeTruthy();
    // Unsanitized payload text stays text.
    expect(within(region).getByText(/<img src=x onerror=alert\(1\)> body/)).toBeTruthy();
    expect(region.querySelector("img")).toBeNull();
    expect(within(region).getByText("src/a.ts:7-9 (new side)")).toBeTruthy();
  });

  it("lists the server's blockers and keeps posting disabled", async () => {
    setup({
      previewReview: preview({
        canPost: false,
        gatesPassed: false,
        blockers: ["gates_not_passed", "post_blocked"],
        leakCheck: { ok: false, rule: "lesson_reference", findingId: "f2", field: "message" },
      }),
    });
    const region = await openPreview();
    const blockers = within(region).getByRole("list", { name: "Blockers" });
    expect(within(blockers).getByText(/checks have not passed/)).toBeTruthy();
    expect(within(blockers).getByText(/leak check found text/)).toBeTruthy();
    expect(postButton().textContent).toMatch(/checks have not passed/);
    const alert = screen.getByText("Posting is blocked by the leak check").closest("[role=alert]");
    expect(within(alert as HTMLElement).getByText(/cites a private lesson/)).toBeTruthy();
    expect(within(alert as HTMLElement).getByText(/Consider a changelog entry/)).toBeTruthy();
  });

  it("asks for a fresh preview when it shows an older draft version", async () => {
    setup({
      getDelivery: prDelivery({}, { version: 2 }),
      previewReview: preview({ draftVersion: 1 }),
    });
    await openPreview();
    expect(screen.getByText("The preview is out of date")).toBeTruthy();
    expect(postButton().textContent).toMatch(/Refresh the preview first/);
  });

  it("posts with the approval secret and then shows the review URL", async () => {
    const url = "https://github.com/acme/shop/pull/7#pullrequestreview-1";
    const api = setup({
      hasApprovalSession: () => false,
      postReview: { posted: reviewPost(url), review: prReview() },
    });
    await openPreview();
    expect(postButton().getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "CODE1-23456");
    api.hasApprovalSession.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await userEvent.click(postButton());
    expect(api.postReview).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("Posted to GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: new RegExp(url) }).getAttribute("target")).toBe(
      "_blank",
    );
    expect(screen.queryByRole("button", { name: /^Post review to GitHub/ })).toBeNull();
  });

  it("shows the earlier review on already_posted", async () => {
    const htmlUrl = "https://github.com/acme/shop/pull/7#pullrequestreview-0";
    setup(rejectPost(new ApiError(409, "already_posted", "already posted", { htmlUrl })));
    await openPreview();
    await userEvent.click(postButton());
    expect(await screen.findByText("Posted to GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: new RegExp(htmlUrl) })).toBeTruthy();
  });

  it.each([
    [
      new ApiError(409, "pr_head_moved", "moved", {
        reviewedSha: "2222222222222222",
        currentSha: "3333333333333333",
      }),
      "The pull request changed since this review",
      /reviewed at 222222222222; the pull request is now at 333333333333.*Import the pull request again/,
    ],
    [
      new ApiError(409, "post_in_progress", "busy"),
      "This review is being posted already",
      /Wait a moment/,
    ],
    [
      new ApiError(409, "gates_not_passed", "no"),
      "The review did not pass its checks",
      /Run the review again/,
    ],
    [new ApiError(503, "local_only", "local"), "Local-only mode is on", /Settings/],
    [
      new ApiError(502, "github_error", "HTTP 422 Unprocessable"),
      "GitHub refused the review",
      /gh failed while posting: HTTP 422 Unprocessable/,
    ],
    [
      new ApiError(403, "approval_required", "locked"),
      "Approvals are locked",
      /pairing code again/,
    ],
  ])("explains %s when posting", async (err, title, body) => {
    setup(rejectPost(err));
    await openPreview();
    await userEvent.click(postButton());
    const heading = await screen.findByText(title);
    expect((heading.parentElement as HTMLElement).textContent).toMatch(body);
    expect(screen.queryByText("Posted to GitHub")).toBeNull();
  });

  it("shows the blocking rule and the finding on post_blocked, and can exclude it", async () => {
    const api = setup({
      ...rejectPost(
        new ApiError(422, "post_blocked", "blocked", {
          rule: "private_tooling",
          findingId: "f2",
          field: "message",
        }),
      ),
      saveReview: prReview(),
    });
    await openPreview();
    await userEvent.click(postButton());
    const alert = await screen.findByText("Posting is blocked by the leak check");
    const box = alert.closest("[role=alert]") as HTMLElement;
    expect(within(box).getByText("private_tooling")).toBeTruthy();
    expect(within(box).getByText(/names private local tooling/)).toBeTruthy();
    expect(within(box).getByText(/Consider a changelog entry/)).toBeTruthy();
    await userEvent.click(within(box).getByRole("button", { name: "Exclude this finding" }));
    await userEvent.click(screen.getByRole("tab", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Save edits" }));
    expect(api.saveReview).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        findings: expect.arrayContaining([expect.objectContaining({ id: "f2", included: false })]),
      }),
    );
  });

  it("names the summary when the leak is not in a finding", async () => {
    setup(
      rejectPost(
        new ApiError(422, "post_blocked", "blocked", {
          rule: "secret:github_token",
          findingId: null,
          field: "summary",
        }),
      ),
    );
    await openPreview();
    await userEvent.click(postButton());
    expect(
      await screen.findByText(/The summary looks like a secret \(github_token\)/),
    ).toBeTruthy();
  });

  it("shows one section per reviewer, failed checks and an unreadable diff", async () => {
    setup({
      getDelivery: prDelivery({
        gatePassed: false,
        gateFailures: [{ gateId: "pr-review-schema", reason: "summary_missing" }],
        hunksAvailable: false,
      }),
    });
    await screen.findByRole("heading", { name: "Add CSV export" });
    expect(screen.getByText("The reviewers' checks did not pass")).toBeTruthy();
    expect(screen.getByText("The pull request diff could not be read")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /Reviewers/ }));
    expect(screen.getByText("reviewer review (pr-review)")).toBeTruthy();
    expect(screen.getByText("security review (security-review)")).toBeTruthy();
    expect(screen.getByText("Token is logged.")).toBeTruthy();
    expect(screen.getByText("Verdict: Request changes")).toBeTruthy();
  });

  it("shows an already posted review read-only", async () => {
    setup({
      getDelivery: prDelivery({
        posted: reviewPost("https://github.com/acme/shop/pull/7#pullrequestreview-5"),
      }),
    });
    expect(await screen.findByText("Posted to GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: /pullrequestreview-5/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save edits/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Include finding/ })).toBeNull();
  });

  it("degrades an unknown verdict and severity", async () => {
    setup({
      getDelivery: prDelivery(
        {},
        {
          verdict: "something_new",
          findings: [
            {
              id: "f9",
              severity: "cosmic",
              message: "Odd one",
              placement: "elsewhere",
              included: true,
            },
          ],
        },
      ),
    });
    await screen.findByRole("heading", { name: "Add CSV export" });
    expect((screen.getByLabelText("Verdict") as HTMLSelectElement).value).toBe("comment");
    expect(screen.getByText("Odd one")).toBeTruthy();
    expect(screen.getByText("Cosmic")).toBeTruthy();
  });
});
