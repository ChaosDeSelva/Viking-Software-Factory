import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  sessionStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("App without an injected client", () => {
  it("talks to the same origin with the token from sessionStorage", async () => {
    const fetch = vi.fn(async () => ok({ projects: [{ id: "p1", name: "One", repoPath: "/r" }] }));
    vi.stubGlobal("fetch", fetch);
    sessionStorage.setItem("sindri.token", "tok-1");
    render(<App initial={{ token: "tok-1", view: "runs" }} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/projects");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-1");
    expect(await screen.findByRole("option", { name: "One" })).toBeTruthy();
  });

  it("uses the API base URL given at build time", async () => {
    vi.stubEnv("VITE_SINDRI_API", "http://127.0.0.1:4310");
    const fetch = vi.fn(async () => ok({ projects: [] }));
    vi.stubGlobal("fetch", fetch);
    render(<App initial={{ token: "tok-1", view: "runs" }} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "http://127.0.0.1:4310/v1/projects",
    );
  });
});

describe("main entry", () => {
  it("mounts the app into #root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ projects: [] })),
    );
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./main.js");
    });
    expect(await screen.findByLabelText("API token")).toBeTruthy();
  });

  it("fails clearly when the page has no #root", async () => {
    await expect(import("./main.js")).rejects.toThrow("Missing #root element");
  });
});
