/**
 * The auth token lives in sessionStorage only: never localStorage, never the URL.
 * Closing the tab forgets it.
 */
export const TOKEN_KEY = "mimir.authToken";

export function loadToken(): string | null {
  const value = sessionStorage.getItem(TOKEN_KEY);
  return value && value.length > 0 ? value : null;
}

export function saveToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  sessionStorage.setItem(TOKEN_KEY, trimmed);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
