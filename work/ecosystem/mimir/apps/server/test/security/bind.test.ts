import { existsSync } from "node:fs";
import { join } from "node:path";
import { runMimirToExit } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN, serverSpawn, tempDataDir } from "../chaos/support.js";

const dirs: { cleanup: () => void }[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

describe("security: non-loopback bind is refused by main.ts", () => {
  it.each([
    ["all interfaces (IPv4)", { MIMIR_HOST: "0.0.0.0" }],
    ["all interfaces (IPv6)", { MIMIR_HOST: "::" }],
    ["a LAN address", { MIMIR_HOST: "192.0.2.10" }],
    ["a hostname", { MIMIR_HOST: "mimir.example" }],
    ["remote allowed but no TLS", { MIMIR_HOST: "192.0.2.10", MIMIR_ALLOW_REMOTE: "1" }],
    [
      "all interfaces with remote and TLS but no public origin",
      {
        MIMIR_HOST: "0.0.0.0",
        MIMIR_ALLOW_REMOTE: "1",
        MIMIR_TLS_CERT: "/nonexistent/cert.pem",
        MIMIR_TLS_KEY: "/nonexistent/key.pem",
      },
    ],
  ])("%s → exits non-zero before listening or touching the data dir", async (_label, env) => {
    const tmp = tempDataDir();
    dirs.push(tmp);
    const dataDir = join(tmp.dir, "data");
    const r = await runMimirToExit(serverSpawn(MAIN, dataDir, env));
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/Refusing to bind|binds every interface/);
    expect(r.output).not.toMatch(/listening on/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("IPv4-mapped public, decimal-loopback (not normalised) and nip.io spellings are refused", async () => {
    for (const host of ["::ffff:192.0.2.10", "2130706433", "127.0.0.1.nip.io"]) {
      const tmp = tempDataDir();
      dirs.push(tmp);
      const r = await runMimirToExit(
        serverSpawn(MAIN, join(tmp.dir, "data"), { MIMIR_HOST: host, MIMIR_PORT: "0" }),
      );
      const detail = `host=${host} code=${String(r.code)} output=${r.output}`;
      expect(r.code, detail).not.toBe(0);
      expect(r.output, detail).not.toMatch(/listening on/);
    }
  }, 30_000);
});
