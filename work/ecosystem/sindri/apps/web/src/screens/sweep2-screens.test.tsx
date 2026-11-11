import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import type { ExecutionProfile } from "../api/types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { intake, meta, spec } from "../test/fixtures.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { DirectorScreen } from "./DirectorScreen.js";
import { InboxScreen } from "./InboxScreen.js";
import { ProjectsScreen } from "./ProjectsScreen.js";

const withNotices = (screenUi: ReactElement) => (
  <>
    <NoticeRegion />
    {screenUi}
  </>
);
const TWO = { id: "p2", name: "Two", repoPath: "/repo/two" };
function Where() {
  const { state } = useStore();
  return <output data-testid="where">{`${state.view}:${state.specId ?? ""}`}</output>;
}

describe("InboxScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("imports a ticket by URL and reloads the list", async () => {
    const imported = intake({
      id: "i9",
      source: "linear",
      externalId: "ENG-9",
      externalUrl: "https://linear.app/acme/issue/ENG-9",
      display: { title: "ENG-9 export", body: "" },
    });
    const api = mockApi({ listIntakes: [], importIntake: imported });
    renderWithStore(withNotices(<InboxScreen />), api);
    await screen.findByText("The inbox is empty.");
    api.listIntakes.mockResolvedValue([imported]);
    await userEvent.type(
      screen.getByLabelText("Jira or Linear URL"),
      " https://linear.app/acme/issue/ENG-9 ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(api.importIntake).toHaveBeenCalledWith({
      projectId: "p1",
      url: "https://linear.app/acme/issue/ENG-9",
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/Imported "ENG-9 export"/);
    expect((screen.getByLabelText("Jira or Linear URL") as HTMLInputElement).value).toBe("");
    expect(await screen.findByRole("button", { name: /ENG-9 export/ })).toBeTruthy();
    expect(screen.getByText("Linear")).toBeTruthy();
  });

  it("shows sync state, the external link, comments and an empty description", async () => {
    const rec = intake({
      source: "jira",
      syncState: "stale",
      externalId: "PROJ-1",
      externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
      display: { title: "PROJ-1 bug", body: "" },
    });
    const api = mockApi({
      listIntakes: [rec],
      getIntake: {
        intake: rec,
        comments: [
          {
            id: "c1",
            author: "raw",
            body: "raw",
            createdAt: "2026-01-01T00:00:00Z",
            origin: "remote",
            display: { author: "Ann", body: "Seen on Safari too" },
          },
        ],
      },
    });
    renderWithStore(<InboxScreen />, api);
    const item = await screen.findByRole("button", { name: /PROJ-1 bug/ });
    expect(within(item).getByText("stale")).toBeTruthy();
    await userEvent.click(item);
    const detail = await screen.findByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText(/PROJ-1 ·/).textContent).toBe(
      "PROJ-1 · https://acme.atlassian.net/browse/PROJ-1",
    );
    expect(within(detail).getByText("(no description)")).toBeTruthy();
    expect(within(detail).getByRole("heading", { name: "Comments" })).toBeTruthy();
    expect(within(detail).getByText(/Seen on Safari too/).textContent).toBe(
      "Ann remote: Seen on Safari too",
    );
  });
});

describe("ProjectsScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("reports a failed create, bootstrap and search without losing input", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: {},
      createProject: () => Promise.reject(new Error("not a directory")),
      bootstrap: () => Promise.reject(new Error("index locked")),
      search: () => Promise.reject(new Error("search failed")),
    });
    renderWithStore(withNotices(<ProjectsScreen />), api);
    await screen.findByText("/repo/demo");
    await userEvent.type(screen.getByLabelText("Name"), "New");
    await userEvent.type(screen.getByLabelText("Repository path"), "/nope");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a directory/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("New");

    await userEvent.click(screen.getByRole("button", { name: "Bootstrap Demo" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/index locked/));
    expect(screen.getByRole("button", { name: "Bootstrap Demo" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByLabelText("Bootstrap result")).toBeNull();

    await userEvent.type(screen.getByLabelText("Search the project index"), "frob");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/search failed/));
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("selects another project and says when a search finds nothing", async () => {
    const api = mockApi({ listProjects: [PROJECT, TWO], getProfile: {}, search: [] });
    renderWithStore(withNotices(<ProjectsScreen />), api, { projects: [PROJECT, TWO] });
    await userEvent.click(await screen.findByRole("button", { name: "Select Two" }));
    expect(screen.queryByRole("button", { name: "Select Two" })).toBeNull();
    expect(screen.getByRole("button", { name: "Select Demo" })).toBeTruthy();
    await waitFor(() => expect(api.getProfile).toHaveBeenLastCalledWith("p2"));
    await userEvent.type(screen.getByLabelText("Search the project index"), "nothing");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.search).toHaveBeenCalledWith("p2", "nothing");
    expect(
      await screen.findByText("No matches. Bootstrap the project first if you have not."),
    ).toBeTruthy();
  });

  it("explains a load failure that is not an Error, and asks for a project to search", async () => {
    const api = mockApi({ listProjects: () => Promise.reject("offline") });
    renderWithStore(withNotices(<ProjectsScreen />), api, { projects: [], projectId: null });
    expect(await screen.findByText("Could not load projects: offline")).toBeTruthy();
    expect(screen.getByText("Select a project to search its index.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Execution profile" })).toBeNull();
  });

  it("words a single dropped secret in the singular", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: {},
      bootstrap: {
        indexed: [],
        unchanged: ["README.md"],
        removed: [],
        skipped: [],
        secretsDropped: [{ path: "docs/a.md", startLine: 1, endLine: 2 }],
        unsafeGitConfig: [],
      },
    });
    renderWithStore(withNotices(<ProjectsScreen />), api);
    await userEvent.click(await screen.findByRole("button", { name: "Bootstrap Demo" }));
    const summary = await screen.findByLabelText("Bootstrap result");
    expect(summary.textContent).toMatch(/1 passage that\s+looked like secrets was left out/);
    expect(summary.textContent).not.toMatch(/git config/);
    expect(within(summary).queryByText("Skipped files")).toBeNull();
  });
});

