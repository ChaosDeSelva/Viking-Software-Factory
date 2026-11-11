import { fireEvent, screen, within } from "@testing-library/react";
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
const base = { provider: "null", model: "m", localOnly: true };
const loaded = (settings: object = base) => ({ settings, tokenLocation: null });
const section = async () => await screen.findByRole("group", { name: "Feedback Graph" });

describe("SettingsScreen: Feedback Graph", () => {
  it("shows the setup command and saves url, token secret name and enabled", async () => {
    const api = mockApi({
      getSettings: loaded(),
      putSettings: (s: unknown) => Promise.resolve(s),
    });
    renderWithStore(ui, api);
    const fg = await section();
    expect(fg.textContent).toContain(
      "security add-generic-password -s sindri -a feedback-graph.token -w",
    );
    await userEvent.click(within(fg).getByLabelText("Use Feedback Graph lessons"));
    // fireEvent, not userEvent.type: typing long values key by key is slow on a loaded machine.
    fireEvent.change(within(fg).getByLabelText("Feedback Graph URL"), {
      target: { value: "http://127.0.0.1:8787" },
    });
    fireEvent.change(within(fg).getByLabelText("Feedback Graph token secret name"), {
      target: { value: "feedback-graph.token" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith({
      ...base,
      feedbackGraph: {
        url: "http://127.0.0.1:8787",
        tokenSecret: "feedback-graph.token",
        enabled: true,
      },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/Settings saved/);
  });

  it("loads saved values and can disable without losing them", async () => {
    const saved = {
      ...base,
      feedbackGraph: { url: "http://127.0.0.1:9000", tokenSecret: "fg.tok", enabled: true },
    };
    const api = mockApi({
      getSettings: loaded(saved),
      putSettings: (s: unknown) => Promise.resolve(s),
    });
    renderWithStore(ui, api);
    const fg = await section();
    expect((within(fg).getByLabelText("Feedback Graph URL") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:9000",
    );
    expect(
      (within(fg).getByLabelText("Feedback Graph token secret name") as HTMLInputElement).value,
    ).toBe("fg.tok");
    const enabled = within(fg).getByLabelText("Use Feedback Graph lessons") as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    await userEvent.click(enabled);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith({
      ...saved,
      feedbackGraph: { url: "http://127.0.0.1:9000", tokenSecret: "fg.tok", enabled: false },
    });
  });

  it("leaves an untouched, empty section out of the saved settings", async () => {
    const api = mockApi({ getSettings: loaded(), putSettings: (s: unknown) => Promise.resolve(s) });
    renderWithStore(ui, api);
    const fg = await section();
    // Typed and erased again: still empty, so not sent.
    const url = within(fg).getByLabelText("Feedback Graph URL");
    await userEvent.type(url, "x");
    await userEvent.clear(url);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.putSettings).toHaveBeenCalledWith(base);
  });
});
