import { startMimir } from "./start.js";

const mimir = await startMimir(process.env);
const { logger, auth } = mimir;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await mimir.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`mimir server listening on ${mimir.url}`);
console.log(
  auth.path === null
    ? "auth token: from MIMIR_AUTH_TOKEN"
    : `auth token: ${auth.path}${auth.source === "generated" ? " (generated)" : ""}`,
);
console.log(
  `runtime: ${mimir.config.runtime}  data: ${mimir.config.dataDir}  tick: ${mimir.config.tickMs}ms`,
);
