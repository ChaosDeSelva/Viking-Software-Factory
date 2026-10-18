import { useMemo } from "react";
import { createApiClient, type ApiClient } from "./api/client.js";
import { Layout } from "./components/Layout.js";
import { TokenPrompt } from "./components/TokenPrompt.js";
import { DeliveriesScreen } from "./screens/DeliveriesScreen.js";
import { DirectorScreen } from "./screens/DirectorScreen.js";
import { HarnessesScreen } from "./screens/HarnessesScreen.js";
import { InboxScreen } from "./screens/InboxScreen.js";
import { KnowledgeScreen } from "./screens/KnowledgeScreen.js";
import { PlansScreen } from "./screens/PlansScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { ReviewsScreen } from "./screens/ReviewsScreen.js";
import { RunsScreen } from "./screens/RunsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SpecsScreen } from "./screens/SpecsScreen.js";
import { AppProviders, readInitial, TOKEN_KEY, useStore } from "./store/context.js";
import type { State } from "./store/reducer.js";

function Shell() {
  const { state } = useStore();
  if (!state.token) return <TokenPrompt />;
  const screen = {
    projects: <ProjectsScreen />,
    inbox: <InboxScreen />,
    director: <DirectorScreen />,
    specs: <SpecsScreen />,
    knowledge: <KnowledgeScreen />,
    settings: <SettingsScreen />,
    plans: <PlansScreen />,
    harnesses: <HarnessesScreen />,
    runs: <RunsScreen />,
    reviews: <ReviewsScreen />,
    deliveries: <DeliveriesScreen />,
  }[state.view];
  return <Layout>{screen}</Layout>;
}

export function App(props: { api?: ApiClient; initial?: Partial<State> }) {
  const api = useMemo(
    () =>
      props.api ??
      createApiClient({
        baseUrl: import.meta.env.VITE_SINDRI_API ?? "",
        getToken: () => sessionStorage.getItem(TOKEN_KEY),
      }),
    [props.api],
  );
  const initial = useMemo(() => ({ ...readInitial(), ...props.initial }), [props.initial]);
  return (
    <AppProviders api={api} initial={initial}>
      <Shell />
    </AppProviders>
  );
}
