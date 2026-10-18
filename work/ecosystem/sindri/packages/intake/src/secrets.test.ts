import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  EnvSecretStore,
  FileSecretStore,
  KeychainSecretStore,
  resolveSecret,
  type CommandRunner,
  type SecretHandle,
  type SecretSource,
} from "./secrets.js";

describe("EnvSecretStore", () => {
  it("maps keys to prefixed upper-case env vars", async () => {
    const s = new EnvSecretStore({ env: { SINDRI_SECRET_JIRA_API_TOKEN: "tok" } });
    expect(await s.get("jira.api-token")).toBe("tok");
    expect(await s.get("missing")).toBeUndefined();
  });
});

describe("KeychainSecretStore", () => {
  it("calls `security find-generic-password` with an argument array (no shell)", async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "s3cr3t\n" };
    };
    const s = new KeychainSecretStore({ service: "sindri", run });
    expect(await s.get("jira; rm -rf /")).toBe("s3cr3t");
    expect(calls).toEqual([
      {
        cmd: "/usr/bin/security",
        args: ["find-generic-password", "-s", "sindri", "-a", "jira; rm -rf /", "-w"],
      },
    ]);
  });

  it("returns undefined when the item is not found (exit 44)", async () => {
    const s = new KeychainSecretStore({ run: async () => ({ code: 44, stdout: "" }) });
    expect(await s.get("x")).toBeUndefined();
  });

  it("throws a generic error on other failures", async () => {
    const s = new KeychainSecretStore({ run: async () => ({ code: 1, stdout: "" }) });
    await expect(s.get("x")).rejects.toThrow(/keychain lookup failed/);
  });
});

describe("FileSecretStore", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmpFile = () => {
    const d = mkdtempSync(join(tmpdir(), "sindri-secrets-"));
    dirs.push(d);
    return join(d, "secrets.enc");
  };

  it("round-trips secrets encrypted at rest with owner-only permissions", async () => {
    const path = tmpFile();
    const s = new FileSecretStore({ path, passphrase: "correct horse" });
    await s.set("linear.apiKey", "lin_api_SUPERSECRET");
    await s.set("jira.apiToken", "ATATT-SECRET");
    expect(await s.get("linear.apiKey")).toBe("lin_api_SUPERSECRET");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("SUPERSECRET");
    expect(raw).not.toContain("linear.apiKey");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: { name: "scrypt" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new FileSecretStore({ path, passphrase: "correct horse" });
    expect(await reopened.keys()).toEqual(["jira.apiToken", "linear.apiKey"]);
    await reopened.delete("jira.apiToken");
    expect(await reopened.get("jira.apiToken")).toBeUndefined();
  });

  it("rejects a wrong passphrase without leaking contents", async () => {
    const path = tmpFile();
    await new FileSecretStore({ path, passphrase: "right" }).set("k", "VALUE123");
    const wrong = new FileSecretStore({ path, passphrase: "wrong" });
    const err = await wrong.get("k").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/passphrase|decrypt/i);
    expect((err as Error).message).not.toContain("VALUE123");
  });

  it("M13: refuses unbounded scrypt parameters from a tampered file", async () => {
    const path = tmpFile();
    await new FileSecretStore({ path, passphrase: "p" }).set("k", "v");
    const file = JSON.parse(readFileSync(path, "utf8")) as { kdf: { N: number } };
    file.kdf.N = 2 ** 30;
    writeFileSync(path, JSON.stringify(file));
    await expect(new FileSecretStore({ path, passphrase: "p" }).get("k")).rejects.toThrow(
      /unsupported/,
    );
  });

  it("returns undefined for a missing file", async () => {
    expect(
      await new FileSecretStore({ path: tmpFile(), passphrase: "p" }).get("k"),
    ).toBeUndefined();
  });
});

describe("resolveSecret", () => {
  it("accepts only a store handle and errors on a missing secret", async () => {
    const store = new EnvSecretStore({ env: { SINDRI_SECRET_A: "v" } });
    expectTypeOf<SecretSource>().toEqualTypeOf<SecretHandle>();
    expectTypeOf<string>().not.toExtend<SecretSource>();
    // @ts-expect-error literal credentials are not accepted
    await expect(resolveSecret("lit")).rejects.toThrow(/SecretStore handle/);
    expect(await resolveSecret({ store, key: "a" })).toBe("v");
    await expect(resolveSecret({ store, key: "b" })).rejects.toThrow(/secret "b" not found/);
  });
});
