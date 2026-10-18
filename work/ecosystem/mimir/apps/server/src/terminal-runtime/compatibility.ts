import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MimirError } from "@mimir/protocol";
const run = promisify(execFile);
/** The two Kimi CLIs assign different approval semantics to the same flag. */
export function acceptsKimiPrompt(help: string): boolean {
  return (
    help.includes("--config-file") &&
    help.includes("--wire") &&
    help.includes("--print") &&
    !help.includes("--auto ") &&
    !help.includes("Never Ask")
  );
}
export async function verifyInteractiveLaunch(kind: string, executable: string) {
  if (kind !== "kimi") return;
  let supported = false;
  try {
    const { stdout, stderr } = await run(executable, ["--help"], {
      timeout: 5000,
      maxBuffer: 65536,
    });
    supported = acceptsKimiPrompt(stdout + stderr);
  } catch {
    /* An unverified CLI must not inherit another version's approval contract. */
  }
  if (!supported)
    throw new MimirError(
      "capability_unavailable",
      "This Kimi CLI is not compatible with the permission-preserving launch profile. The newer kimi-code --prompt mode skips approval. Use a supported agent until its interactive transport is available.",
    );
}
