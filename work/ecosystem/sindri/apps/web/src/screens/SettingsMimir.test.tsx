import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
    provider: "null",
    model: "claude-fable-5-1",
    localOnly: true,
    mimirUrl: "http://127.0.0.1:7700",
  },
  tokenLocation: "/data/auth-token",
};

describe("SettingsScreen: Mimir and Brokkr", () => {
  it("saves the Mimir token secret name and the Brokkr flag", async () => {
    const api = mockApi({ getSettings: loaded, putSettings: (s: unknown) => Promise.resolve(s) });
    renderWithStore(ui, api);
    await userEvent.type(await screen.findByLabelText("Mimir token secret name"), "mimir.token");
    await userEvent.click(screen.getByLabelText("Use Brokkr for harness selection"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith({
      provider: "null",
      model: "claude-fable-5-1",
      localOnly: true,
      mimirUrl: "http://127.0.0.1:7700",
      mimirTokenSecret: "mimir.token",
      brokkrEnabled: true,
    });
  });

  it("tests the Mimir connection", async () => {
    const api = mockApi({
      getSettings: loaded,
      mimirStatus: {
        configured: true,
        url: "http://127.0.0.1:7700",
        tokenSecret: "mimir.token",
        blocked: null,
        reachable: true,
        serverVersion: "0.1.0",
        error: null,
      },
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Test Mimir connection" }));
    expect((await screen.findByLabelText("Mimir connection")).textContent).toMatch(
      /Connected to Mimir 0\.1\.0/,
    );
  });

  it("explains an unconfigured or blocked Mimir", async () => {
    const api = mockApi({
      getSettings: loaded,
      mimirStatus: {
        configured: true,
        url: "https://mimir.example.com",
        tokenSecret: "x",
        blocked: "local_only",
        reachable: null,
        serverVersion: null,
        error: "local-only mode allows Mimir only on a loopback address",
      },
    });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: "Test Mimir connection" }));
    expect((await screen.findByLabelText("Mimir connection")).textContent).toMatch(/local-only/);
  });

  it("warns about egress when a remote provider is chosen", async () => {
    renderWithStore(ui, mockApi({ getSettings: loaded }));
    expect(screen.queryByText(/leave this machine/)).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText("LLM provider"), "anthropic");
    expect(screen.getByText(/leave this machine/).textContent).toMatch(/turn off local-only/i);
  });
});
