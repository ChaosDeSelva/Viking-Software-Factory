import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  BrokkrError,
  Sha256DigestSchema,
  fileDigest,
  treeDigest,
  type ExternalSource,
} from "@brokkr/core";
import { loadProjectConfig, saveProjectConfig } from "@brokkr/registry";
import type { CommandContext } from "../io.js";
import { openRegistry } from "./shared.js";

export async function trustList(ctx: CommandContext): Promise<number> {
  const registry = await openRegistry(ctx);
  const sources = registry.sources();
  ctx.emit({ sources, diagnostics: registry.diagnostics }, () =>
    [
      ...sources.map(
        (s) =>
          `${s.trusted ? "trusted  " : "untrusted"}  ${s.ref.padEnd(24)}  ${s.harnesses} harness(es)  ${s.location}`,
      ),
      ...registry.diagnostics
        .filter((d) => d.code === "integrity")
        .map((d) => `integrity: ${d.message}`),
    ].join("\n"),
  );
  return 0;
}

export async function trustAdd(
  ctx: CommandContext,
  source: string,
  options: { digest?: string },
): Promise<number> {
  if (!options.digest)
    throw new BrokkrError(
      "invalid-config",
      "--digest <sha256:...> is required: trust is always pinned to content",
    );
  if (!Sha256DigestSchema.safeParse(options.digest).success)
    throw new BrokkrError("invalid-config", `invalid digest '${options.digest}'`);
  const abs = resolve(ctx.cwd, source);
  if (!existsSync(abs)) throw new BrokkrError("invalid-config", `source ${source} does not exist`);
  const isTarball = statSync(abs).isFile();
  const actual = isTarball ? await fileDigest(abs) : await treeDigest(abs);
  if (actual !== options.digest) {
    throw new BrokkrError(
      "policy-denied",
      `digest mismatch for ${source}: expected ${options.digest}, actual ${actual}; refusing to trust`,
      {
        details: { expected: options.digest, actual },
      },
    );
  }
  const config = (await loadProjectConfig(ctx.cwd)) ?? { version: 1 as const, harnesses: [] };
  const entry: ExternalSource = isTarball
    ? { tarball: source, digest: actual, trusted: true }
    : { path: source, digest: actual, trusted: true };
  const sources = (config.sources ?? []).filter(
    (s) => ("path" in s ? s.path : s.tarball) !== source,
  );
  await saveProjectConfig(ctx.cwd, { ...config, sources: [...sources, entry] });
  ctx.emit({ trusted: entry }, `Trusted ${source} at ${actual}`);
  return 0;
}
