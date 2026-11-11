import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  userInfo: () => {
    throw new Error("no passwd entry");
  },
}));

const { ApprovalAuthority } = await import("./approval.js");

describe("ApprovalAuthority without an OS user name", () => {
  it("names the principal 'user' when the OS cannot say who runs the server", () => {
    const a = new ApprovalAuthority({ pairingCode: "ABCDE-FGH23" });
    expect(a.mint("abcde fgh23", "cli").principal).toMatch(/^local:user\/cli#aps_[0-9a-f]{12}$/);
  });
});
