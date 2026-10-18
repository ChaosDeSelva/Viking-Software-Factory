/**
 * Chaos fixture: the real server boot (`startMimir`, exactly as `main.ts`, with
 * `MIMIR_RUNTIME=fake`), except that fake sessions never finish on their own: they reach
 * `running` and stay there. That makes "SIGKILL while tasks are running" deterministic instead of
 * a race against the default fake script (which completes a session about 1.3 s after it starts).
 * The fake runtime lives in the server process, so a SIGKILL also takes every session with it,
 * as a host crash would.
 */
import { DEFAULT_SCRIPT, type ScriptStep } from "@mimir/fake-runtime";
import { startMimir } from "../../../src/start.js";

(DEFAULT_SCRIPT as ScriptStep[]).splice(0, DEFAULT_SCRIPT.length, {
  afterMs: 100,
  state: "running",
});

const mimir = await startMimir(process.env);
console.log(`mimir server listening on ${mimir.url}`);
