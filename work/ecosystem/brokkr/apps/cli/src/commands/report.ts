import { join } from "node:path";
import { BrokkrError } from "@brokkr/core";
import { latestRun, listRuns, readReport, runsRootFor } from "@brokkr/evidence";
import { REPORT_FORMATS, renderReport, type ReportFormat } from "@brokkr/reporters";
import type { CommandContext } from "../io.js";

const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function reportCommand(
  ctx: CommandContext,
  options: { latest?: boolean; run?: string; format?: string },
): Promise<number> {
  const format = (options.format ?? (ctx.json ? "json" : "md")) as ReportFormat;
  if (!REPORT_FORMATS.includes(format))
    throw new BrokkrError(
      "invalid-config",
      `unknown format '${options.format}' (expected ${REPORT_FORMATS.join(", ")})`,
    );
  let dir: string;
  if (options.run !== undefined) {
    if (!RUN_ID.test(options.run))
      throw new BrokkrError("invalid-config", `invalid run id '${options.run}'`);
    dir = join(runsRootFor(ctx.cwd, ctx.homeDir), options.run);
  } else {
    const latest = await latestRun(ctx.cwd, { home: ctx.homeDir });
    if (!latest) {
      const invalid = (await listRuns(ctx.cwd, { home: ctx.homeDir, includeInvalid: true })).length;
      throw new BrokkrError(
        "not-found",
        invalid > 0
          ? `no valid verification runs: ${invalid} run(s) failed signature or digest checks and were skipped`
          : "no verification runs found; run `brokkr verify` first",
      );
    }
    dir = latest.dir;
  }
  const stored = await readReport(dir, { home: ctx.homeDir, workspace: ctx.cwd });
  if (stored.integrity.status !== "ok") {
    throw new BrokkrError(
      "integrity",
      `run ${stored.report.id} failed integrity validation (integrity_failed):\n${stored.integrity.problems.map((p) => `  ${p}`).join("\n")}`,
      { details: { problems: stored.integrity.problems } },
    );
  }
  ctx.io.stdout(renderReport(stored.report, format));
  return 0;
}
