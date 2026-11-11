import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MimirStatus } from "../api/delivery-types.js";
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
  settings: {
    provider: "anthropic",
    model: "claude-fable-5-1",
    localOnly: false,
    apiKeySecret: "anthropic.api-key",
    mimirUrl: "http://127.0.0.1:7700",
    mimirTokenSecret: "mimir.token",
  },
  tokenLocation: null,
};
const status = (over: Partial<MimirStatus>): MimirStatus => ({
  configured: true,
  url: "http://127.0.0.1:7700",
  tokenSecret: "mimir.token",
  blocked: null,
  reachable: false,
  serverVersion: null,
  error: null,
  ...over,
});

describe("SettingsScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("switches to a CLI provider with its default model and picks the agents", async () => {
    const api = mockApi({ getSettings: loaded, putSettings: (s: unknown) => Promise.resolve(s) });
    renderWithStore(ui, api);
    // The default token location is named when the server keeps none.
    expect(await screen.findByText("~/.sindri/auth-token")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("LLM provider"), "codex-cli");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("default");
    expect(screen.getByText(/Uses your installed CLI login/)).toBeTruthy();
    expect(screen.queryByText(/will leave this machine/)).toBeNull();
    expect((screen.getByLabelText("Implementation agent") as HTMLSelectElement).value).toBe(
      "claude",
    );
    await userEvent.selectOptions(screen.getByLabelText("Implementation agent"), "codex");
    await userEvent.selectOptions(screen.getByLabelText("Review and QA agent"), "gemini");
    await userEvent.clear(screen.getByLabelText("Model"));
    await userEvent.type(screen.getByLabelText("Model"), "gpt-x");
    // Emptied optional fields are left out rather than saved as "".
    await userEvent.clear(screen.getByLabelText("Mimir URL (optional)"));
    await userEvent.clear(screen.getByLabelText("Mimir token secret name"));
    await userEvent.clear(screen.getByLabelText("API key secret name"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith({
      provider: "codex-cli",
      model: "gpt-x",
      localOnly: false,
      workerAgent: "codex",
      reviewerAgent: "gemini",
    });
  });

  it("keeps the model when switching to a provider that is not a CLI", async () => {
    renderWithStore(ui, mockApi({ getSettings: loaded }));
    await userEvent.selectOptions(await screen.findByLabelText("LLM provider"), "fake");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("claude-fable-5-1");
  });

  it("unlocks approvals for erasing evidence from the Settings screen", async () => {
    let unlocked = false;
    const api = mockApi({
      getSettings: loaded,
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "local:me/web#aps_1", expiresAt: "x" });
      },
    });
    renderWithStore(ui, api);
    const del = await screen.findByRole("button", { name: "Delete project data" });
    await userEvent.type(screen.getByLabelText('Type "Demo" to confirm'), "Demo");
    await userEvent.click(screen.getByLabelText(/Also erase immutable task evidence/));
    await userEvent.type(screen.getByLabelText("Type ERASE EVIDENCE to confirm"), "ERASE EVIDENCE");
    expect(del).toHaveProperty("disabled", true);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(api.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    expect(await screen.findByRole("button", { name: "Delete project data" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByLabelText("Approval pairing code")).toBeNull();
  });

  it("explains each Mimir connection state", async () => {
    const api = mockApi({ getSettings: loaded });
    renderWithStore(ui, api);
    const test = await screen.findByRole("button", { name: "Test Mimir connection" });
    const says = async (s: MimirStatus, text: string) => {
      api.mimirStatus.mockResolvedValueOnce(s);
      await userEvent.click(test);
      await waitFor(() => expect(screen.getByLabelText("Mimir connection").textContent).toBe(text));
    };
    await says(
      status({ configured: false, url: null }),
      "Mimir is not configured: set its URL and token secret name, then save.",
    );
    await says(
      status({ blocked: "local_only", url: null }),
      "Blocked by local-only mode: this URL is not a loopback address.",
    );
    await says(
      status({ error: "ECONNREFUSED" }),
      "Cannot reach Mimir at http://127.0.0.1:7700: ECONNREFUSED.",
    );
    await says(status({ url: null }), "Cannot reach Mimir at .");
    await says(status({ reachable: true, url: null }), "Connected to Mimir  at .");
  });

  it("reports a failed Mimir check and lets it be run again", async () => {
    const api = mockApi({
      getSettings: loaded,
      mimirStatus: () => Promise.reject(new Error("server unreachable")),
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Test Mimir connection" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/server unreachable/);
    expect(screen.getByRole("button", { name: "Test Mimir connection" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByLabelText("Mimir connection")).toBeNull();
  });
});
