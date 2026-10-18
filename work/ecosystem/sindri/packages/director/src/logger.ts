export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** Minimal structured logger. Callers must never pass prompts or secrets at `info` or above. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface LogRecord {
  level: LogLevel;
  msg: string;
  fields?: LogFields;
}

/** In-memory logger (tests, diagnostics). Records at or above `minLevel`. */
export function createMemoryLogger(minLevel: LogLevel = "info"): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (ORDER[level] < ORDER[minLevel]) return;
      records.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  return { records, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** Replace every occurrence of each secret with `[REDACTED]`. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** Debug-safe summary of free text: never the text itself, only its shape. */
export const describeText = (text: string) => `[redacted ${text.length} chars]`;
