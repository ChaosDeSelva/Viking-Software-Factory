import { describe, expect, it } from "vitest";
import {
  SENSITIVE_HOME_ENTRIES,
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  sensitivePathPatterns,
} from "./sensitive-paths.js";

const HOME = "/Users/x";

describe("sensitive paths (audit H1/M2; consumed by the policy secret list)", () => {
  const SECRET = [
    "~/.mimir/auth-token",
    "~/.mimir",
    "~/.mimir/mimir.db",
    "/Users/x/.mimir/auth-token",
    "@/Users/x/.mimir/auth-token",
    "--data=@~/.mimir/auth-token",
    "~/.claude/.credentials.json",
    "/Users/x/.claude/.credentials.json",
    "~/.claude.json",
    "~/.config/herdr/config.toml",
    "/Users/x/.config/herdr",
    "~/.codex/auth.json",
    "~/.config/anthropic/key",
    "~/.azure/accessTokens.json",
    "~/Library/Keychains/login.keychain-db",
    "/proc/self/environ",
    "/proc/1234/environ",
    "/USERS/X/.MIMIR/AUTH-TOKEN",
  ];
  for (const p of SECRET) {
    it(`flags ${p}`, () => expect(isSensitivePath(p, { home: HOME })).toBe(true));
  }

  const BENIGN = [
    ".claude/agents/reviewer.md", // a project's own .claude dir, relative to the worktree
    "src/.mimir-owner.json",
    "/work/wt/.claude/settings.json",
    "/Users/x/.mimir-work/worktrees/prj/task/src/index.ts", // worktrees live outside the data dir
    "~/.mimirrc",
    "/Users/x/src/project/README.md",
    "/proc/self/status",
  ];
  for (const p of BENIGN) {
    it(`does not flag ${p}`, () => expect(isSensitivePath(p, { home: HOME })).toBe(false));
  }

  it("covers a non-default MIMIR_DATA_DIR", () => {
    expect(isSensitivePath("/srv/mimir-data/auth-token", { home: HOME })).toBe(false);
    expect(
      isSensitivePath("/srv/mimir-data/auth-token", { home: HOME, dataDir: "/srv/mimir-data" }),
    ).toBe(true);
    expect(isSensitivePath("/srv/mimir-data2/x", { home: HOME, dataDir: "/srv/mimir-data" })).toBe(
      false,
    );
  });

  it("escapes regex metacharacters in home and data dir", () => {
    expect(isSensitivePath("/a.b/.mimir/x", { home: "/a+b" })).toBe(false);
    expect(isSensitivePath("/a+b/.mimir/x", { home: "/a+b" })).toBe(true);
    expect(isSensitivePath("/d(x)/t", { home: HOME, dataDir: "/d(x)" })).toBe(true);
  });

  it("exports the required home-relative entries and static ~/ patterns", () => {
    for (const p of [".mimir", ".claude", ".config/herdr"]) {
      expect(SENSITIVE_HOME_ENTRIES).toContain(p);
    }
    const t = (s: string) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(s));
    expect(t("~/.mimir/auth-token")).toBe(true);
    expect(t("~/.claude/.credentials.json")).toBe(true);
    expect(t("~/.config/herdr/x")).toBe(true);
    expect(sensitivePathPatterns({ home: HOME }).length).toBeGreaterThan(
      SENSITIVE_PATH_PATTERNS.length,
    );
  });
});

describe("sensitive paths without a known home (browser-safe defaults)", () => {
  it("static patterns cover macOS/Linux home spellings", () => {
    const t = (s: string) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(s.toLowerCase()));
    expect(t("/Users/x/.mimir/auth-token")).toBe(true);
    expect(t("/home/u/.claude/.credentials.json")).toBe(true);
    expect(t("/root/.config/herdr/config.toml")).toBe(true);
    expect(t("/Users/x/project/.mimir-owner.json")).toBe(false);
    expect(t("/Users/x/project/.claude/agents/a.md")).toBe(false);
  });
});
