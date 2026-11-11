import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acceptsKimiPrompt, verifyInteractiveLaunch } from "./compatibility.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A stand-in CLI whose --help text and exit status are scripted. */
function cli(body: string) {
  const home = mkdtempSync(join(tmpdir(), "mimir-compat-"));
  roots.push(home);
  const file = join(home, "kimi");
  writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}
it("does not equate the newer Kimi unattended prompt mode with the older permission-preserving CLI", () => {
  expect(acceptsKimiPrompt("--prompt --auto Never Ask --yolo")).toBe(false);
  expect(acceptsKimiPrompt("--config-file --wire --print --prompt")).toBe(true);
  expect(acceptsKimiPrompt("--prompt")).toBe(false);
  expect(acceptsKimiPrompt("--config-file --wire --print --auto Never Ask")).toBe(false);
});
it("does not probe executables of other harnesses", async () => {
  await expect(
    verifyInteractiveLaunch("codex", join(tmpdir(), "mimir-no-such-binary")),
  ).resolves.toBeUndefined();
});
it("accepts a Kimi CLI whose help, on either stream, shows the permission-preserving profile", async () => {
  await expect(
    verifyInteractiveLaunch(
      "kimi",
      cli(`process.stdout.write("--config-file --wire");process.stderr.write(" --print");`),
    ),
  ).resolves.toBeUndefined();
}, 60000);
it.each([
  [
    "an unattended Kimi CLI",
    `process.stdout.write("--config-file --wire --print --auto Never Ask");`,
  ],
  [
    "a CLI whose help fails",
    `process.stdout.write("--config-file --wire --print");process.exit(2);`,
  ],
  ["a CLI that cannot be started", undefined],
])(
  "refuses %s",
  async (_name, body) => {
    const executable = body === undefined ? join(tmpdir(), "mimir-no-such-kimi") : cli(body);
    await expect(verifyInteractiveLaunch("kimi", executable)).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  },
  60000,
);
