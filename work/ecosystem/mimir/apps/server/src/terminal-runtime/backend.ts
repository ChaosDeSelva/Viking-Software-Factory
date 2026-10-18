import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const run = promisify(execFile);
export type BackendName = "tmux-interactive" | "zellij" | "cmux" | "orca";
export interface TerminalBackend {
  name: string;
  health(): Promise<boolean>;
  create(label: string, cwd: string): Promise<string>;
  send(target: string, text: string, label: string): Promise<void>;
  key(target: string, key: string, label: string): Promise<void>;
  capture(target: string, lines: number, label: string): Promise<string>;
  close(target: string, label: string): Promise<void>;
}
export class NativeTerminalBackend implements TerminalBackend {
  private socket: string;
  constructor(
    readonly name: BackendName,
    private readonly home: string,
  ) {
    this.socket = "mimir-" + createHash("sha256").update(home).digest("hex").slice(0, 12);
  }
  private async command(operation: string, args: string[] = []) {
    if (this.name === "tmux-interactive")
      return (
        await run(
          process.env["MIMIR_TMUX_BIN"] ?? "tmux",
          ["-L", this.socket, "-f", "/dev/null", ...args],
          { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
        )
      ).stdout;
    const bridge = fileURLToPath(
      new URL("../../../../third_party/firstmate/bridge.sh", import.meta.url),
    );
    return (
      await run("bash", [bridge, this.name, operation, this.home, ...args], {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  }
  async health() {
    try {
      const output = await this.command("health", this.name === "tmux-interactive" ? ["-V"] : []);
      return this.name !== "cmux" || !/(denied|unauth|unavailable|not.running)/i.test(output);
    } catch {
      return false;
    }
  }
  async create(label: string, cwd: string) {
    const output = await this.command(
      "create",
      this.name === "tmux-interactive"
        ? ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", label, "-c", cwd, "/bin/sh"]
        : [label, cwd],
    );
    const target = output.trim();
    if (!target || target.includes("\n") || target.length > 256)
      throw new Error("Invalid terminal target");
    return target;
  }
  private async guard(target: string, label: string) {
    if (this.name === "tmux-interactive") {
      const name = (
        await this.command("inspect", ["display-message", "-p", "-t", target, "#{session_name}"])
      ).trim();
      if (name !== label) throw new Error("Terminal identity changed");
    }
  }
  async send(target: string, text: string, label: string) {
    await this.guard(target, label);
    if (this.name === "tmux-interactive") {
      await this.command("send", ["send-keys", "-t", target, "-l", "--", text]);
      await this.command("key", ["send-keys", "-t", target, "Enter"]);
    } else await this.command("send", [target, text, label]);
  }
  async key(target: string, key: string, label: string) {
    if (!["Enter", "Escape", "C-c", "C-d", "C-z", "Up", "Down", "Tab"].includes(key))
      throw new Error("Unsupported key");
    if (this.name === "orca" && key === "Escape") throw new Error("Orca does not expose Escape");
    await this.guard(target, label);
    await this.command(
      "key",
      this.name === "tmux-interactive" ? ["send-keys", "-t", target, key] : [target, key, label],
    );
  }
  async capture(target: string, lines: number, label: string) {
    await this.guard(target, label);
    return this.command(
      "capture",
      this.name === "tmux-interactive"
        ? ["capture-pane", "-p", "-t", target, "-S", String(-lines)]
        : [target, String(lines), label],
    );
  }
  async close(target: string, label: string) {
    await this.guard(target, label);
    await this.command(
      "close",
      this.name === "tmux-interactive" ? ["kill-session", "-t", label] : [target, label],
    );
  }
}
