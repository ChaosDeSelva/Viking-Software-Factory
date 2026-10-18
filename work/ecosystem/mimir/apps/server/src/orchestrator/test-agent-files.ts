import type { FakeRuntime } from "@mimir/fake-runtime";
import type { RuntimeAdapter } from "@mimir/protocol";

/**
 * Test-only: the FakeRuntime runs no process, so this wrapper plays the agent's file writes:
 * `write(cwd)` runs when a session is created in a worktree, then the fake takes over.
 */
export function writingRuntime(fake: FakeRuntime, write: (cwd: string) => void): RuntimeAdapter {
  return {
    capabilities: () => fake.capabilities(),
    health: () => fake.health(),
    createSession: (spec) => {
      write(spec.cwd);
      return fake.createSession(spec);
    },
    listSessions: () => fake.listSessions(),
    getSession: (id) => fake.getSession(id),
    sendInput: (id, input) => fake.sendInput(id, input),
    requestStop: (id, mode) => fake.requestStop(id, mode),
    reconcile: () => fake.reconcile(),
    dispose: () => fake.dispose(),
    subscribe: (handler) => fake.subscribe(handler),
  };
}
