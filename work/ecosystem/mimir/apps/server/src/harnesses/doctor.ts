import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { INTERACTIVE_HARNESSES } from "../terminal-runtime/adapter.js";
const execute = promisify(execFile);
const binaryNames: Record<string, string> = {
  "pi-signed": "pi",
  cursor: "cursor-agent",
  rovo: "acli",
};
export function resolveHarness(
  kind: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!INTERACTIVE_HARNESSES.includes(kind)) throw Error("Unknown harness");
  const bundled =
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  const name =
    env[`MIMIR_${kind.toUpperCase().replaceAll("-", "_")}_BIN`] ??
    (kind === "codex" && existsSync(bundled) ? bundled : (binaryNames[kind] ?? kind));
  const candidates = isAbsolute(name)
    ? [name]
    : (env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((dir) => join(dir, name));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Continue through PATH without executing anything. */
    }
  }
  return null;
}
export async function harnessInventory(versions = false) {
  return Promise.all(
    INTERACTIVE_HARNESSES.map(async (kind) => {
      const executable = resolveHarness(kind);
      let version: string | null = null;
      if (versions && executable) {
        try {
          const result = await execute(executable, ["--version"], {
            timeout: 2000,
            maxBuffer: 16384,
          });
          version = result.stdout.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0] ?? null;
        } catch {
          /* Installed does not imply a compatible version or authenticated account. */
        }
      }
      return {
        kind,
        installed: executable !== null,
        version,
        authenticated: "not_checked",
        observationScope: "controller",
        lifecycleObservation: [
          "claude",
          "gemini",
          "opencode",
          "pi",
          "pi-signed",
          "omp",
          "devin",
          "commandcode",
          "agy",
          "rovo",
        ].includes(kind)
          ? "automatic_events"
          : kind === "codex"
            ? "turn_end_notification"
            : ["kimi", "grok"].includes(kind)
              ? "acp_protocol"
              : ["cursor", "muse"].includes(kind)
                ? "session_transcript"
                : "process_and_terminal_only",
        interactive: true,
        headless: ["codex", "claude", "opencode", "gemini", "pi"].includes(kind),
        experimental: !["codex", "claude"].includes(kind),
      };
    }),
  );
}
