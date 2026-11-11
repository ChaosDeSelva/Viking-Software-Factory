import { classifyCommand } from "@mimir/core";
import { newId, type CrewMember, type Project } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import type { ReadModel } from "../readmodel.js";
import {
  DEFAULT_TEST_COMMAND,
  classifiedArgv,
  classifyOptions,
  memberOf,
  projectEnv,
  projectSettings,
  testCommandOf,
} from "./commands.js";

const T0 = "2026-01-01T00:00:00.000Z";
const project = (settings: Record<string, unknown>): Project =>
  ({
    id: newId("prj"),
    name: "p",
    repoPath: "/repo",
    settings,
    createdAt: T0,
    updatedAt: T0,
    version: 0,
  }) as Project;

describe("project settings", () => {
  it("reads nothing from a missing project or a stored value that no longer validates", () => {
    expect(projectSettings(undefined)).toEqual({});
    expect(projectSettings(project({ testCommand: 42 }))).toEqual({});
    expect(projectEnv(undefined)).toBeUndefined();
  });

  it("puts the project's directories in front of PATH, or alone when there is no PATH", () => {
    const p = project({ agent: { pathPrepend: ["/opt/a", "/opt/b"], env: { K: "v" } } });
    expect(projectEnv(p, "/usr/bin")).toEqual({ K: "v", PATH: "/opt/a:/opt/b:/usr/bin" });
    expect(projectEnv(p, "")).toEqual({ K: "v", PATH: "/opt/a:/opt/b" });
  });
});

describe("testCommandOf", () => {
  it("runs a legacy string test command through sh -c, so that it is classified, not trusted", () => {
    expect(testCommandOf(project({ testCommand: "make test && rm -rf /" }))).toEqual([
      "sh",
      "-c",
      "make test && rm -rf /",
    ]);
  });

  it("falls back to the default for a missing, empty or non-string argv", () => {
    for (const testCommand of [undefined, [], ["make", 1]])
      expect(testCommandOf(project({ testCommand }))).toEqual([...DEFAULT_TEST_COMMAND]);
    expect(testCommandOf(undefined)).toEqual([...DEFAULT_TEST_COMMAND]);
  });

  it("never allowlists a shell as the project's exact test command", () => {
    const p = project({ testCommand: ["bash", "-c", "make test"] });
    const opts = classifyOptions(p, "/wt", undefined);
    expect(opts).not.toHaveProperty("currentBranch");
    expect(classifyCommand(["bash", "-c", "make test"], opts)).not.toBeNull();
    const q = project({ testCommand: ["make", "test"] });
    expect(classifyCommand(["make", "test"], classifyOptions(q, "/wt", "b"))).toBeNull();
  });
});

describe("classifiedArgv", () => {
  it("classifies the full sh -c argv when the shell command is not plain words", () => {
    expect(classifiedArgv(["sh", "-c", "echo hi"], false, "shell")).toEqual(["echo", "hi"]);
    expect(classifiedArgv(["sh", "-c", "echo $HOME"], false, "shell")).toEqual([
      "sh",
      "-c",
      "echo $HOME",
    ]);
    // Not the `sh -c <cmd>` shape at all: classified as given.
    expect(classifiedArgv(["make", "test"], false, "shell")).toEqual(["make", "test"]);
    expect(classifiedArgv(["claude", "-p", "x"], false, "claude")).toBeNull();
    expect(classifiedArgv(["claude", "--yolo"], true, "claude")).toEqual(["", "claude", "--yolo"]);
  });
});

describe("memberOf", () => {
  const member = (crewId: string, role: string, createdAt: string): CrewMember =>
    ({ id: newId("cmb"), crewId, role, agentKind: "shell", createdAt }) as unknown as CrewMember;
  const rm = (members: CrewMember[]) =>
    ({ crewMembers: new Map(members.map((m) => [m.id, m])) }) as unknown as ReadModel;

  it("picks the implementer, else the earliest member of that crew", () => {
    const crew = newId("crw");
    const late = member(crew, "reviewer", "2026-01-03T00:00:00.000Z");
    const early = member(crew, "reviewer", "2026-01-01T00:00:00.000Z");
    const same = member(crew, "tester", "2026-01-01T00:00:00.000Z");
    const other = member(newId("crw"), "implementer", "2025-01-01T00:00:00.000Z");
    expect(memberOf(rm([late, other, early, same]), crew)?.id).toBe(early.id);
    const impl = member(crew, "implementer", "2026-01-05T00:00:00.000Z");
    expect(memberOf(rm([late, early, impl]), crew)?.id).toBe(impl.id);
    expect(memberOf(rm([other]), crew)).toBeUndefined();
  });
});
