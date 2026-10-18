import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorStore } from "./store.js";
import { MissionBrain, decisionText } from "./brain.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-"));
  let now = 100000;
  const store = new SupervisorStore(join(root, "db"), () => now);
  store.register("parent");
  store.register("child", "parent");
  store.configure("child", {
    missionId: "mission",
    agentKind: "codex",
    enabled: true,
    intervalMs: 30000,
    maxTurns: 2,
  });
  store.queueThought("child", "Check");
  const lease = store.acquire("child", "one")!;
  const message = store.claim(lease)!;
  return {
    store,
    lease,
    message,
    advance: () => {
      now += 20000;
    },
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const context = () => ({
  mission: { id: "mission" },
  tasks: [],
  sessionIds: ["allowed"],
  sessions: [],
});
describe("bounded mission decisions", () => {
  it("rejects the entire proposal when one session is outside the mission", async () => {
    const f = fixture();
    try {
      const brain = new MissionBrain(f.store, context, async () => ({
        report: "check",
        actions: [
          { kind: "observe", sessionId: "allowed" },
          { kind: "input", sessionId: "foreign", text: "bad" },
        ],
      }));
      await expect(brain.execute(f.message, f.lease)).rejects.toThrow("outside its mission");
      expect(f.store.messages("child")).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it("does not dispatch after parent hold during inference", async () => {
    const f = fixture();
    try {
      const brain = new MissionBrain(f.store, context, async () => {
        f.store.setState("parent", "held", "operator review");
        return { report: "check", actions: [{ kind: "observe", sessionId: "allowed" }] };
      });
      expect(await brain.execute(f.message, f.lease)).toContain("discarded");
      expect(f.store.messages("child")).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it("fences an expired model turn before any action is queued", async () => {
    const f = fixture();
    try {
      const brain = new MissionBrain(f.store, context, async () => {
        f.advance();
        f.store.acquire("child", "new-owner");
        return { report: "check", actions: [{ kind: "observe", sessionId: "allowed" }] };
      });
      await expect(brain.execute(f.message, f.lease)).rejects.toThrow("ownership changed");
      expect(f.store.messages("child")).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it("persists scoped actions and enforces the durable turn budget", async () => {
    const f = fixture();
    try {
      const brain = new MissionBrain(f.store, context, async () => ({
        report: "check",
        actions: [{ kind: "observe", sessionId: "allowed" }],
      }));
      const result = await brain.execute(f.message, f.lease);
      expect(f.store.messages("child")).toHaveLength(2);
      f.store.finish(f.lease, f.message.id, "done", result);
      expect(f.store.queueThought("child", "again")).toBe(true);
      const next = f.store.messages("child").find((m) => m.id.endsWith(":2"))!;
      expect(next.kind).toBe("think");
      expect(f.store.queueThought("child", "over budget")).toBe(false);
    } finally {
      f.close();
    }
  });
  it("requires human authorization before model-proposed terminal input", async () => {
    const f = fixture();
    try {
      const brain = new MissionBrain(f.store, context, async () => ({
        report: "Suggest follow-up",
        actions: [{ kind: "input", sessionId: "allowed", text: "Continue the approved task" }],
      }));
      await brain.execute(f.message, f.lease);
      const proposal = f.store.messages("child").find((m) => m.kind === "input")!;
      expect(proposal.state).toBe("awaiting_approval");
      expect(f.store.claim(f.lease)).toBeNull();
      f.store.authorize("child", proposal.id, true, "Reviewed target and text");
      expect(f.store.claim(f.lease)?.id).toBe(proposal.id);
    } finally {
      f.close();
    }
  });
  it("extracts decisions from both harness stream formats", () => {
    expect(decisionText('{"type":"result","result":"{}"}')).toBe("{}");
    expect(
      decisionText('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'),
    ).toBe("{}");
  });
});
