import { writeFileSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeHook } from "./hooks.js";
// Hook stdin may include secret tool arguments. Persist only normalized lifecycle facts.
const file = process.argv[2];
if (!file || !isAbsolute(file)) throw new Error("An absolute hook observation path is required");
let input = process.argv[3] ?? "";
if (!input)
  for await (const part of process.stdin) {
    input += part.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error("Hook input limit exceeded");
  }
if (Buffer.byteLength(input) > 65536) throw new Error("Hook input limit exceeded");
const observation = normalizeHook(JSON.parse(input));
if (observation) {
  const temp = file + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(observation), { mode: 0o600 });
  renameSync(temp, file);
}
