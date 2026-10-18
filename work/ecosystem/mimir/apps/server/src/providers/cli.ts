#!/usr/bin/env node
import { ExeProvider, exePlan } from "./exe.js";
import { homedir } from "node:os";
import { join } from "node:path";
const [action, name, key] = process.argv.slice(2);
if (action === "plan") console.log(JSON.stringify(exePlan({ name: name ?? "" }), null, 2));
else if (action === "list" || action === "create") {
  if (action === "create" && (!name || !key))
    throw Error("Usage: exe-worker.mjs create <name> <stable-request-key>");
  const provider = new ExeProvider(
    process.env["EXE_TOKEN"] ?? "",
    join(process.env["MIMIR_DATA_DIR"] ?? join(homedir(), ".mimir"), "exe-receipts.json"),
  );
  console.log(
    JSON.stringify(
      action === "list" ? await provider.inventory() : await provider.create({ name: name! }, key!),
      null,
      2,
    ),
  );
} else throw Error("Usage: exe-worker.mjs {plan <name>|list|create <name> <stable-request-key>}");
