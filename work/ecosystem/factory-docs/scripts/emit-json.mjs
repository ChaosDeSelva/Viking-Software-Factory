// Writes the JSON entry points from the compiled package.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const mod = await import(join(dist, "index.js"));
const write = (name, value) =>
  writeFileSync(join(dist, name), JSON.stringify(value, null, 2) + "\n");
write("glossary.json", mod.glossary);
write("docs.json", mod.docsIndex);
write("statuses.json", mod.statuses);
