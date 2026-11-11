import { describe, expect, it } from "vitest";
import { findCredentialShapes } from "./redaction.js";

describe("findCredentialShapes percent-decoding", () => {
  it("keeps undecodable escapes and still finds encoded userinfo next to them", () => {
    expect(findCredentialShapes("https://user%3Apass@host/%E0%A4")).toContain("url_userinfo");
    expect(findCredentialShapes("plain text %E0%A4 %ZZ")).toEqual([]);
  });
});
