import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ExplainForm, HarnessesScreen, RepositorySignals } from "./HarnessesScreen.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";

const harness = {
  name: "frontend-react",
  version: "1.1.0",
  description: "React UI work",
  taskTypes: ["frontend"],
  skills: { required: ["react-testing"], optional: ["a11y"] },
  checks: [{ id: "unit-tests", required: true }],
};
const signals = {
  packageManager: "pnpm",
  frameworks: ["react"],
  scripts: ["test"],
  hasTsconfig: true,
  testRunners: ["vitest"],
};

/** The signals themselves (the card around them carries the same name as its title). */
const repoSignals = () =>
  waitFor(() => {
    const r = document.querySelector<HTMLElement>('section[aria-label="Repository signals"]');
    if (!r) throw new Error("repository signals not shown yet");
    return r;
  });

describe("HarnessesScreen", () => {
  it("lists harnesses, marks fixtures and shows a manifest", async () => {
    const api = mockApi({
      listHarnesses: { source: "fake", harnesses: [harness] },
      repoSignals: signals,
    });
    renderWithStore(<HarnessesScreen />, api);
    expect(await screen.findByText(/Fixture harnesses/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^frontend-react@1\.1\.0/ }));
    const manifest = screen.getByRole("region", { name: "Manifest frontend-react@1.1.0" });
    expect(manifest.textContent).toMatch(/react-testing/);
    expect(manifest.textContent).toMatch(/unit-tests \(required\)/);
    // Repository signals are per project (Project settings), never read on this global page.
    expect(api.repoSignals).not.toHaveBeenCalled();
  });

  it("shows the project's repository signals on Project settings → Repository & index", async () => {
    const api = mockApi({ getProfile: {}, repoSignals: signals });
    renderWithStore(<ProjectSettingsScreen />, api);
    await userEvent.click(await screen.findByRole("tab", { name: "Repository & index" }));
    expect((await repoSignals()).textContent).toMatch(/vitest/);
    expect(api.repoSignals).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("form", { name: "Explain harness selection" })).toBeTruthy();
  });

  it("explains a selection for a described task", async () => {
    const api = mockApi({
      listHarnesses: { source: "fake", harnesses: [harness] },
      repoSignals: signals,
      explainHarness: {
        source: "fake",
        selection: { harnesses: [], skills: [], lock: { digest: "sha256:x" }, rationale: [] },
        explanation: ["harness frontend-react: selected (task types frontend match)"],
      },
    });
    renderWithStore(<ExplainForm projectId="p1" />, api);
    await userEvent.type(await screen.findByLabelText("Task title"), "CSV button");
    await userEvent.type(screen.getByLabelText("Task description"), "Add a button");
    await userEvent.type(screen.getByLabelText("Task types (comma separated)"), "frontend, ui");
    await userEvent.click(screen.getByRole("button", { name: "Explain selection" }));
    expect(api.explainHarness).toHaveBeenCalledWith({
      projectId: "p1",
      task: {
        id: "explain",
        title: "CSV button",
        description: "Add a button",
        taskTypes: ["frontend", "ui"],
      },
    });
    expect((await screen.findByRole("list", { name: "Explanation" })).textContent).toMatch(
      /frontend-react: selected/,
    );
  });

  it("shows the Brokkr-unavailable error state", async () => {
    const api = mockApi({
      listHarnesses: () => Promise.reject(new Error("Brokkr is enabled but its SDK is not wired")),
      repoSignals: signals,
    });
    renderWithStore(<HarnessesScreen />, api);
    expect(await screen.findByText(/Could not load harnesses: Brokkr is enabled/)).toBeTruthy();
  });

  it("names Brokkr as the source and shows a sparse manifest", async () => {
    const bare = {
      name: "plain",
      version: "0.1.0",
      description: "Nothing declared",
      taskTypes: [],
      skills: { required: [], optional: [] },
      checks: [{ id: "lint", required: false }],
    };
    const api = mockApi({
      listHarnesses: { source: "brokkr", harnesses: [bare] },
      repoSignals: {
        ...signals,
        packageManager: null,
        frameworks: [],
        scripts: [],
        testRunners: [],
      },
    });
    renderWithStore(<HarnessesScreen />, api);
    expect(await screen.findByText(/Harnesses resolved by Brokkr/)).toBeTruthy();
    expect(screen.queryByText(/Fixture harnesses/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^plain@0\.1\.0/ }));
    const manifest = screen.getByRole("region", { name: "Manifest plain@0.1.0" });
    expect(manifest.textContent).toContain("Task types: none");
    expect(manifest.textContent).toContain("Required skills: none");
    expect(manifest.textContent).toContain("Optional skills: none");
    expect(manifest.textContent).toContain("lint (optional)");
    renderWithStore(<RepositorySignals projectId="p1" />, api);
    expect((await repoSignals()).textContent).toBe(
      "Package managerunknownFrameworksnoneTest runnersnoneScriptsnone",
    );
  });

  it("lists no harnesses, and explains without a project or task types", async () => {
    const api = mockApi({
      listHarnesses: { source: "fake", harnesses: [] },
      explainHarness: {
        source: "fake",
        selection: { harnesses: [], skills: [], lock: { digest: "sha256:x" }, rationale: [] },
        explanation: ["no harness matched"],
      },
    });
    renderWithStore(<HarnessesScreen />, api, { projectId: null });
    expect(await screen.findByText("No harnesses installed.")).toBeTruthy();
    // Without a project, Project settings asks for one instead of reading a repository.
    renderWithStore(<ProjectSettingsScreen />, api, { projectId: null });
    expect(await screen.findByText("No project selected")).toBeTruthy();
    expect(api.repoSignals).not.toHaveBeenCalled();
    renderWithStore(<ExplainForm projectId={null} />, api, { projectId: null });
    await userEvent.type(screen.getByLabelText("Task title"), "T");
    await userEvent.type(screen.getByLabelText("Task description"), "D");
    await userEvent.type(screen.getByLabelText("Task types (comma separated)"), " , ");
    await userEvent.click(screen.getByRole("button", { name: "Explain selection" }));
    expect(api.explainHarness).toHaveBeenCalledWith({
      task: { id: "explain", title: "T", description: "D" },
    });
    expect((await screen.findByRole("list", { name: "Explanation" })).textContent).toBe(
      "no harness matched",
    );
  });
});
