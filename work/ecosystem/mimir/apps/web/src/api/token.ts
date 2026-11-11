/**
 * The auth token lives in sessionStorage only: never localStorage, never the URL.
 * Closing the tab forgets it. Where the browser blocks storage (it throws), nothing is kept and
 * the caller holds the token in memory for this page.
 */
export const TOKEN_KEY = "mimir.authToken";

export function loadToken(): string | null {
  try {
    const value = sessionStorage.getItem(TOKEN_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, trimmed);
  } catch {
    // Storage blocked: the token lasts for this page only.
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: nothing was stored.
  }
}
