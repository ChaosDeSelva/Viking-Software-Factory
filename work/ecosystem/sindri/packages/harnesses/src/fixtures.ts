import type { HarnessRequest, HarnessSummary, RepoSignals } from "./types.js";

/**
 * Test fixtures modelled on Brokkr's built-in harness library (brief B3 §15:
 * frontend-react, backend-node, security-baseline, documentation) plus a QA harness for
 * Sindri's independent-QA role. Names and required/optional skill split follow
 * `brokkr/harnesses/*\/harness.yaml` where those exist.
 */
export interface FakeSkill {
  name: string;
  version: string;
  selectors: { taskTypes?: string[]; keywords?: string[]; pathGlobs?: string[] };
}

export type FakeHarness = HarnessSummary;

export interface FakeProfile {
  name: string;
  harnesses: HarnessRequest[];
}

const skill = (name: string, selectors: FakeSkill["selectors"]): FakeSkill => ({
  name,
  version: "1.0.0",
  selectors,
});

export const FAKE_SKILLS: readonly FakeSkill[] = [
  skill("react-architecture", { taskTypes: ["frontend", "ui", "react"] }),
  skill("typescript", { pathGlobs: ["**/*.ts", "**/*.tsx"] }),
  skill("accessibility", { keywords: ["accessibility", "a11y", "aria", "keyboard"] }),
  skill("tailwind", { keywords: ["tailwind", "styling", "responsive"] }),
  skill("performance", { keywords: ["performance", "slow", "render"] }),
  skill("component-design", {
    taskTypes: ["ui"],
    keywords: ["component", "button", "form", "modal", "dashboard"],
  }),
  skill("playwright-e2e", { keywords: ["screenshot", "e2e", "playwright"] }),
  skill("api-design", { taskTypes: ["backend", "api"] }),
  skill("input-validation", { keywords: ["validate", "validation", "input"] }),
  skill("error-handling", { keywords: ["error", "failure"] }),
  skill("structured-logging", { keywords: ["log", "logging", "observability"] }),
  skill("auth-review", { keywords: ["auth", "authentication", "authorization", "permission"] }),
  skill("integration-testing", { keywords: ["integration", "end-to-end", "contract"] }),
  skill("secret-hygiene", { keywords: ["secret", "credential", "token"] }),
  skill("dependency-audit", { keywords: ["dependency", "audit", "vulnerability"] }),
  skill("threat-modeling", { keywords: ["threat", "attack", "security"] }),
  skill("docs-accuracy", { taskTypes: ["docs"] }),
  skill("release-notes", { keywords: ["release", "changelog", "release notes"] }),
  skill("api-reference", { keywords: ["endpoint", "api reference", "openapi"] }),
  skill("regression-test-plan", { taskTypes: ["qa"] }),
  skill("test-evidence", { keywords: ["evidence", "report"] }),
];

const checks = (...ids: [string, boolean][]) => ids.map(([id, required]) => ({ id, required }));

export const FAKE_HARNESSES: readonly FakeHarness[] = [
  {
    name: "frontend-react",
    version: "1.0.0",
    description: "React + TypeScript frontend engineering harness with accessibility and test gates",
    taskTypes: ["frontend", "ui", "react"],
    skills: {
      required: ["react-architecture", "typescript", "accessibility"],
      optional: ["tailwind", "performance", "component-design"],
    },
    checks: checks(["typecheck", true], ["lint", false], ["test", true]),
  },
  {
    name: "frontend-react",
    version: "1.1.0",
    description: "React + TypeScript frontend harness with Playwright screenshots (desktop/mobile)",
    taskTypes: ["frontend", "ui", "react"],
    skills: {
      required: ["react-architecture", "typescript", "accessibility"],
      optional: ["tailwind", "performance", "component-design", "playwright-e2e"],
    },
    checks: checks(
      ["typecheck", true],
      ["lint", false],
      ["test", true],
      ["screenshots", false],
      ["axe", false],
    ),
  },
  {
    name: "backend-node",
    version: "1.0.0",
    description: "Node.js + TypeScript backend/API engineering harness with validation and test gates",
    taskTypes: ["backend", "api", "node"],
    skills: {
      required: ["api-design", "typescript", "input-validation", "error-handling"],
      optional: ["structured-logging", "auth-review", "integration-testing"],
    },
    checks: checks(["typecheck", true], ["lint", false], ["test", true]),
  },
  {
    name: "security-baseline",
    version: "1.0.0",
    description: "Secret scan, dependency audit, insecure config and dangerous code patterns",
    taskTypes: ["security"],
    skills: { required: ["secret-hygiene", "dependency-audit"], optional: ["threat-modeling"] },
    checks: checks(["secret-scan", true], ["dependency-audit", true], ["insecure-config", false]),
  },
  {
    name: "documentation",
    version: "1.0.0",
    description: "Accurate user documentation and release notes",
    taskTypes: ["docs", "documentation"],
    skills: { required: ["docs-accuracy"], optional: ["release-notes", "api-reference"] },
    checks: checks(["markdown-lint", false], ["links", false]),
  },
  {
    name: "qa-regression",
    version: "1.0.0",
    description: "Independent regression test plan and evidence capture",
    taskTypes: ["qa", "test"],
    skills: { required: ["regression-test-plan"], optional: ["test-evidence", "playwright-e2e"] },
    checks: checks(["test", true]),
  },
];

export const FAKE_PROFILES: readonly FakeProfile[] = [
  {
    name: "frontend-strict",
    harnesses: [
      { name: "frontend-react", version: "^1.0.0" },
      { name: "security-baseline", version: "^1.0.0" },
    ],
  },
  {
    name: "backend-strict",
    harnesses: [
      { name: "backend-node", version: "^1.0.0" },
      { name: "security-baseline", version: "^1.0.0" },
    ],
  },
  {
    name: "fullstack",
    harnesses: [
      { name: "frontend-react", version: "^1.0.0" },
      { name: "backend-node", version: "^1.0.0" },
    ],
  },
];

export const FAKE_REPO_SIGNALS: RepoSignals = {
  packageManager: "pnpm",
  frameworks: ["fastify", "react", "vite"],
  scripts: ["build", "lint", "test", "typecheck"],
  hasTsconfig: true,
  testRunners: ["vitest"],
};
