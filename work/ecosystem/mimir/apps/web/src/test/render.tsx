import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MimirClient } from "../api/client.js";
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
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </MemoryRouter>
    </StoreProvider>,
  );
}
