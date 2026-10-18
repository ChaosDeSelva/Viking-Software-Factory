// Writes openapi.json and schemas/event-envelope.json. Run: pnpm --filter @mimir/protocol openapi
import { mkdirSync, writeFileSync } from "node:fs";
import { generateEventEnvelopeJsonSchema, generateOpenApi } from "../src/openapi.js";

const root = new URL("../", import.meta.url);
const write = (rel: string, value: unknown) => {
  const url = new URL(rel, root);
  mkdirSync(new URL("./", url), { recursive: true });
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${url.pathname}`);
};

write("openapi.json", generateOpenApi());
write("schemas/event-envelope.json", generateEventEnvelopeJsonSchema());