describe("DirectorScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("asks for a project when none is selected", () => {
    const api = mockApi();
    renderWithStore(<DirectorScreen />, api, { projectId: null });
    expect(screen.getByText("Create or select a project first.")).toBeTruthy();
    expect(api.listIntakes).not.toHaveBeenCalled();
  });

  it("opens the drafted spec in Specs", async () => {
    const api = mockApi({
      listIntakes: [],
      draft: {
        spec: spec(),
        meta: meta(),
        context: [],
        analysis: { impactedSystems: [], testCommands: [] },
      },
    });
    renderWithStore(
      <>
        <DirectorScreen />
        <Where />
      </>,
      api,
    );
    await userEvent.type(screen.getByLabelText("Request"), "  Add CSV export  ");
    await userEvent.click(screen.getByRole("button", { name: "Draft spec" }));
    // No inbox item chosen: none is sent.
    expect(api.draft).toHaveBeenCalledWith({ projectId: "p1", request: "Add CSV export" });
    await userEvent.click(await screen.findByRole("button", { name: "Open in Specs" }));
    expect(screen.getByTestId("where").textContent).toBe("specs:s1");
  });
});

describe("Execution profile editor (sweep 2)", { timeout: 20_000 }, () => {
  const ui = withNotices(<ProjectsScreen />);
  const form = () => screen.findByRole("form", { name: "Execution profile" });
  const type = (el: HTMLElement, text: string) => fireEvent.change(el, { target: { value: text } });
  const refuse = (details: unknown) =>
    Promise.reject(new ApiError(422, "validation_failed", "request validation failed", details));

  it("lists only the server issues it can read", async () => {
    const api = mockApi({ listProjects: [PROJECT], getProfile: {} });
    api.putProfile.mockImplementationOnce(() =>
      refuse([
        null,
        "a string",
        { path: ["checks", 0, "id"], message: "bad id" },
        { path: "checks", message: "path is not a list" },
        { path: ["x"], message: 42 },
      ]),
    );
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    const refused = await within(f).findByRole("alert", {
      name: "The server did not accept the profile",
    });
    expect(
      within(refused)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["checks.0.id: bad id", "path is not a list"]);
  });

  it("shows no issue list for a 422 without details or for another error", async () => {
    const api = mockApi({ listProjects: [PROJECT], getProfile: {} });
    api.putProfile
      .mockImplementationOnce(() => refuse({ not: "a list" }))
      .mockImplementationOnce(() => Promise.reject(new ApiError(500, "internal", "boom")));
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/request validation failed/);
    expect(within(f).queryByRole("alert", { name: "The server did not accept the profile" })).toBe(
      null,
    );
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.putProfile).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(within(f).queryByRole("alert", { name: "The server did not accept the profile" })).toBe(
      null,
    );
  });

  it("marks each kind of mistake on its field and counts one in the singular", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: {
        checks: [{ id: "lint", command: ["make", "lint"] }],
        env: { A: "1", B: "2" },
      } satisfies ExecutionProfile,
    });
    renderWithStore(ui, api);
    const f = await form();
    const check = within(f).getByRole("group", { name: /Check 1/ });
    // Editing one variable leaves the other as it was.
    type(within(f).getByLabelText("Variable 2 name"), "");
    expect((within(f).getByLabelText("Variable 1 name") as HTMLInputElement).value).toBe("A");
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect(within(f).getByRole("alert").textContent).toBe("Fix the marked field before saving.");
    expect(within(f).getByText("Give the variable a name.")).toBeTruthy();
    expect(within(f).getByLabelText("Variable 2 name").getAttribute("aria-invalid")).toBe("true");
    type(within(f).getByLabelText("Variable 2 name"), "B");

    type(within(check).getByLabelText("Command"), `make "lint`);
    type(within(check).getByLabelText("Working directory"), "/abs");
    type(within(check).getByLabelText("Timeout (seconds)"), "1.5");
    type(within(f).getByLabelText("Writable directories"), "cache");
    type(within(f).getByLabelText("Verification timeout (minutes)"), "0");
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect(within(f).getByRole("alert").textContent).toBe("Fix the marked fields before saving.");
    const invalid = (label: string, scope: HTMLElement = f) =>
      within(scope).getByLabelText(label).getAttribute("aria-invalid");
    expect(within(check).getByText("A quote is not closed.")).toBeTruthy();
    expect(invalid("Command", check)).toBe("true");
    expect(invalid("Working directory", check)).toBe("true");
    expect(invalid("Timeout (seconds)", check)).toBe("true");
    expect(within(check).getByText("Enter a whole number of seconds.")).toBeTruthy();
    expect(invalid("Writable directories")).toBe("true");
    expect(invalid("Verification timeout (minutes)")).toBe("true");
    expect(api.putProfile).not.toHaveBeenCalled();
  });

  it("can set the check network back to deny", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: { network: "allow" },
      putProfile: (_id: string, profile: ExecutionProfile) =>
        Promise.resolve({ profile, harness: null }),
    });
    renderWithStore(ui, api);
    const f = await form();
    await userEvent.selectOptions(within(f).getByLabelText("Network for checks"), "deny");
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    // The saved profile stated a network, so the default is stated again.
    expect(api.putProfile).toHaveBeenCalledWith("p1", { network: "deny" });
  });
});
