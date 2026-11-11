import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function harness() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  mocks.spawn.mockReturnValue(child);
  const handlers = new Map<string, (...args: unknown[]) => void>();
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...args: unknown[]) => void) => {
    handlers.set(event, fn);
    return process;
  }) as typeof process.on);
  const send = vi.fn((_message: unknown, callback?: () => void) => {
    void _message;
    callback?.();
    return true;
  });
  const originalSend = process.send;
  const originalConnected = process.connected;
  process.send = send as NonNullable<typeof process.send>;
  process.connected = true;
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const disconnect = vi.spyOn(process, "disconnect").mockImplementation(() => {});
  await import("./worker.js");
  return {
    child,
    send,
    kill,
    exit,
    disconnect,
    message: (value: unknown) => handlers.get("message")!(value),
    disconnected: () => handlers.get("disconnect")!(),
    restore: () => {
      if (originalSend) process.send = originalSend;
      else delete process.send;
      process.connected = originalConnected;
    },
  };
}

it("bounds output and time, forwards exit, and kills the process group on parent loss", async () => {
  const h = await harness();
  try {
    h.message({
      kind: "start",
      executable: "agent",
      args: [],
      cwd: "/tmp",
      env: {},
      timeoutMs: 100,
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "agent",
      [],
      expect.objectContaining({ detached: true, shell: false }),
    );
    h.child.stdout.emit("data", Buffer.from("hello"));
    h.child.stderr.emit("data", Buffer.from("error"));
    expect(h.send).toHaveBeenCalledWith({ kind: "output", text: "hello", stderr: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.send).toHaveBeenCalledWith({ kind: "timeout" });
    expect(h.kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    h.child.stdout.emit("data", Buffer.alloc(33 * 1024 * 1024));
    expect(h.send).toHaveBeenCalledWith({ kind: "limit" });
    h.child.emit("error", new Error("spawn failed"));
    expect(h.send).toHaveBeenCalledWith({ kind: "error" });
    h.child.emit("close", 1);
    expect(h.send).toHaveBeenCalledWith({ kind: "exit", code: 1 }, expect.any(Function));
    expect(h.disconnect).toHaveBeenCalled();
    h.disconnected();
    expect(h.exit).toHaveBeenCalledWith(0);
  } finally {
    h.restore();
  }
});

it("escalates a soft stop and supports immediate force stop", async () => {
  const h = await harness();
  try {
    h.message({ kind: "ignored" });
    h.message({ kind: "start", executable: "agent", args: [], cwd: "/tmp", env: {} });
    h.message({ kind: "stop" });
    expect(h.kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    h.message({ kind: "stop", force: true });
    expect(h.kill).toHaveBeenLastCalledWith(-12345, "SIGKILL");
  } finally {
    h.restore();
  }
});

it("does nothing to a missing agent and sends nothing once the parent is gone", async () => {
  const h = await harness();
  try {
    // A stop before any start has no process group to signal.
    h.message({ kind: "stop", force: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.kill).not.toHaveBeenCalled();
    h.message({ kind: "start", executable: "agent", args: [], cwd: "/tmp", env: {} });
    // A second start never launches a second agent.
    h.message({ kind: "start", executable: "other", args: [], cwd: "/tmp", env: {} });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    h.kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(() => h.message({ kind: "stop" })).not.toThrow();
    // The parent disconnected while the exit message was queued: no disconnect twice.
    h.send.mockImplementationOnce((_message: unknown, callback?: () => void) => {
      process.connected = false;
      callback?.();
      return true;
    });
    h.child.emit("close", null);
    expect(h.send).toHaveBeenLastCalledWith({ kind: "exit", code: 1 }, expect.any(Function));
    expect(h.disconnect).not.toHaveBeenCalled();
    // Disconnected: neither output nor a later close reaches the (absent) parent.
    const sent = h.send.mock.calls.length;
    h.child.stdout.emit("data", Buffer.from("late"));
    h.child.emit("close", 0);
    expect(h.send).toHaveBeenCalledTimes(sent);
  } finally {
    h.restore();
  }
});

it("forwards characters split across output chunks intact, per stream", async () => {
  const h = await harness();
  try {
    h.message({ kind: "start", executable: "agent", args: [], cwd: "/tmp", env: {} });
    const bytes = Buffer.from("café ü");
    h.child.stdout.emit("data", bytes.subarray(0, 4));
    h.child.stderr.emit("data", Buffer.from("ü").subarray(0, 1));
    h.child.stdout.emit("data", bytes.subarray(4));
    h.child.stderr.emit("data", Buffer.from("ü").subarray(1));
    const text = (stderr: boolean) =>
      h.send.mock.calls
        .map(([m]) => m as { kind: string; text?: string; stderr?: boolean })
        .filter((m) => m.kind === "output" && m.stderr === stderr)
        .map((m) => m.text)
        .join("");
    expect(text(false)).toBe("café ü");
    expect(text(true)).toBe("ü");
  } finally {
    h.restore();
  }
});
