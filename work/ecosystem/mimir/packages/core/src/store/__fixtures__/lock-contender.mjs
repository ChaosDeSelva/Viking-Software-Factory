/* global setTimeout */
// Child process: waits for a shared start time, tries acquireLock, reports, holds briefly.
import { register } from "node:module";
register("./ts-hooks.mjs", import.meta.url);
const { acquireLock } = await import("../lock.ts");

const [dbPath, startAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // spin until the shared start instant so all contenders race together
}
try {
  const lock = acquireLock(dbPath);
  process.stdout.write("won\n");
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, Number(holdMs));
} catch (e) {
  process.stdout.write(`${e?.code ?? "error"}\n`);
  if (e?.code !== "conflict") process.stderr.write(String(e?.stack ?? e));
  process.exit(0);
}
