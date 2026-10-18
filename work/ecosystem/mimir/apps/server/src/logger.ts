import { pino, type DestinationStream, type Logger } from "pino";

export interface LoggerOptions {
  level?: string;
  /** Destination (defaults to stdout). */
  stream?: DestinationStream;
}

/** Header paths that must never reach the logs. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["proxy-authorization"]',
];

interface LoggedRequest {
  method?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

/** Structured pino logger with authorization headers redacted. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const config = {
    level: options.level ?? "info",
    redact: { paths: REDACTED_PATHS, censor: "[Redacted]" },
    serializers: {
      req: (req: LoggedRequest) => ({
        method: req.method,
        url: req.url,
        remoteAddress: req.ip,
        headers: { ...req.headers },
      }),
    },
  };
  return options.stream ? pino(config, options.stream) : pino(config);
}
