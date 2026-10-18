import { spawn } from "node:child_process";

/** SSH policy adapted from upstream terminal helpers bin/fm-on.sh at a24f4cb873d87295dddbc521599c21ea86d6dc00.
 * Copyright (c) 2026 Kun Chen. MIT; see third_party/terminal-bridge/LICENSE.
 * Structured stdin and response framing below are Mimir-specific.
 */
export type SshRoute = { host: string; root: string; backend?: "tmux-interactive" };
export type RemoteRequest = {
  operation: "health" | "submit" | "inspect" | "cancel" | "input" | "keys";
  jobId?: string;
  payload?: Record<string, unknown>;
};
export type TransportResult =
  | { state: "confirmed"; response: Record<string, unknown> }
  | { state: "unknown"; reason: string }
  | { state: "unavailable"; reason: string };

export function sshArguments(route: SshRoute): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(route.host))
    throw new Error("Use an SSH configuration alias or hostname, not a command or user@host");
  if (
    !route.root.startsWith("/") ||
    Array.from(route.root).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    route.root.split("/").some((part, index) => index > 0 && ["", ".", ".."].includes(part))
  )
    throw new Error("Remote root must be a normalized absolute directory");
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "SendEnv=-*",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    route.host,
    "mimir-remote-entrypoint",
  ];
}

/** Never retries or falls back to a local process. The caller reconciles unknown completion. */
export async function sshRequest(
  route: SshRoute,
  request: RemoteRequest,
  options: { executable?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<TransportResult> {
  const args = sshArguments(route);
  if (!["health", "submit", "inspect", "cancel", "input", "keys"].includes(request.operation))
    throw new Error("Unsupported remote operation");
  if (request.operation !== "health" && !/^[A-Za-z0-9_-]{1,128}$/.test(request.jobId ?? ""))
    throw new Error("A stable safe job ID is required");
  const body = JSON.stringify({ protocol: 1, root: route.root, ...request });
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("Remote request exceeds 16 MiB");
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new Error("Transport bounds must be positive integers");
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0),
      bytes = 0,
      reason: string | undefined,
      settled = false;
    const child = spawn(options.executable ?? "ssh", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      reason = "SSH deadline exceeded; remote completion must be reconciled";
      child.kill("SIGKILL");
    }, timeoutMs);
    const receive = (data: Buffer, isOutput: boolean) => {
      bytes += data.length;
      if (bytes > maxBytes) {
        reason = "SSH response exceeded the output limit; remote completion is unknown";
        child.kill("SIGKILL");
      } else if (isOutput) stdout = Buffer.concat([stdout, data]);
    };
    child.stdout.on("data", (data: Buffer) => receive(data, true));
    child.stderr.on("data", (data: Buffer) => receive(data, false));
    child.stdin.on("error", () => {
      /* close establishes the outcome; EPIPE is not proof of failure */
    });
    child.on("error", () =>
      finish({ state: "unavailable", reason: "Could not start the local SSH executable" }),
    );
    child.on("close", (code) => {
      if (reason || code !== 0) {
        finish({
          state: "unknown",
          reason: reason ?? `SSH exited ${code ?? "by signal"}; reconcile the same remote job`,
        });
        return;
      }
      try {
        const response: unknown = JSON.parse(stdout.toString("utf8"));
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response) ||
          !("protocol" in response) ||
          response.protocol !== 1
        )
          throw new Error("Invalid protocol response");
        finish({ state: "confirmed", response: response as Record<string, unknown> });
      } catch {
        finish({ state: "unknown", reason: "Remote response was not a valid protocol envelope" });
      }
    });
    child.stdin.end(body + "\n");
  });
}
