// Synthetic credential shapes are assembled at runtime for redaction tests.
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";
import { containsSecret, secretLineRanges } from "./secrets.js";

const KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(4);

describe("secret scanning (review Ssec I2, m2, m3)", () => {
  let repo: TempRepo | undefined;
  let k: Knowledge | undefined;
  afterEach(() => {
    k?.close();
    repo?.cleanup();
  });

  const chunksAfterBootstrap = (files: Record<string, string>) => {
    repo = createTempRepo(files);
    k = openKnowledge(":memory:");
    const id = k.projects.create({ name: "r", repoPath: repo.path }).id;
    k.bootstrapProject(id, { repoPath: repo.path });
    return (k.db.prepare("SELECT text FROM chunks").all() as { text: string }[])
      .map((r) => r.text)
      .join("\n");
  };

  it("I2: finds a key after 16K characters on one line", () => {
    const readme = "# readme\n" + "x".repeat(16_400) + " ANTHROPIC_API_KEY=" + KEY;
    expect(containsSecret(readme)).toBe(true);
    expect(chunksAfterBootstrap({ "README.md": readme })).not.toContain(KEY);
  });

  it("I2: finds a key deep inside minified JSON", () => {
    const tokens = JSON.stringify({
      colors: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`c${i}`, "#ff6600"])),
      apiKey: KEY,
    });
    expect(tokens.indexOf(KEY)).toBeGreaterThan(16_384);
    expect(tokens.includes("\n")).toBe(false);
    const text = chunksAfterBootstrap({ "README.md": "# r\n", "design-tokens.json": tokens });
    expect(text).not.toContain(KEY);
  });

  it("m2: catches tokens glued to an underscore or letters, and credential URLs", () => {
    for (const t of [
      "MY_AWS_KEY_AKIAABCDEFGHIJ234567",
      ("TOKEN_gh" + "p_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
      "OPENAI_sk-proj-abcdEFGH1234ijklMNOP5678qrst",
      "DATABASE_URL=postgres://admin:Sup3rS3cretPassw0rd@db.internal:5432/prod",
    ])
      expect(containsSecret(t), t).toBe(true);
    for (const t of ["https://example.com/a@b", "mailto:someone@example.com", "ask-me-later"])
      expect(containsSecret(t), t).toBe(false);
  });

  it("m3: a PEM that begins and ends on one line covers only that line", () => {
    const sa =
      '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n"}';
    const text = [sa, ...Array.from({ length: 60 }, (_, i) => `ordinary line ${i}`)].join("\n");
    expect(secretLineRanges(text)).toEqual([{ start: 1, end: 1 }]);
    const stored = chunksAfterBootstrap({ "docs/sa.md": text });
    expect(stored).toContain("ordinary line 59");
    expect(stored).not.toContain("PRIVATE KEY");
  });
});
