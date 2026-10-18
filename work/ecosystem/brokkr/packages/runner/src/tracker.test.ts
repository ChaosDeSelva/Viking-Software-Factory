import { describe, expect, it } from "vitest";
import { ProcessTracker, type ProcInfo } from "./index.js";

const proc = (pid: number, ppid: number, start: string, pgid = pid): ProcInfo => ({
  pid,
  ppid,
  pgid,
  sid: 0,
  start,
  hasToken: false,
});

describe("ProcessTracker never adopts unrelated processes through recycled pids", () => {
  it("ignores children of a recycled root pid or a recycled descendant pid", async () => {
    let world: ProcInfo[] = [
      proc(100, 1, "root"),
      proc(200, 100, "child", 100),
      proc(250, 200, "escapee"),
    ];
    const tracker = new ProcessTracker(100, "t", 1_000_000, async () => world);
    await tracker.sample();
    // The root and the first child exit; their pids are reused by unrelated processes,
    // which have their own children. The real escapee (250) is still alive.
    world = [
      proc(100, 1, "unrelated-root"),
      proc(300, 100, "unrelated-child"),
      proc(200, 1, "unrelated-200"),
      proc(400, 200, "unrelated-grandchild"),
      proc(250, 1, "escapee"),
    ];
    expect((await tracker.survivors()).sort()).toEqual([250]);
  });

  it("does not report group members (they are killed with the group)", async () => {
    const world = [proc(100, 1, "root"), proc(200, 100, "member", 100)];
    const tracker = new ProcessTracker(100, "t", 1_000_000, async () => world);
    await tracker.sample();
    expect(await tracker.survivors()).toEqual([]);
  });
});

describe("Linux tracking by token and session (fix round 2, minor 12)", () => {
  it.skipIf(process.platform !== "linux")(
    "finds a setsid escapee through BROKKR_CHECK_TOKEN in /proc",
    async () => {
      const { spawn } = await import("node:child_process");
      const token = "test-token-" + process.pid;
      const child = spawn("setsid", ["sleep", "5"], {
        env: { ...process.env, BROKKR_CHECK_TOKEN: token },
        detached: true,
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));
      const tracker = new ProcessTracker(999_999_999, token);
      const found = await tracker.survivors();
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // gone
      }
      expect(found.length).toBeGreaterThan(0);
    },
  );
});
