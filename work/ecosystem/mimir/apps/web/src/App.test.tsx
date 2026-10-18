import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_KEY } from "./api/token.js";
import { App } from "./App.js";
import { mockClient } from "./test/mockClient.js";

describe("App", () => {
  it("prompts once for the token, keeps it in sessionStorage only, then shows the overview", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    const factory = vi.fn(() => client);
    render(<App clientFactory={factory} baseUrl="http://127.0.0.1:7700" />);
    expect(screen.getByRole("heading", { name: "Connect to Mimir" })).toBeTruthy();
    await user.type(screen.getByLabelText(/auth token/i), "s3cret");
    await user.click(screen.getByRole("button", { name: /connect/i }));
    expect(factory).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:7700", token: "s3cret" });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("s3cret");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.href).not.toContain("s3cret");
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });

  it("uses a token already in sessionStorage", async () => {
    sessionStorage.setItem(TOKEN_KEY, "tok");
    const factory = vi.fn(() => mockClient());
    render(<App clientFactory={factory} baseUrl="http://x" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(factory).toHaveBeenCalledWith({ baseUrl: "http://x", token: "tok" });
  });

  it("returns to the prompt when the server rejects the token", async () => {
    sessionStorage.setItem(TOKEN_KEY, "bad");
    const err = Object.assign(new Error("unauthorized"), {
      name: "MimirError",
      code: "unauthorized",
      status: 401,
    });
    const client = mockClient({ snapshot: vi.fn(async () => Promise.reject(err)) });
    render(<App clientFactory={() => client} baseUrl="http://x" />);
    expect(await screen.findByRole("heading", { name: "Connect to Mimir" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("shows an error when the SDK client cannot be created", async () => {
    sessionStorage.setItem(TOKEN_KEY, "tok");
    render(
      <App
        clientFactory={() => {
          throw new Error("@mimir/sdk does not export createMimirClient");
        }}
        baseUrl="http://x"
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/createMimirClient/);
  });

  it("routes every screen", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(TOKEN_KEY, "tok");
    render(<App clientFactory={() => mockClient()} baseUrl="http://x" />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    for (const [link, heading] of [
      ["Projects", "Projects"],
      ["Missions", "Missions"],
      ["Crews", "Crews"],
      ["Reviews", "Reviews"],
      ["Activity", "Activity"],
      ["Settings", "Settings"],
    ] as const) {
      await user.click(screen.getByRole("link", { name: new RegExp(`^${link}`) }));
      await waitFor(() =>
        expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy(),
      );
    }
  });

  it("signs out from settings", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(TOKEN_KEY, "tok");
    render(<App clientFactory={() => mockClient()} baseUrl="http://x" initialPath="/settings" />);
    await user.click(await screen.findByRole("button", { name: "Forget token" }));
    expect(screen.getByRole("heading", { name: "Connect to Mimir" })).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
