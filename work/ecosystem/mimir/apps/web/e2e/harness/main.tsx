/**
 * E2E-only harness: renders the real app routes against a static in-browser client so Playwright
 * can run axe (including color contrast) on every screen without a server. Not part of the build.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../../src/App.js";
import { applyTheme } from "../../src/lib/theme.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import "../../src/index.css";
import { fixtureClient, IDS } from "./fixtureClient.js";

applyTheme("system");
const path = (new URLSearchParams(window.location.search).get("path") ?? "/").replace(
  /:(\w+)/g,
  (_, k: string) => IDS[k as keyof typeof IDS] ?? k,
);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <StoreProvider client={fixtureClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </StoreProvider>
  </StrictMode>,
);
