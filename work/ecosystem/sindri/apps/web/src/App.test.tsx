import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { ApiError } from "./api/client.js";
import { App } from "./App.js";
import { mockApi } from "./test/utils.js";

afterEach(() => sessionStorage.clear());

describe("App", () => {
  it("asks for the token first and keeps it in sessionStorage only", async () => {
    const api = mockApi({ listProjects: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: null }} />);
    expect(screen.getByRole("heading", { name: "Sindri" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("API token"), "secret-token");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(sessionStorage.getItem("sindri.token")).toBe("secret-token");
    expect(localStorage.getItem("sindri.token")).toBeNull();
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("navigates with the keyboard (Alt+6 opens Settings) and toggles the theme", async () => {
    const api = mockApi({
      listProjects: [],
      getSettings: {
        settings: { provider: "null", model: "m", localOnly: true },
        tokenLocation: "/d/auth-token",
      },
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    await userEvent.keyboard("{Alt>}6{/Alt}");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await userEvent.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("returns to the token prompt when the server rejects the token", async () => {
    const api = mockApi({
      listProjects: () => Promise.reject(new ApiError(401, "unauthorized", "bad token")),
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "stale" }} />);
    await waitFor(() => expect(screen.getByLabelText("API token")).toBeTruthy());
    expect(screen.getByText(/rejected the token/)).toBeTruthy();
  });
});
