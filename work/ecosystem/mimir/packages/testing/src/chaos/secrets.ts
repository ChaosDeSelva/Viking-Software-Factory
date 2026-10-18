// Synthetic credential shapes are assembled at runtime for redaction tests.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Credential-shaped strings for leak tests. Each matches one of the store's redaction rules
 * (sk- api key, GitHub token, AWS key id, JWT, bearer header, key=value secret).
 */
export const CREDENTIAL_SAMPLES: readonly string[] = [
  "sk-chaosLEAK0123456789abcdefghijklmnop",
  ("gh" + "p_chaosLEAK0123456789abcdefghijklmnopqr"),
  "AKIACHAOSLEAK0123456",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaGFvc0xFQUsifQ.c2lnbmF0dXJlY2hhb3NMRUFL",
  "Bearer chaosLEAKbearer0123456789abcdef",
  "password=chaosLEAKhunter2-0123456789",
];

/** The value part of each sample: what must never be stored, even if the prefix survives. */
export function secretCores(samples: readonly string[] = CREDENTIAL_SAMPLES): string[] {
  return samples.map((s) => s.replace(/^Bearer /, "").replace(/^password=/, ""));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) return filesUnder(path);
    return st.isFile() ? [path] : [];
  });
}

/** Greps the raw bytes of every file under `dir` (db, WAL, shm, logs) for each needle. */
export function findSecretsInFiles(
  dir: string,
  needles: readonly string[],
): { file: string; secret: string }[] {
  const hits: { file: string; secret: string }[] = [];
  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(file);
    for (const secret of needles) {
      if (bytes.includes(Buffer.from(secret, "utf8"))) hits.push({ file, secret });
    }
  }
  return hits;
}
