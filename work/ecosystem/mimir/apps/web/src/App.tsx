import { useCallback, useMemo, useState, type ReactNode } from "react";
import { BrowserRouter, Link, MemoryRouter, Route, Routes } from "react-router";
import { createClient, describeError, type ClientOptions, type MimirClient } from "./api/client.js";
import { SessionContext } from "./api/session.js";
import { clearToken, loadToken, saveToken } from "./api/token.js";
import { Layout } from "./components/Layout.js";
import { PageTitle } from "./components/Section.js";
import { EmptyState, ErrorState } from "./components/StateViews.js";
import { TokenPrompt } from "./components/TokenPrompt.js";
import { Activity } from "./screens/Activity.js";
import { AgentInspector } from "./screens/AgentInspector.js";
import { CrewDetail, Crews } from "./screens/Crews.js";
import { MissionDetail } from "./screens/MissionDetail.js";
import { Missions } from "./screens/Missions.js";
import { Overview } from "./screens/Overview.js";
import { Projects } from "./screens/Projects.js";
import { Reviews } from "./screens/Reviews.js";
import { Settings } from "./screens/Settings.js";
import { StoreProvider } from "./store/StoreProvider.js";

function NotFound() {
  return (
    <>
      <PageTitle>Not found</PageTitle>
      <EmptyState>
        Nothing lives here. <Link to="/">Go to the overview</Link>.
      </EmptyState>
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/missions" element={<Missions />} />
        <Route path="/missions/:id" element={<MissionDetail />} />
        <Route path="/crews" element={<Crews />} />
        <Route path="/crews/:id" element={<CrewDetail />} />
        <Route path="/agents/:sessionId" element={<AgentInspector />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function Router({
  initialPath,
  children,
}: {
  initialPath: string | undefined;
  children: ReactNode;
}) {
  return initialPath ? (
    <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  ) : (
    <BrowserRouter>{children}</BrowserRouter>
  );
}

export function defaultBaseUrl(): string {
  const configured = import.meta.env["VITE_MIMIR_URL"] as string | undefined;
  return configured && configured.length > 0 ? configured : window.location.origin;
}

export interface AppProps {
  clientFactory?: (opts: ClientOptions) => MimirClient;
  baseUrl?: string;
  /** Use an in-memory router starting here (tests). Default: the browser URL. */
  initialPath?: string;
}

export function App({
  clientFactory = createClient,
  baseUrl = defaultBaseUrl(),
  initialPath,
}: AppProps) {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const [rejected, setRejected] = useState(false);

  const client = useMemo<{ ok: MimirClient } | { error: string } | null>(() => {
    if (token === null) return null;
    try {
      return { ok: clientFactory({ baseUrl, token }) };
    } catch (e) {
      return { error: describeError(e).message };
    }
  }, [token, baseUrl, clientFactory]);

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);
  const onUnauthorized = useCallback(() => {
    clearToken();
    setRejected(true);
    setToken(null);
  }, []);
  const session = useMemo(() => ({ signOut }), [signOut]);

  if (token === null || client === null) {
    return (
      <TokenPrompt
        rejected={rejected}
        onSubmit={(t) => {
          saveToken(t);
          setRejected(false);
          setToken(loadToken());
        }}
      />
    );
  }
  if ("error" in client) {
    return (
      <main id="main" className="p-6">
        <ErrorState message={client.error} />
      </main>
    );
  }
  return (
    <SessionContext.Provider value={session}>
      <StoreProvider client={client.ok} onUnauthorized={onUnauthorized}>
        <Router initialPath={initialPath}>
          <AppRoutes />
        </Router>
      </StoreProvider>
    </SessionContext.Provider>
  );
}
