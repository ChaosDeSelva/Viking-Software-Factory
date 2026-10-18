import { sanitizeForDisplay } from "@sindri/intake";

/**
 * Deep-copy a response payload with every string passed through `sanitizeForDisplay`
 * (HTML/script removal, control, bidi and zero-width characters). All ticket, repo and
 * model-derived text reaches clients only through this.
 */
export function forDisplay<T>(value: T): T {
  if (typeof value === "string") return sanitizeForDisplay(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => forDisplay(v)) as T;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, forDisplay(v)]),
    ) as T;
  return value;
}

/**
 * Route config key: the route's successful responses carry only text that was sanitized when it
 * was stored (intakes, audit M5), so the global response sanitizer skips them.
 */
export const DISPLAY_SANITIZED = "displaySanitized";
