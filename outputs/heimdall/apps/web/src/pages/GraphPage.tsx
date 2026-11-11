// Execution graph: one task graph per mission of the selected project. Node positions are saved
// per mission in Heimdall's preferences; dependencies come from Mimir and never change here.
import { Button, EmptyState, Page, PageHeader, Stack } from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore } from "../components/app";
import type { R } from "../lib/api";
import { navigate } from "../lib/router";
import { Graph } from "../features/Graph";
import { missionSpecTitle } from "../features/workflowState";

export function GraphPage() {
  const { state, scope, projectName, open, href, savePreferences } =
    useHeimdall();
  const preferences: R = state?.preferences ?? {};
  return (
    <Page>
      <PageHeader
        title="Execution graph"
        description={
          <>
            Each mission's tasks and what they wait for. Open a node to inspect
            the task.
          </>
        }
        learnMore={<LearnMore screen="execution-graph" />}
        term="Task graph"
        scope={{ project: projectName }}
      />
      {scope.missions.length ? (
        <Stack gap={6}>
          {scope.missions.map((mission) => (
            <Graph
              key={mission.id}
              mission={mission}
              title={missionSpecTitle(
                mission,
                state?.sindri?.executions ?? [],
                state?.sindri?.specs ?? [],
              )}
              tasks={scope.tasks.filter((t) => t.missionId === mission.id)}
              dependencies={state?.mimir?.taskDependencies ?? []}
              saved={preferences.graphs?.[mission.id]}
              onSave={(positions) =>
                void savePreferences({
                  graphs: { ...preferences.graphs, [mission.id]: positions },
                })
              }
              onInspect={(task) => open("tasks", task)}
            />
          ))}
        </Stack>
      ) : (
        <EmptyState
          title="No execution graph yet"
          body="A graph appears when an approved plan starts and Mimir creates its mission."
          action={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => navigate(href("new-work"))}
            >
              New work
            </Button>
          }
        />
      )}
    </Page>
  );
}
