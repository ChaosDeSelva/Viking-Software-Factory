import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError, type ApiClient } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { delivery, executionDetail, inbox, trace } from "../test/delivery-fixtures.js";
import { AppProviders } from "../store/context.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { DeliveriesScreen } from "./DeliveriesScreen.js";
import { PlansScreen } from "./PlansScreen.js";
import { ReviewsScreen } from "./ReviewsScreen.js";

const escalation = (planTaskId: string) => ({
  executionId: "e1",
  planTaskId,
  escalation: "ask" as const,
  reason: "failed twice",
  status: "failed",
  attempts: 2,
});

describe("defects found in the sweep", () => {
  it("finishes a change request under StrictMode: the form clears and the button comes back", async () => {
    const api = mockApi({
      listDeliveries: [],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      listReworks: [],
      requestRework: { rework: { id: "rwk_1" }, spec: { id: "s9" } },
    });
    // StrictMode has to be the root for React to mount, unmount and remount every effect.
    render(
      <StrictMode>
        <AppProviders
          api={api as unknown as ApiClient}
          initial={{ token: "tok", projects: [PROJECT], projectId: PROJECT.id, deliveryId: "e1" }}
        >
          <NoticeRegion />
          <DeliveriesScreen />
        </AppProviders>
      </StrictMode>,
    );
    const form = await screen.findByRole("form", { name: "Request changes to this delivery" });
    const box = within(form).getByLabelText("What should change") as HTMLTextAreaElement;
    await userEvent.type(box, "Use ISO dates");
    await userEvent.click(within(form).getByRole("button", { name: "Request changes" }));
    expect(api.requestRework).toHaveBeenCalledWith("e1", "Use ISO dates");
    expect(await screen.findByText(/A specification was drafted from your feedback/)).toBeTruthy();
    await waitFor(() => expect(box.value).toBe(""));
    expect(within(form).queryByRole("button", { name: "Drafting specification…" })).toBeNull();
    expect(within(form).getByRole("button", { name: "Request changes" })).toBeTruthy();
  });

  it("says so when the approved specs cannot be loaded, instead of 'approve a spec first'", async () => {
    const api = mockApi({
      listPlans: [],
      listSpecs: () => Promise.reject(new ApiError(503, "internal", "database is locked")),
    });
    renderWithStore(<PlansScreen />, api);
    expect(await screen.findByText(/No plans yet/)).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load approved specs: database is locked/);
    expect(screen.queryByText(/Approve a spec first/)).toBeNull();
    api.listSpecs.mockResolvedValue([]);
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Approve a spec first/)).toBeTruthy();
  });

  it("keeps the reason typed for one escalation when another is decided", async () => {
    const reloaded = inbox({ escalations: [escalation("docs")] });
    let finishReload: () => void = () => undefined;
    const api = mockApi({
      reviews: inbox({ escalations: [escalation("qa"), escalation("docs")] }),
      resolveEscalation: () => {
        // The reload takes a moment, as it does over the network.
        api.reviews.mockImplementation(
          () => new Promise((resolve) => (finishReload = () => resolve(reloaded))),
        );
        return Promise.resolve(executionDetail());
      },
    });
    renderWithStore(
      <>
        <NoticeRegion />
        <ReviewsScreen />
      </>,
      api,
    );
    await userEvent.type(await screen.findByLabelText("Reason for qa"), "runner was flaky");
    await userEvent.type(screen.getByLabelText("Reason for docs"), "wrong harness, see log");
    await userEvent.click(screen.getByRole("button", { name: "Retry qa" }));
    expect(api.resolveEscalation).toHaveBeenCalledWith("e1", "qa", "retry", "runner was flaky");
    expect(await screen.findByText("Loading the review inbox…")).toBeTruthy();
    await act(async () => finishReload());
    await waitFor(() => expect(screen.queryByLabelText("Reason for qa")).toBeNull());
    expect((screen.getByLabelText("Reason for docs") as HTMLInputElement).value).toBe(
      "wrong harness, see log",
    );
    expect(screen.getByRole("button", { name: "Skip docs" })).toHaveProperty("disabled", false);
  });
});
