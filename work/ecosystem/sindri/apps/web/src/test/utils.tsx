import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi, type Mock } from "vitest";
import type { ApiClient } from "../api/client.js";
import { DELIVERY_METHOD_NAMES } from "../api/delivery-client.js";
import type { Project } from "../api/types.js";
import { AppProviders } from "../store/context.js";
import type { State } from "../store/reducer.js";

export type MockApi = { [K in keyof ApiClient]: Mock };

/** Every API method is a vi.fn that rejects until a test gives it an implementation. */
export function mockApi(over: Partial<Record<keyof ApiClient, unknown>> = {}): MockApi {
  const names: (keyof ApiClient)[] = [
    "health",
    "capabilities",
    "listProjects",
    "getProject",
    "createProject",
    "bootstrap",
    "search",
    "deleteProjectData",
    "listIntakes",
    "getIntake",
    "createIntake",
    "importIntake",
    "draft",
    "questions",
    "answer",
    "listSpecs",
    "getSpec",
    "renderSpec",
    "diffSpecs",
    "submitSpec",
    "approveSpec",
    "unlockApprovals",
    "hasApprovalSession",
    "reviseSpec",
    "listKnowledge",
    "addKnowledge",
    "retractKnowledge",
    "supersedeKnowledge",
    "knowledgeHistory",
    "getSettings",
    "putSettings",
    "exportData",
    ...DELIVERY_METHOD_NAMES,
  ];
  const api = {} as MockApi;
  for (const n of names) {
    const impl = over[n];
    api[n] = vi.fn(
      impl === undefined
        ? () => Promise.reject(new Error(`${n} not mocked`))
        : typeof impl === "function"
          ? (impl as (...a: unknown[]) => unknown)
          : () => Promise.resolve(impl),
    );
  }
  // Approvals are unlocked unless a test says otherwise (audit M9 has its own tests).
  if (over.hasApprovalSession === undefined) api.hasApprovalSession = vi.fn(() => true);
  if (over.unlockApprovals === undefined)
    api.unlockApprovals = vi.fn(() =>
      Promise.resolve({ principal: "local:test/web#aps_1", expiresAt: "" }),
    );
  return api;
}

export const PROJECT: Project = { id: "p1", name: "Demo", repoPath: "/repo/demo" };

export function renderWithStore(ui: ReactElement, api: MockApi, initial: Partial<State> = {}) {
  return render(
    <AppProviders
      api={api as unknown as ApiClient}
      initial={{ token: "tok", projects: [PROJECT], projectId: PROJECT.id, ...initial }}
    >
      {ui}
    </AppProviders>,
  );
}
