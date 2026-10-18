import { beforeEach, describe, expect, it } from "vitest";
import { clearToken, loadToken, saveToken, TOKEN_KEY } from "./token.js";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("token storage", () => {
  it("returns null when no token was saved", () => {
    expect(loadToken()).toBeNull();
  });

  it("stores the token in sessionStorage only", () => {
    saveToken("  abc123  ");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("abc123");
    expect(localStorage.length).toBe(0);
    expect(loadToken()).toBe("abc123");
  });

  it("ignores empty tokens", () => {
    saveToken("   ");
    expect(loadToken()).toBeNull();
  });

  it("clears the token", () => {
    saveToken("abc");
    clearToken();
    expect(loadToken()).toBeNull();
  });
});
