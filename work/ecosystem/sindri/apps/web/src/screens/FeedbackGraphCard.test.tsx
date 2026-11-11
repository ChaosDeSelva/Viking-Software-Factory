import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { projectFg } from "../test/steward-fixtures.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { ProjectsScreen } from "./ProjectsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <ProjectsScreen />
  </>
);
const card = async () =>
  (await screen.findByRole("heading", { name: "Feedback Graph" })).closest("section")!;
const base = { listProjects: [PROJECT], getProfile: {} };

describe("ProjectsScreen Feedback Graph card", () => {
  it("shows the automatic link, the key and the project's lessons", async () => {
    const api = mockApi({ ...base, getProjectFeedbackGraph: projectFg() });
    renderWithStore(ui, api);
    const c = await card();
    expect(await within(c).findByText("Linked automatically")).toBeTruthy();
    expect(api.getProjectFeedbackGraph).toHaveBeenCalledWith("p1");
    expect(c.textContent).toContain("Project key demo");
    const lessons = within(c).getByRole("list", { name: "Feedback Graph lessons" });
    expect(lessons.textContent).toContain("Confirm column order");
    expect(lessons.textContent).toContain("Ask before reordering CSV columns.");
    expect(lessons.textContent).toContain("When: Changing exports");
    expect(lessons.textContent).toContain("src/export/**, src/reports.ts");
    // Nothing to clear while the link is automatic.
    expect(within(c).queryByRole("button", { name: "Use automatic" })).toBeNull();
  });

  it("saves an override key", async () => {
    const api = mockApi({
      ...base,
      getProjectFeedbackGraph: projectFg({
        link: { projectKey: null, source: "none" },
        lessons: [],
      }),
      setProjectFeedbackGraph: projectFg({ link: { projectKey: "demo-app", source: "override" } }),
    });
    renderWithStore(ui, api);
    const c = await card();
    expect(await within(c).findByText("Not linked")).toBeTruthy();
    expect(within(c).getByText("No lessons: not linked.")).toBeTruthy();
    const save = within(c).getByRole("button", { name: "Save override" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(within(c).getByLabelText("Override project key"), " demo-app ");
    await userEvent.click(save);
    expect(api.setProjectFeedbackGraph).toHaveBeenCalledWith("p1", "demo-app");
    expect(await within(c).findByText("Linked by override")).toBeTruthy();
    expect(await screen.findByText("Feedback Graph link saved")).toBeTruthy();
    expect((within(c).getByLabelText("Override project key") as HTMLInputElement).value).toBe(
      "demo-app",
    );
  });

  it("clears an override back to the automatic match", async () => {
    const api = mockApi({
      ...base,
      getProjectFeedbackGraph: projectFg({ link: { projectKey: "demo-app", source: "override" } }),
      setProjectFeedbackGraph: projectFg(),
    });
    renderWithStore(ui, api);
    const c = await card();
    await userEvent.click(await within(c).findByRole("button", { name: "Use automatic" }));
    expect(api.setProjectFeedbackGraph).toHaveBeenCalledWith("p1", null);
    expect(await within(c).findByText("Linked automatically")).toBeTruthy();
    expect((within(c).getByLabelText("Override project key") as HTMLInputElement).value).toBe("");
    expect(within(c).queryByRole("button", { name: "Use automatic" })).toBeNull();
  });

  it("shows an empty lesson list and the server's Feedback Graph error", async () => {
    renderWithStore(
      ui,
      mockApi({
        ...base,
        getProjectFeedbackGraph: projectFg({ lessons: [], error: "Feedback Graph is unreachable" }),
      }),
    );
    const c = await card();
    expect(
      await within(c).findByText("Feedback Graph could not be read: Feedback Graph is unreachable"),
    ).toBeTruthy();
    expect(within(c).getByText("No approved lessons for this project yet.")).toBeTruthy();
  });

  it("shows a load error with retry, and a failed save as a notice", async () => {
    let fail = true;
    const api = mockApi({
      ...base,
      getProjectFeedbackGraph: () =>
        fail ? Promise.reject(new Error("offline")) : Promise.resolve(projectFg()),
      setProjectFeedbackGraph: () => Promise.reject(new Error("no such project key")),
    });
    renderWithStore(ui, api);
    const c = await card();
    expect(
      await within(c).findByText("Could not load the Feedback Graph link: offline"),
    ).toBeTruthy();
    fail = false;
    await userEvent.click(within(c).getByRole("button", { name: "Retry Feedback Graph" }));
    expect(await within(c).findByText("Linked automatically")).toBeTruthy();
    await userEvent.type(within(c).getByLabelText("Override project key"), "nope");
    await userEvent.click(within(c).getByRole("button", { name: "Save override" }));
    expect(await screen.findByText("no such project key")).toBeTruthy();
    await waitFor(() =>
      expect((within(c).getByLabelText("Override project key") as HTMLInputElement).value).toBe(
        "nope",
      ),
    );
  });

  it("shows an unknown link source raw", async () => {
    renderWithStore(
      ui,
      mockApi({
        ...base,
        getProjectFeedbackGraph: projectFg({ link: { projectKey: "x", source: "inherited" } }),
      }),
    );
    expect(await within(await card()).findByText("inherited")).toBeTruthy();
  });
});
