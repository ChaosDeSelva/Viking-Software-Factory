import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { normalizeHook } from "./hooks.js";
import { vendorEvent } from "./vendor-hooks.js";
const [file, kind, event] = process.argv.slice(2);
// A project plugin may be discovered outside this launch. It must be inert there.
if (file && isAbsolute(file) && process.env.MIMIR_HOOK_FILE === file && kind && event) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw Error("Hook payload exceeds 64 KiB");
  }
  const payload = input.trim() ? JSON.parse(input) : {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Hook payload must be an object");
  let owned = true;
  if (kind === "agy") {
    const identityFile = file + ".conversation";
    const identity = payload.conversationId;
    if (typeof identity !== "string" || !identity || identity.length > 1024) owned = false;
    else {
      if (event === "SessionStart" && !existsSync(identityFile)) {
        try {
          writeFileSync(identityFile, identity, { mode: 0o600, flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      owned = existsSync(identityFile) && readFileSync(identityFile, "utf8") === identity;
    }
  }
  const type = owned ? vendorEvent(kind, event, payload) : null;
  const observation = type ? normalizeHook({ type }) : null;
  if (observation) {
    const temporary = file + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, file);
  }
}
// Observational AGY events accept an empty response; never inject steps or override approvals.
if (kind === "agy") process.stdout.write("{}\n");
