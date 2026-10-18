import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

/** Read-only access to named credentials. Implementations must never log values. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
}

export interface WritableSecretStore extends SecretStore {
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** A reference to a credential held in a SecretStore. Literal credentials are not accepted. */
export interface SecretHandle {
  store: SecretStore;
  key: string;
}

/** Credentials always come from a SecretStore. */
export type SecretSource = SecretHandle;

/** Runtime guard for untyped callers: throws unless `source` is a `{ store, key }` handle. */
export function assertSecretHandle(
  source: unknown,
  what = "credential",
): asserts source is SecretHandle {
  const h = source as Partial<SecretHandle> | null;
  if (
    typeof h !== "object" ||
    h === null ||
    typeof h.key !== "string" ||
    typeof h.store?.get !== "function"
  ) {
    throw new TypeError(`${what} must be a SecretStore handle { store, key }, not a literal`);
  }
}

export async function resolveSecret(source: SecretSource): Promise<string> {
  assertSecretHandle(source);
  const value = await source.store.get(source.key);
  if (value === undefined || value === "") throw new Error(`secret "${source.key}" not found`);
  return value;
}

// ---------------------------------------------------------------------------- env

export interface EnvSecretStoreOptions {
  env?: Record<string, string | undefined>;
  /** Default "SINDRI_SECRET_". Key "jira.api-token" -> SINDRI_SECRET_JIRA_API_TOKEN. */
  prefix?: string;
}

export class EnvSecretStore implements SecretStore {
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;
  constructor(options: EnvSecretStoreOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? "SINDRI_SECRET_";
  }
  static varName(key: string, prefix = "SINDRI_SECRET_"): string {
    return prefix + key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  }
  async get(key: string): Promise<string | undefined> {
    const v = this.#env[EnvSecretStore.varName(key, this.#prefix)];
    return v === "" ? undefined : v;
  }
}

// ----------------------------------------------------------------------- keychain

export type CommandRunner = (
  cmd: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string }>;

/** Runs a binary with an argument array (never through a shell). */
export const execFileRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: "utf8", timeout: 10_000 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

export interface KeychainSecretStoreOptions {
  /** Keychain service name; the secret key is the account. Default "sindri". */
  service?: string;
  run?: CommandRunner;
}

/** macOS login keychain via `security find-generic-password -s <service> -a <key> -w`. */
export class KeychainSecretStore implements SecretStore {
  readonly #service: string;
  readonly #run: CommandRunner;
  constructor(options: KeychainSecretStoreOptions = {}) {
    this.#service = options.service ?? "sindri";
    this.#run = options.run ?? execFileRunner;
  }
  async get(key: string): Promise<string | undefined> {
    const { code, stdout } = await this.#run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      this.#service,
      "-a",
      key,
      "-w",
    ]);
    if (code === 44) return undefined; // errSecItemNotFound
    if (code !== 0) throw new Error(`keychain lookup failed (exit ${code})`);
    return stdout.replace(/\r?\n$/, "");
  }
}

// --------------------------------------------------------------------------- file

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32 } as const;

interface EncryptedFile {
  v: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCb(passphrase, salt, SCRYPT.keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export interface FileSecretStoreOptions {
  path: string;
  passphrase: string;
}

/** Local secrets file encrypted with AES-256-GCM under a scrypt-derived key; mode 0600. */
export class FileSecretStore implements WritableSecretStore {
  readonly #path: string;
  readonly #passphrase: string;
  constructor(options: FileSecretStoreOptions) {
    this.#path = options.path;
    this.#passphrase = options.passphrase;
  }

  async #load(): Promise<Record<string, string>> {
    if (!existsSync(this.#path)) return {};
    const file = JSON.parse(await readFile(this.#path, "utf8")) as EncryptedFile;
    if (file.v !== 1 || file.kdf?.name !== "scrypt" || file.cipher !== "aes-256-gcm") {
      throw new Error("unsupported secrets file format");
    }
    const { N, r, p, salt } = file.kdf;
    // Bound attacker-controllable KDF cost (a tampered file must not force huge CPU/RAM use).
    const pow2 = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 17 && (N & (N - 1)) === 0;
    if (!pow2 || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) {
      throw new Error("unsupported secrets file KDF parameters");
    }
    const key = await deriveKey(this.#passphrase, Buffer.from(salt, "base64"), N, r, p);
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
      d.setAuthTag(Buffer.from(file.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(file.data, "base64")), d.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch {
      throw new Error("cannot decrypt secrets file (wrong passphrase or corrupted file)");
    }
  }

  async #save(entries: Record<string, string>): Promise<void> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(this.#passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(entries), "utf8"), c.final()]);
    const file: EncryptedFile = {
      v: 1,
      kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.#path);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.#load())[key];
  }
  async set(key: string, value: string): Promise<void> {
    const entries = await this.#load();
    entries[key] = value;
    await this.#save(entries);
  }
  async delete(key: string): Promise<void> {
    const entries = await this.#load();
    delete entries[key];
    await this.#save(entries);
  }
  async keys(): Promise<string[]> {
    return Object.keys(await this.#load()).sort();
  }
}
