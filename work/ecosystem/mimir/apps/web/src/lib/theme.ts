/**
 * Theme lives in @factory/ui (`useTheme`, key `factory-theme`, `<html data-theme>`), shared with the
 * other factory apps. This only carries an operator's old Mimir choice over once; index.html does
 * the same before first paint.
 */
const LEGACY_KEY = "mimir.theme";
const KEY = "factory-theme";

export function migrateLegacyTheme(): void {
  try {
    const old = localStorage.getItem(LEGACY_KEY);
    if (old === null) return;
    localStorage.removeItem(LEGACY_KEY);
    // "system" is the shared default (no stored key); garbage is dropped.
    if ((old === "light" || old === "dark") && localStorage.getItem(KEY) === null) {
      localStorage.setItem(KEY, old);
    }
  } catch {
    // Storage blocked (private mode): the theme follows the system.
  }
}
