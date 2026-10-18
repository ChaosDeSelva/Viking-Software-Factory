import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { SettingsScreen } from "./SettingsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <SettingsScreen />
  </>
);
const loaded = {
  settings: { provider: "null", model: "claude-fable-5-1", localOnly: true },
  tokenLocation: "/data/auth-token",
};

describe("SettingsScreen", () => {
  it("shows settings and the token location hint", async () => {
    renderWithStore(ui, mockApi({ getSettings: loaded }));
    expect(((await screen.findByLabelText("Model")) as HTMLInputElement).value).toBe(
      "claude-fable-5-1",
    );
    expect(screen.getByText("/data/auth-token")).toBeTruthy();
    expect((screen.getByLabelText("Offline mode") as HTMLInputElement).checked).toBe(true);
  });

  it("saves provider, model, key handle and local-only", async () => {
    const api = mockApi({ getSettings: loaded, putSettings: (s: unknown) => Promise.resolve(s) });
    renderWithStore(ui, api);
    await userEvent.selectOptions(await screen.findByLabelText("LLM provider"), "anthropic");
    await userEvent.type(screen.getByLabelText("API key secret name"), "anthropic.api-key");
    await userEvent.click(screen.getByLabelText("Offline mode"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-fable-5-1",
      localOnly: false,
      apiKeySecret: "anthropic.api-key",
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/Settings saved/);
  });

  it("shows validation errors from the server", async () => {
    const api = mockApi({
      getSettings: loaded,
      putSettings: () =>
        Promise.reject(new ApiError(422, "validation_failed", "request validation failed")),
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/validation failed/);
  });

  it("deletes project data only after typing the project name", async () => {
    const api = mockApi({
      getSettings: loaded,
      deleteProjectData: { deleted: { projectId: "p1" } },
    });
    renderWithStore(ui, api);
    const del = (await screen.findByRole("button", {
      name: "Delete project data",
    })) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    expect(del.disabled).toBe(false);
    await userEvent.click(del);
    expect(api.deleteProjectData).toHaveBeenCalledWith("p1", "Demo");
    expect((await screen.findByRole("status")).textContent).toMatch(/Deleted all data for Demo/);
  });

  it("needs unlocked approvals to erase task evidence (review I1)", async () => {
    const api = mockApi({ getSettings: loaded, hasApprovalSession: () => false });
    renderWithStore(ui, api);
    const del = (await screen.findByRole("button", {
      name: "Delete project data",
    })) as HTMLButtonElement;
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    expect(del.disabled).toBe(true);
    expect(screen.getByLabelText("Approval pairing code")).toBeTruthy();
  });

  it("erases task evidence only when the option is checked and separately confirmed", async () => {
    const api = mockApi({
      getSettings: loaded,
      deleteProjectData: { deleted: { projectId: "p1", evidenceErased: 3 } },
    });
    renderWithStore(ui, api);
    const del = (await screen.findByRole("button", {
      name: "Delete project data",
    })) as HTMLButtonElement;
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    expect(screen.queryByLabelText("Type ERASE EVIDENCE to confirm")).toBeNull();
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    // Checking the option re-gates the button behind a second confirmation.
    expect(del.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    expect(del.disabled).toBe(false);
    await userEvent.click(del);
    expect(api.deleteProjectData).toHaveBeenCalledWith("p1", "Demo", { eraseEvidence: true });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Deleted all data for Demo \(3 evidence records erased\)/,
    );
  });

  it("exports data", async () => {
    const api = mockApi({ getSettings: loaded, exportData: new Blob(["zip"]) });
    const revoked: string[] = [];
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Export data" }));
    expect(api.exportData).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(/Export downloaded/);
    // Revoking right after click() can cancel the download; it is deferred.
    expect(revoked).toEqual([]);
    await waitFor(() => expect(revoked).toEqual(["blob:x"]), { timeout: 2000 });
  });
});
