import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ExecutionProfile } from "../api/types.js";
import { NoticeRegion } from "../components/Layout.js";
import { intake } from "../test/fixtures.js";
import { mockApi, PROJECT, renderWithStore } from "../test/utils.js";
import { InboxScreen } from "./InboxScreen.js";
import { KnowledgeScreen } from "./KnowledgeScreen.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";
import { ProjectsScreen } from "./ProjectsScreen.js";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const TWO = { id: "p2", name: "Two", repoPath: "/repo/two" };

describe("defects found in the second sweep", { timeout: 20_000 }, () => {
  it("does not show search results that arrive after switching to another project", async () => {
    const pending = deferred<unknown[]>();
    const api = mockApi({
      listProjects: [PROJECT, TWO],
      getProfile: {},
      search: () => pending.promise,
    });
    renderWithStore(
      <>
        <NoticeRegion />
        <ProjectsScreen />
        <ProjectSettingsScreen />
      </>,
      api,
      { projects: [PROJECT, TWO] },
    );
    await userEvent.click(screen.getByRole("tab", { name: "Repository & index" }));
    await userEvent.type(screen.getByLabelText("Search the project index"), "one");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.search).toHaveBeenCalledWith("p1", "one");
    await userEvent.click(await screen.findByRole("button", { name: "Select Two" }));
    await act(async () => {
      pending.resolve([
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
      ]);
      await pending.promise;
    });
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.queryByText("only in project one")).toBeNull();
    // The search box is usable again for the new project.
    expect(screen.getByRole("button", { name: "Search" })).toHaveProperty("disabled", false);
  });

  it("does not add a knowledge entry with confidence 0 when the confidence field is cleared", async () => {
    const api = mockApi({ listKnowledge: [], listDeliveries: [] });
    renderWithStore(
      <>
        <NoticeRegion />
        <KnowledgeScreen />
      </>,
      api,
    );
    await userEvent.type(screen.getByLabelText("Claim"), "CSV uses papaparse");
    await userEvent.type(screen.getByLabelText("Source URL"), "https://example.com/doc");
    await userEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(screen.getByRole("button", { name: "Add entry" }).hasAttribute("aria-disabled")).toBe(
      false,
    );
    await userEvent.clear(screen.getByLabelText("Confidence (0 to 1)"));
    const add = screen.getByRole("button", { name: /^Add entry/ });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(add);
    expect(api.addKnowledge).not.toHaveBeenCalled();
  });

  it("refuses two environment variables with the same name instead of dropping one", async () => {
    const api = mockApi({
      listProjects: [PROJECT],
      getProfile: { env: { GOCACHE: "/cache/a" } },
      putProfile: (_id: string, profile: ExecutionProfile) =>
        Promise.resolve({ profile, harness: null }),
    });
    renderWithStore(
      <>
        <NoticeRegion />
        <ProjectSettingsScreen />
      </>,
      api,
    );
    const f = await screen.findByRole("form", { name: "Execution profile" });
    await userEvent.click(within(f).getByRole("button", { name: "Add variable" }));
    fireEvent.change(within(f).getByLabelText("Variable 2 name"), {
      target: { value: " GOCACHE " },
    });
    fireEvent.change(within(f).getByLabelText("Variable 2 value"), {
      target: { value: "/cache/b" },
    });
    await userEvent.click(within(f).getByRole("button", { name: "Save profile" }));
    expect(api.putProfile).not.toHaveBeenCalled();
    expect(within(f).getByText("GOCACHE is set twice.")).toBeTruthy();
    expect(within(f).getByLabelText("Variable 2 name").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the inbox item clicked last even when an earlier one answers later", async () => {
    const a = intake({ id: "ia", display: { title: "Item A", body: "body of A" } });
    const b = intake({ id: "ib", display: { title: "Item B", body: "body of B" } });
    const slowA = deferred<unknown>();
    const api = mockApi({
      listIntakes: [a, b],
      getIntake: (id: string) =>
        id === "ia" ? slowA.promise : Promise.resolve({ intake: b, comments: [] }),
    });
    renderWithStore(<InboxScreen />, api);
    await userEvent.click(await screen.findByRole("button", { name: /Item A/ }));
    await userEvent.click(screen.getByRole("button", { name: /Item B/ }));
    expect(await screen.findByText("body of B")).toBeTruthy();
    await act(async () => {
      slowA.resolve({ intake: a, comments: [] });
      await slowA.promise;
    });
    const detail = screen.getByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText("body of B")).toBeTruthy();
    expect(within(detail).queryByText("body of A")).toBeNull();
    expect(screen.getByRole("button", { name: /Item B/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
