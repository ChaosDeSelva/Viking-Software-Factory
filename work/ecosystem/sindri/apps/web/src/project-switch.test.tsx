import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { App } from "./App.js";
import { APP_URLS } from "./config.js";
import { pickProject, projectPicker } from "./test/shell.js";
import { mockApi } from "./test/utils.js";

const P1 = { id: "p1", name: "One", repoPath: "/repo/one" };
const P2 = { id: "p2", name: "Two", repoPath: "/repo/two" };
const start = (view: string) => ({
  token: "t",
  view: view as "projects",
  projects: [P1, P2],
  projectId: "p1",
});
const app = (api: ReturnType<typeof mockApi>, view: string) =>
  render(<App api={api as unknown as ApiClient} initial={start(view)} />);

afterEach(() => sessionStorage.clear());

/** Project settings tabs (the screen remounts per project, back on its first tab). */
const openTab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("app switcher", () => {
  it("carries the project only to Heimdall, which resolves Sindri ids", async () => {
    app(mockApi({ listProjects: [P1, P2] }), "projects");
    await userEvent.click(await screen.findByRole("button", { name: /Switch app/ }));
    const menu = await screen.findByRole("menu");
    const href = (name: RegExp) =>
      within(menu).getByRole("menuitem", { name }).getAttribute("href");
    // Mimir ids differ from Sindri's; a Sindri id would reset Mimir's own project choice.
    expect(href(/Mimir/)).toBe(APP_URLS.mimir);
    expect(href(/Sindri/)).toBe(APP_URLS.sindri);
    expect(href(/Heimdall/)).toBe(`${APP_URLS.heimdall}/?project=p1`);
  });
});

describe("switching the project", () => {
  it("drops the previous project's search results on Project settings", async () => {
    const api = mockApi({
      listProjects: [P1, P2],
      getProfile: {},
      search: [
        {
          chunkId: 1,
          documentId: "d",
          path: "docs/one.md",
          kind: "doc",
          text: "only in project one",
          startLine: 1,
          endLine: 2,
          score: 1,
        },
      ],
    });
    app(api, "project-settings");
    await openTab("Repository & index");
    await userEvent.type(await screen.findByLabelText("Search the project index"), "one");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("list", { name: "Search results" })).toBeTruthy();
    await pickProject("Two");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Search results" })).toBeNull());
    await openTab("Repository & index");
    expect(await screen.findByLabelText("Search the project index")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.queryByText("only in project one")).toBeNull();
  });

  it("does not carry an evidence-erasure confirmation over to another project's Danger zone", async () => {
    const api = mockApi({
      listProjects: [P1, P2],
      getSettings: {
        settings: { provider: "null", model: "m", localOnly: true },
        tokenLocation: null,
      },
      deleteProjectData: { deleted: { projectId: "p2" } },
    });
    app(api, "project-settings");
    await openTab("Danger zone");
    await userEvent.type(await screen.findByLabelText('Type "One" to confirm'), "One");
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    await pickProject("Two");
    await openTab("Danger zone");
    const confirm = (await screen.findByLabelText('Type "Two" to confirm')) as HTMLInputElement;
    expect(confirm.value).toBe("");
    expect(
      (screen.getByLabelText(/Also erase immutable task evidence/) as HTMLInputElement).checked,
    ).toBe(false);
    await userEvent.type(confirm, "Two");
    await userEvent.click(screen.getByRole("button", { name: "Delete project data" }));
    expect(api.deleteProjectData).toHaveBeenCalledWith("p2", "Two");
  });

  it("drops the previous project's harness explanation on Project settings", async () => {
    const api = mockApi({
      listProjects: [P1, P2],
      listHarnesses: { source: "fake", harnesses: [] },
      repoSignals: {
        packageManager: null,
        frameworks: [],
        scripts: [],
        hasTsconfig: false,
        testRunners: [],
      },
      explainHarness: {
        source: "fake",
        selection: { harnesses: [], skills: [], lock: { digest: "sha256:x" }, rationale: [] },
        explanation: ["chosen from project one's repository"],
      },
    });
    app(api, "project-settings");
    await openTab("Repository & index");
    await userEvent.type(await screen.findByLabelText("Task title"), "CSV");
    await userEvent.type(screen.getByLabelText("Task description"), "Add it");
    await userEvent.click(screen.getByRole("button", { name: "Explain selection" }));
    expect(await screen.findByRole("list", { name: "Explanation" })).toBeTruthy();
    await pickProject("Two");
    await openTab("Repository & index");
    await waitFor(() => expect(api.repoSignals).toHaveBeenCalledWith("p2"));
    expect(screen.queryByRole("list", { name: "Explanation" })).toBeNull();
  });

  it("keeps the selected project when the URL hash names a view but no project", async () => {
    window.history.replaceState(null, "", "/#/specs?project=p1");
    const api = mockApi({ listProjects: [P1], listSpecs: [], listPlans: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    expect(await screen.findByText(/No specs yet/)).toBeTruthy();
    act(() => {
      window.history.replaceState(null, "", "/#/plans");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByText(/No plans yet/)).toBeTruthy();
    expect(projectPicker().getAttribute("aria-label")).toBe("Project: One");
    expect(screen.queryByText("Create or select a project first.")).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe("#/plans?project=p1"));
  });
});

describe("a request that answers after the project changed", () => {
  it("does not show an explanation asked for the previous project", async () => {
    let answer: (r: unknown) => void = () => undefined;
    const api = mockApi({
      listProjects: [P1, P2],
      listHarnesses: { source: "fake", harnesses: [] },
      repoSignals: {
        packageManager: null,
        frameworks: [],
        scripts: [],
        hasTsconfig: false,
        testRunners: [],
      },
      explainHarness: () => new Promise((r) => (answer = r)),
    });
    app(api, "project-settings");
    await openTab("Repository & index");
    await userEvent.type(await screen.findByLabelText("Task title"), "CSV");
    await userEvent.type(screen.getByLabelText("Task description"), "Add it");
    await userEvent.click(screen.getByRole("button", { name: "Explain selection" }));
    expect(api.explainHarness).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }));
    await pickProject("Two");
    await openTab("Repository & index");
    await waitFor(() => expect(api.repoSignals).toHaveBeenCalledWith("p2"));
    await act(async () =>
      answer({
        source: "fake",
        selection: { harnesses: [], skills: [], lock: { digest: "sha256:x" }, rationale: [] },
        explanation: ["chosen from project one's repository"],
      }),
    );
    expect(screen.queryByRole("list", { name: "Explanation" })).toBeNull();
    expect(screen.queryByText("chosen from project one's repository")).toBeNull();
    // The form works again for the new project.
    expect(screen.getByRole("button", { name: "Explain selection" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
