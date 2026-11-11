import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen.js";
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

  it("no longer offers deleting project data: it moved to Project settings", async () => {
    renderWithStore(ui, mockApi({ getSettings: loaded }));
    await screen.findByLabelText("Model");
    expect(screen.queryByRole("button", { name: "Delete project data" })).toBeNull();
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

const danger = (
  <>
    <NoticeRegion />
    <ProjectSettingsScreen />
  </>
);
const openDangerZone = async () =>
  userEvent.click(await screen.findByRole("tab", { name: "Danger zone" }));
/** Re-queried each time: the button is re-rendered (with or without its reason tooltip). */
const del = () => screen.findByRole<HTMLButtonElement>("button", { name: /^Delete project data/ });
/** A disabled action keeps focus and explains itself: aria-disabled, not `disabled`. */
const off = (b: HTMLButtonElement) => b.disabled || b.getAttribute("aria-disabled") === "true";

describe("Project settings: delete project data (moved from Settings)", () => {
  it("deletes project data only after typing the project name", async () => {
    const api = mockApi({
      getProfile: {},
      deleteProjectData: { deleted: { projectId: "p1" } },
    });
    renderWithStore(danger, api);
    await openDangerZone();
    await del();
    expect(off(await del())).toBe(true);
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    expect(off(await del())).toBe(false);
    await userEvent.click(await del());
    expect(api.deleteProjectData).toHaveBeenCalledWith("p1", "Demo");
    expect((await screen.findByRole("status")).textContent).toMatch(/Deleted all data for Demo/);
  });

  it("needs unlocked approvals to erase task evidence (review I1)", async () => {
    const api = mockApi({ getProfile: {}, hasApprovalSession: () => false });
    renderWithStore(danger, api);
    await openDangerZone();
    await del();
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    expect(off(await del())).toBe(true);
    expect((await del()).textContent).toContain("needs the approval pairing code");
    expect(screen.getByLabelText("Approval pairing code")).toBeTruthy();
  });

  it("erases task evidence only when the option is checked and separately confirmed", async () => {
    const api = mockApi({
      getProfile: {},
      deleteProjectData: { deleted: { projectId: "p1", evidenceErased: 3 } },
    });
    renderWithStore(danger, api);
    await openDangerZone();
    await del();
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    expect(screen.queryByLabelText("Type ERASE EVIDENCE to confirm")).toBeNull();
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    // Checking the option re-gates the button behind a second confirmation.
    expect(off(await del())).toBe(true);
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    expect(off(await del())).toBe(false);
    await userEvent.click(await del());
    expect(api.deleteProjectData).toHaveBeenCalledWith("p1", "Demo", { eraseEvidence: true });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Deleted all data for Demo \(3 evidence records erased\)/,
    );
  });
});
