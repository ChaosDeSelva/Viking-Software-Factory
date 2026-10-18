import { pino, type Logger, type LevelWithSilent } from "pino";

export type { Logger };

/**
 * Structured logger. Logs go to stderr (fd 2) so `--json` output on stdout
 * stays machine-readable. Level defaults to `BROKKR_LOG_LEVEL` or `warn`.
 */
export function createLogger(options: { level?: LevelWithSilent; name?: string } = {}): Logger {
  const level =
    options.level ?? (process.env.BROKKR_LOG_LEVEL as LevelWithSilent | undefined) ?? "warn";
  return pino({ name: options.name ?? "brokkr", level }, pino.destination({ fd: 2, sync: true }));
}
