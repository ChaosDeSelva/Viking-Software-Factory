// Regenerates schemas/*.json from the built SDK (run `pnpm --filter @brokkr/sdk build` first).
// The contract tests fail when these files drift from the runtime schemas.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectionJsonSchema,
  verificationEventJsonSchema,
  verificationReportJsonSchema,
} from "../dist/schemas.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
mkdirSync(out, { recursive: true });
const files = {
  "verification-report.v1.json": verificationReportJsonSchema(),
  "verification-event.v1.json": verificationEventJsonSchema(),
  "selection.v1.json": selectionJsonSchema(),
};
for (const [name, schema] of Object.entries(files)) {
  writeFileSync(join(out, name), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${name}`);
}
