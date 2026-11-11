import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
/** Answers the project list; every other call (health, Needs you count, the screen) is a 404. */
const server = (body: unknown) =>
  vi.fn(async (url: string) =>
    url.endsWith("/v1/projects")
      ? ok(body)
      : ok({ error: { code: "not_found", message: "not here" } }, 404),
  );

/** The project-list request (the bottom bar also polls `/v1/health`). */
const projects = (fetch: { mock: { calls: unknown[][] } }) =>
  (fetch.mock.calls as unknown as [string, RequestInit][]).find(([u]) =>
    u.endsWith("/v1/projects"),
  );

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
    const fetch = server({ projects: [{ id: "p1", name: "One", repoPath: "/r" }] });
    vi.stubGlobal("fetch", fetch);
    sessionStorage.setItem("sindri.token", "tok-1");
    render(<App initial={{ token: "tok-1", view: "runs" }} />);
    await waitFor(() => expect(projects(fetch)).toBeDefined());
    const [url, init] = projects(fetch)!;
    expect(url).toBe("/v1/projects");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-1");
    expect(await screen.findByRole("button", { name: "Project: One" })).toBeTruthy();
  });

  it("uses the API base URL given at build time", async () => {
    vi.stubEnv("VITE_SINDRI_API", "http://127.0.0.1:4310");
    const fetch = server({ projects: [] });
    vi.stubGlobal("fetch", fetch);
    render(<App initial={{ token: "tok-1", view: "runs" }} />);
    await waitFor(() => expect(projects(fetch)).toBeDefined());
    expect(projects(fetch)![0]).toBe("http://127.0.0.1:4310/v1/projects");
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
