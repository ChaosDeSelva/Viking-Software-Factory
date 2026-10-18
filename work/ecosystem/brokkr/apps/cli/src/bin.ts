#!/usr/bin/env node
import { exitWith, CLI_EXIT_CODES } from "./exit.js";
import { run } from "./run.js";

// First SIGINT/SIGTERM: abort the running command so it can stop its child
// processes and keep partial evidence. A second signal (or a stuck command)
// exits immediately with 130. Cancellation is bounded (1 s SIGTERM grace, bounded
// pipe drain), so the partial report is normally written long before the 30 s cap.
const controller = new AbortController();
let signals = 0;
const onSignal = (): void => {
  signals++;
  if (signals > 1) exitWith(CLI_EXIT_CODES.interrupted);
  controller.abort();
  setTimeout(() => exitWith(CLI_EXIT_CODES.interrupted), 30_000).unref();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const code = await run(process.argv.slice(2), { signal: controller.signal });
exitWith(code);
