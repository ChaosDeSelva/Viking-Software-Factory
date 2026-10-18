/**
 * Process exit helper. Kept free of heavy imports so `brokkr --help` starts
 * fast; the values mirror `EXIT_CODES` in @brokkr/core (asserted by tests).
 */
export const CLI_EXIT_CODES = {
  ok: 0,
  verificationFailed: 1,
  invalidConfig: 2,
  infraError: 3,
  policyDenied: 4,
  interrupted: 130,
} as const;

const VALID = new Set<number>(Object.values(CLI_EXIT_CODES));

/** Exit with a contract code (spec §11.3). Unknown codes are coerced to 3 (infrastructure error). */
export function exitWith(code: number, exit: (code: number) => never = process.exit): never {
  return exit(VALID.has(code) ? code : CLI_EXIT_CODES.infraError);
}
