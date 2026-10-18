/** Public CLI exit-code contract (spec §11.3). Changing a value is a breaking change. */
export const EXIT_CODES = {
  ok: 0,
  verificationFailed: 1,
  invalidConfig: 2,
  infraError: 3,
  policyDenied: 4,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const VALID = new Set<number>(Object.values(EXIT_CODES));

export function isExitCode(code: number): code is ExitCode {
  return VALID.has(code);
}

export type BrokkrErrorCode =
  | "invalid-config"
  | "not-found"
  | "version-conflict"
  | "harness-conflict"
  | "skill-conflict"
  | "incompatible"
  | "integrity"
  | "policy-denied"
  | "trust_required"
  | "verification-failed"
  | "infra"
  | "interrupted";

const EXIT_FOR_CODE: Record<BrokkrErrorCode, ExitCode> = {
  "invalid-config": EXIT_CODES.invalidConfig,
  "not-found": EXIT_CODES.invalidConfig,
  "version-conflict": EXIT_CODES.invalidConfig,
  "harness-conflict": EXIT_CODES.invalidConfig,
  "skill-conflict": EXIT_CODES.invalidConfig,
  incompatible: EXIT_CODES.invalidConfig,
  integrity: EXIT_CODES.verificationFailed,
  "policy-denied": EXIT_CODES.policyDenied,
  trust_required: EXIT_CODES.policyDenied,
  "verification-failed": EXIT_CODES.verificationFailed,
  infra: EXIT_CODES.infraError,
  interrupted: EXIT_CODES.interrupted,
};

/** Typed error used across Brokkr packages; the CLI maps `exitCode` straight to the process. */
export class BrokkrError extends Error {
  readonly code: BrokkrErrorCode;
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: BrokkrErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrokkrError";
    this.code = code;
    this.exitCode = EXIT_FOR_CODE[code];
    this.details = options.details;
  }
}
