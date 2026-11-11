import { useMemo } from "react";
import { createApiClient, type ApiClient } from "./api/client.js";
import { Layout, SindriLinks } from "./components/Layout.js";
import { TokenPrompt } from "./components/TokenPrompt.js";
import { AutonomyAllScreen, AutonomyScreen } from "./screens/AutonomyScreen.js";
import { DeliveriesScreen } from "./screens/DeliveriesScreen.js";
import { DirectorScreen } from "./screens/DirectorScreen.js";
import { DocsScreen } from "./screens/DocsScreen.js";
import { HarnessesScreen } from "./screens/HarnessesScreen.js";
import { InboxScreen } from "./screens/InboxScreen.js";
import { KnowledgeScreen } from "./screens/KnowledgeScreen.js";
import { OverviewScreen } from "./screens/OverviewScreen.js";
import { PlansScreen } from "./screens/PlansScreen.js";
import { ProjectSettingsScreen } from "./screens/ProjectSettingsScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { ReviewsScreen } from "./screens/ReviewsScreen.js";
import { RunsScreen } from "./screens/RunsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SpecsScreen } from "./screens/SpecsScreen.js";
import { AppProviders, migrateTheme, readInitial, TOKEN_KEY, useStore } from "./store/context.js";
import type { State } from "./store/reducer.js";

function Shell() {
  const { state } = useStore();
  if (!state.token) return <TokenPrompt />;
  // Keyed on the project: selections and results from one project never carry into another.
  const project = state.projectId ?? "";
  const screen = {
    overview: <OverviewScreen key={project} />,
    inbox: <InboxScreen key={project} />,
    director: <DirectorScreen key={project} />,
    specs: <SpecsScreen />,
    plans: <PlansScreen key={project} />,
    runs: <RunsScreen />,
    "needs-you": <ReviewsScreen />,
    deliveries: <DeliveriesScreen />,
    knowledge: <KnowledgeScreen key={project} />,
    autonomy: <AutonomyScreen key={project} />,
    "project-settings": <ProjectSettingsScreen key={project} />,
    projects: <ProjectsScreen />,
    harnesses: <HarnessesScreen />,
    "autonomy-all": <AutonomyAllScreen />,
    settings: <SettingsScreen />,
    docs: <DocsScreen />,
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
  const initial = useMemo(() => {
    migrateTheme();
    return { ...readInitial(), ...props.initial };
  }, [props.initial]);
  return (
    <AppProviders api={api} initial={initial}>
      <SindriLinks>
        <Shell />
      </SindriLinks>
    </AppProviders>
  );
}
