import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { entry } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { KnowledgeScreen } from "./KnowledgeScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <KnowledgeScreen />
  </>
);

describe("KnowledgeScreen", () => {
  it("lists valid entries with sources and filters", async () => {
    const api = mockApi({ listKnowledge: [entry()] });
    renderWithStore(ui, api);
    expect(await screen.findByText("CSV uses papaparse", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("README.md#L1-L3")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Search knowledge"), "csv");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.listKnowledge).toHaveBeenLastCalledWith("p1", "csv");
  });

  it("shows the empty state", async () => {
    renderWithStore(ui, mockApi({ listKnowledge: [] }));
    expect(await screen.findByText(/No knowledge entries yet/)).toBeTruthy();
  });

  it("adds an entry citing an indexed passage", async () => {
    const api = mockApi({
      listKnowledge: [],
      search: [
        {
          chunkId: 7,
          documentId: "d1",
          path: "README.md",
          kind: "readme",
          text: "x",
          startLine: 1,
          endLine: 3,
          score: 0,
        },
      ],
      addKnowledge: entry(),
    });
    renderWithStore(ui, api);
    await userEvent.type(screen.getByLabelText("Claim"), "CSV uses papaparse");
    const add = screen.getByRole("button", { name: "Add entry" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Cite from the project index"), "papaparse");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Cite README.md lines 1 to 3" }),
    );
    await userEvent.click(add);
    expect(api.addKnowledge).toHaveBeenCalledWith("p1", {
      claim: "CSV uses papaparse",
      sourceRefs: [{ documentId: "d1", startLine: 1, endLine: 3 }],
      confidence: 0.8,
    });
  });

  it("retracts with a reason, supersedes and shows history", async () => {
    const e = entry();
    const api = mockApi({
      listKnowledge: [e],
      retractKnowledge: { ...e, validity: "retracted" },
      supersedeKnowledge: entry({ id: "k2", claim: "CSV uses papaparse 5" }),
      knowledgeHistory: [
        { ...e, validity: "superseded" },
        entry({ id: "k2", claim: "CSV uses papaparse 5" }),
      ],
    });
    renderWithStore(ui, api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retract CSV uses papaparse" }),
    );
    await userEvent.type(screen.getByLabelText("Reason for retraction"), "outdated");
    await userEvent.click(screen.getByRole("button", { name: "Confirm retraction" }));
    expect(api.retractKnowledge).toHaveBeenCalledWith("k1", "outdated");

    await userEvent.click(
      await screen.findByRole("button", { name: "Supersede CSV uses papaparse" }),
    );
    const field = screen.getByLabelText(/Corrected claim/);
    await userEvent.clear(field);
    await userEvent.type(field, "CSV uses papaparse 5");
    await userEvent.click(screen.getByRole("button", { name: "Save new version" }));
    expect(api.supersedeKnowledge).toHaveBeenCalledWith("k1", {
      claim: "CSV uses papaparse 5",
      sourceRefs: e.sourceRefs,
      confidence: 0.9,
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "History CSV uses papaparse" }),
    );
    const hist = await screen.findByRole("list", { name: "History" });
    expect(within(hist).getByText("superseded")).toBeTruthy();
  });
});
