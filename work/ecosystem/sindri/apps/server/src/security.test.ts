import { describe, expect, it } from "vitest";
import { hostnameOf, isLoopbackHostHeader, tokenMatches } from "./security.js";

describe("security helpers", () => {
  it("reads the hostname of a Host header, IPv6 literals included", () => {
    expect(hostnameOf(undefined)).toBe("");
    expect(hostnameOf("")).toBe("");
    expect(hostnameOf(" LocalHost:7800 ")).toBe("localhost");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:7800")).toBe("[::1]");
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader("[::1]:1")).toBe(true);
    expect(isLoopbackHostHeader("127.0.0.1.evil.example")).toBe(false);
  });

  it("accepts only a well-formed bearer token equal to the expected one", () => {
    expect(tokenMatches(undefined, "t")).toBe(false);
    expect(tokenMatches("Bearer ", "t")).toBe(false);
    expect(tokenMatches("Bearer a b", "a")).toBe(false);
    expect(tokenMatches("Bearer abc", "abc")).toBe(true);
  });
});
