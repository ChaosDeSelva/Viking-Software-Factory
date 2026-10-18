import { BrokkrError } from "@brokkr/core";
import { listRuns, pruneRuns } from "@brokkr/evidence";
import type { CommandContext } from "../io.js";

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse `30s`, `15m`, `12h`, `7d`, `2w`. */
export function parseDuration(value: string): number {
  const m = /^(\d+)([smhdw])$/.exec(value.trim());
  if (!m)
    throw new BrokkrError(
      "invalid-config",
      `invalid duration '${value}' (expected e.g. 30s, 15m, 12h, 7d, 2w)`,
    );
  return Number(m[1]) * UNITS[m[2]!]!;
}

export async function runsList(ctx: CommandContext): Promise<number> {
  const runs = await listRuns(ctx.cwd, { home: ctx.homeDir });
  const all = await listRuns(ctx.cwd, { home: ctx.homeDir, includeInvalid: true });
  const rejected = all.length - runs.length;
  if (rejected > 0)
    ctx.io.stderr(
      `warning: ${rejected} run(s) failed signature or digest checks and are not listed\n`,
    );
  ctx.emit(
    {
      runs: runs.map(({ id, verdict, startedAt, completedAt }) => ({
        id,
        verdict,
        startedAt,
        completedAt,
      })),
    },
    () =>
      runs.length === 0
        ? "No verification runs."
        : runs
            .map((r) => `${r.id}  ${(r.verdict ?? "no report").padEnd(10)}  ${r.startedAt ?? ""}`)
            .join("\n"),
  );
  return 0;
}

export async function runsPrune(
  ctx: CommandContext,
  options: { keep?: string; olderThan?: string },
): Promise<number> {
  let keep: number | undefined;
  if (options.keep !== undefined) {
    keep = Number(options.keep);
    if (!Number.isInteger(keep) || keep < 0)
      throw new BrokkrError(
        "invalid-config",
        `--keep must be a non-negative integer, got '${options.keep}'`,
      );
  }
  const olderThanMs =
    options.olderThan !== undefined ? parseDuration(options.olderThan) : undefined;
  const result = await pruneRuns(ctx.cwd, {
    home: ctx.homeDir,
    ...(keep !== undefined ? { keep } : {}),
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
  });
  ctx.emit(result, `Removed ${result.removed.length} run(s); kept ${result.kept.length}.`);
  return 0;
}
