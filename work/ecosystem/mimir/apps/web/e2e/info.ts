import { readFileSync } from "node:fs";

export interface E2eInfo {
  baseUrl: string;
  controlUrl: string;
  token: string;
  /** Used by flow.spec.ts. */
  repoPath: string;
  /** A second repo for live.spec.ts (a repository can back only one project). */
  liveRepoPath: string;
}

/** Written by scripts/dev-server.ts to MIMIR_E2E_INFO (set once by playwright.config.ts). */
export function e2eInfo(): E2eInfo {
  const path = process.env["MIMIR_E2E_INFO"];
  if (!path) throw new Error("MIMIR_E2E_INFO is not set (run through playwright.config.ts)");
  return JSON.parse(readFileSync(path, "utf8")) as E2eInfo;
}
