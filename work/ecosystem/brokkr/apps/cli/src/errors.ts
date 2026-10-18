import { BrokkrError, EXIT_CODES } from "@brokkr/core";
import type { CliIO } from "./io.js";

/** Print an error (JSON on stdout when --json, message on stderr always) and return its exit code. */
export function reportError(error: unknown, io: CliIO, json: boolean): number {
  if (error instanceof BrokkrError) {
    if (json) {
      io.stdout(
        `${JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, null, 2)}\n`,
      );
    }
    io.stderr(`error: ${error.message}\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) io.stdout(`${JSON.stringify({ error: { code: "infra", message } }, null, 2)}\n`);
  io.stderr(`error: ${message}\n`);
  return EXIT_CODES.infraError;
}
