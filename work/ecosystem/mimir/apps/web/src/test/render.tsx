import { ToastProvider } from "@factory/ui";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MimirClient } from "../api/client.js";
import { RoutedProviders } from "../components/Providers.js";
import { StoreProvider } from "../store/StoreProvider.js";

/** Renders `ui` at `route` (matched against `path`) inside the store with a mocked SDK client. */
export function renderWithStore(
  ui: ReactElement,
  {
    client,
    route = "/",
    path = "*",
    onUnauthorized,
  }: { client: MimirClient; route?: string; path?: string; onUnauthorized?: () => void },
) {
  return render(
    <StoreProvider
      client={client}
      refreshDelayMs={0}
      {...(onUnauthorized ? { onUnauthorized } : {})}
    >
      <MemoryRouter initialEntries={[route]}>
        <RoutedProviders>
          {/* AppShell provides toasts in the app; screens rendered alone need their own. */}
          <ToastProvider>
            <Routes>
              <Route path={path} element={ui} />
            </Routes>
          </ToastProvider>
        </RoutedProviders>
      </MemoryRouter>
    </StoreProvider>,
  );
}
