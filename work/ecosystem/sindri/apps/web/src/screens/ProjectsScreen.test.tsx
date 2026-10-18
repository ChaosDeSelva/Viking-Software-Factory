import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { ProjectsScreen } from "./ProjectsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <ProjectsScreen />
  </>
);

describe("ProjectsScreen", () => {
  it("shows the empty state", async () => {
    renderWithStore(ui, mockApi({ listProjects: [] }), { projects: [], projectId: null });
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("shows a load error with retry", async () => {
    const api = mockApi({
      listProjects: () => Promise.reject(new ApiError(0, "network_error", "Cannot reach")),
    });
    renderWithStore(ui, api, { projects: [] });
    expect(await screen.findByText(/Could not load projects/)).toBeTruthy();
    api.listProjects.mockResolvedValue([PROJECT]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("/repo/demo")).toBeTruthy();
  });

  it("creates a project", async () => {
    const created = { id: "p2", name: "New", repoPath: "/repo/new" };
    const api = mockApi({ listProjects: [PROJECT], createProject: created });
    renderWithStore(ui, api);
    await screen.findByText("/repo/demo");
    await userEvent.type(screen.getByLabelText("Name"), "New");
    await userEvent.type(screen.getByLabelText("Repository path"), "/repo/new");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(api.createProject).toHaveBeenCalledWith({ name: "New", repoPath: "/repo/new" });
    expect(await screen.findByText("/repo/new")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Created project New/);
  });

  it("bootstraps and summarises the result", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      bootstrap: {
        indexed: ["README.md", "docs/a.md"],
        unchanged: [],
        removed: [],
        skipped: [{ path: ".env", reason: "secret" }],
      },
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Bootstrap Demo" }));
    const summary = await screen.findByLabelText("Bootstrap result");
    expect(summary.textContent).toMatch(/Indexed 2, unchanged 0, removed 0, skipped 1/);
    expect(within(summary).getByText(".env (secret)")).toBeTruthy();
  });

  it("searches the selected project's index", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      search: [
        {
          chunkId: 1,
          documentId: "d",
          path: "docs/guide.md",
          kind: "doc",
          text: "frobnicate",
          startLine: 3,
          endLine: 5,
          score: -1,
        },
      ],
    });
    renderWithStore(ui, api);
    await userEvent.type(screen.getByLabelText("Search the project index"), "frob");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.search).toHaveBeenCalledWith("p1", "frob");
    await waitFor(() => expect(screen.getByText(/docs\/guide.md#L3-L5/)).toBeTruthy());
  });
});
