import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Built-in harness library. An installed tarball ships it next to `dist/`
 * (`<pkg>/harnesses`); in the source repository it is `<repo>/harnesses`.
 */
export function defaultBuiltinDir(base: string = import.meta.url): string {
  const packaged = fileURLToPath(new URL("../harnesses", base));
  const repo = fileURLToPath(new URL("../../../harnesses", base));
  return existsSync(packaged) ? packaged : repo;
}
