import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Built-in harness library: `BROKKR_BUILTIN_HARNESSES`, else the copy shipped
 * inside an installed package (`<pkg>/harnesses`), else the source repository
 * (`<repo>/harnesses`). Resolved from both `src/` and `dist/`.
 */
export function defaultBuiltinDir(
  env: Record<string, string | undefined>,
  base: string = import.meta.url,
): string {
  if (env.BROKKR_BUILTIN_HARNESSES) return env.BROKKR_BUILTIN_HARNESSES;
  const packaged = fileURLToPath(new URL("../harnesses", base));
  const repo = fileURLToPath(new URL("../../../harnesses", base));
  return existsSync(packaged) ? packaged : repo;
}

export const CLI_VERSION = "0.1.0";
