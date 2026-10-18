import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

export interface ValidationIssue {
  /** Dotted path into the document, e.g. `checks.0.command`. Empty for the document root. */
  path: string;
  message: string;
  file?: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Validate an already-parsed value against a schema, returning dotted-path issues. */
export function validateWith<S extends z.ZodType>(
  schema: S,
  input: unknown,
  file?: string,
): ValidationResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const keys = (issue as { keys?: string[] }).keys;
      const message = keys?.length ? `${issue.message}: ${keys.join(", ")}` : issue.message;
      return {
        path: issue.path.map(String).join("."),
        message,
        ...(file === undefined ? {} : { file }),
      };
    }),
  };
}

/** Parse YAML (default) or JSON (by `.json` extension) text and validate it. Never throws. */
export function parseManifestText<S extends z.ZodType>(
  text: string,
  schema: S,
  file: string,
): ValidationResult<z.infer<S>> {
  let data: unknown;
  try {
    data = extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const kind = extname(file).toLowerCase() === ".json" ? "JSON" : "YAML";
    return {
      ok: false,
      issues: [{ path: "", message: `${kind} parse error: ${(error as Error).message}`, file }],
    };
  }
  return validateWith(schema, data, file);
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((i) => `${i.file ? `${i.file}: ` : ""}${i.path === "" ? "(root)" : i.path}: ${i.message}`)
    .join("\n");
}
