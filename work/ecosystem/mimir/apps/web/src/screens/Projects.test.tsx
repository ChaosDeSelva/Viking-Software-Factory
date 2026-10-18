import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { project, snapshot } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Projects } from "./Projects.js";

describe("Projects", () => {
  it("lists projects", async () => {
    const p = project({ name: "alpha", repoPath: "/repos/alpha" });
    const { container } = renderWithStore(<Projects />, {
      client: mockClient({ snapshot: vi.fn(async () => snapshot({ projects: [p] })) }),
    });
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("/repos/alpha")).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("shows an empty state", async () => {
    renderWithStore(<Projects />, { client: mockClient() });
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("creates a project with test command and protected branches, then refreshes", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    vi.mocked(client.projects.create).mockResolvedValue({ project: project({ name: "beta" }) });
    renderWithStore(<Projects />, { client });
    await screen.findByText(/No projects yet/);
    await user.type(screen.getByLabelText("Name"), "beta");
    await user.type(screen.getByLabelText("Repository path"), "/repos/beta");
    await user.type(screen.getByLabelText("Test command"), "pnpm test");
    await user.type(screen.getByLabelText(/Protected branches/), "main, release");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(client.projects.create).toHaveBeenCalledWith({
      name: "beta",
      repoPath: "/repos/beta",
      // the server takes the test command as argv (no shell): split on whitespace
      settings: { testCommand: ["pnpm", "test"], protectedBranches: ["main", "release"] },
    });
    expect(await screen.findByText(/Created project beta/)).toBeTruthy();
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
  });

  it("shows the server error code when creation fails", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    vi.mocked(client.projects.create).mockRejectedValue(
      Object.assign(new Error("repoPath is not a git repository"), {
        name: "MimirError",
        code: "validation_failed",
      }),
    );
    renderWithStore(<Projects />, { client });
    await screen.findByText(/No projects yet/);
    await user.type(screen.getByLabelText("Name"), "x");
    await user.type(screen.getByLabelText("Repository path"), "/nope");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/validation_failed/);
    expect(alert.textContent).toMatch(/not a git repository/);
  });
});
