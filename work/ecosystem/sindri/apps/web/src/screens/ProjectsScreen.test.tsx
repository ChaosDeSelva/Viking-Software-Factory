import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";
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
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("Create one with the path to a local repository.")).toBeTruthy();
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
    // The new project's profile card can still be loading (a second status) under load.
    expect(
      screen.getAllByRole("status").some((s) => /Created project New/.test(s.textContent)),
    ).toBe(true);
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

  // The index search lives on Project settings → Repository & index.
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
    renderWithStore(<ProjectSettingsScreen />, api);
    await userEvent.click(screen.getByRole("tab", { name: "Repository & index" }));
    await userEvent.type(screen.getByLabelText("Search the project index"), "frob");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.search).toHaveBeenCalledWith("p1", "frob");
    await waitFor(() => expect(screen.getByText(/docs\/guide.md#L3-L5/)).toBeTruthy());
  });

  it("reports dropped secrets and unsafe git config from a bootstrap (L5)", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      bootstrap: {
        indexed: ["README.md"],
        unchanged: [],
        removed: [],
        skipped: [],
        secretsDropped: [
          { path: "docs/a.md", startLine: 1, endLine: 2 },
          { path: "docs/b.md", startLine: 4, endLine: 9 },
        ],
        unsafeGitConfig: ["core.fsmonitor", "core.sshCommand"],
      },
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Bootstrap Demo" }));
    const summary = await screen.findByLabelText("Bootstrap result");
    expect(summary.textContent).toMatch(/2 passages that\s+looked like secrets were left out/);
    expect(within(summary).getByText("core.fsmonitor, core.sshCommand")).toBeTruthy();
  });

  it("filters by name or path, offers to clear a filter that matches nothing", async () => {
    const two = { id: "p2", name: "Billing", repoPath: "/repo/acme-billing" };
    const api = mockApi({ listProjects: [PROJECT, two] });
    renderWithStore(ui, api, { projects: [PROJECT, two] });
    await screen.findByText("/repo/acme-billing");
    const filter = screen.getByRole("searchbox", { name: "Filter projects" });
    await userEvent.type(filter, "ACME");
    expect(screen.getByText("/repo/acme-billing")).toBeTruthy();
    expect(screen.queryByText("/repo/demo")).toBeNull();
    await userEvent.clear(filter);
    await userEvent.type(filter, "zzz");
    expect(screen.getByText("No project matches “zzz”")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
    expect(screen.getByText("/repo/demo")).toBeTruthy();
    expect(screen.getByText("/repo/acme-billing")).toBeTruthy();
  });

  it("pages 15 projects at a time, the selected one first, and a filter goes back to page 1", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i + 1}`,
      name: `Project ${String(i + 1).padStart(2, "0")}`,
      repoPath: `/repo/p${i + 1}`,
    }));
    const api = mockApi({ listProjects: many });
    renderWithStore(ui, api, { projects: many, projectId: "p20" });
    const table = await screen.findByRole("table", { name: "Projects" });
    const names = () =>
      within(table)
        .getAllByText(/^\/repo\/p\d+$/)
        .map((e) => e.textContent);
    expect(names()).toHaveLength(15);
    expect(names()[0]).toBe("/repo/p20");
    const pages = screen.getByRole("navigation", { name: "Pagination" });
    await userEvent.click(within(pages).getByRole("button", { name: "Next" }));
    expect(names()).toEqual(["/repo/p15", "/repo/p16", "/repo/p17", "/repo/p18", "/repo/p19"]);
    expect(within(pages).getByRole("button", { name: "Page 2" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter projects" }), "Project 1");
    // Projects 10..19 fit on one page (still on page 2 would show nothing), so the pager goes.
    expect(names()).toHaveLength(10);
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });
});
