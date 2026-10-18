import { MimirError } from "@mimir/protocol";
import {
  BrokkrVerifier,
  loadBrokkrSdk,
  type BrokkrSdk,
  type BrokkrVerifierOptions,
} from "@mimir/brokkr-verifier";
import {
  TestCommandVerifier,
  type VerificationResult,
  type Verifier,
  type VerifyInput,
} from "./verifier.js";

/**
 * Projects with `settings.verification` are verified by Brokkr; the others by their test
 * command. Mimir does not interpret the settings: they go to the verifier as `verifierConfig`.
 */
export class RoutingVerifier implements Verifier {
  constructor(
    readonly brokkr: Verifier,
    readonly fallback: Verifier,
  ) {}

  verify(input: VerifyInput): Promise<VerificationResult> {
    return input.verifierConfig === undefined
      ? this.fallback.verify(input)
      : this.brokkr.verify(input);
  }
}

export interface SelectVerifierOptions {
  log: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  /** Mimir's data dir: Brokkr run evidence and Mimir's evidence signing key live under it. */
  dataDir: string;
  /** Loads `@brokkr/sdk` (default: the vendored tarball); null when it is unavailable. */
  load?: () => Promise<BrokkrSdk | null>;
  /** Passed to `BrokkrVerifier` (home dir, built-in library, executor). */
  brokkr?: Omit<BrokkrVerifierOptions, "sdk" | "dataDir">;
  timeoutMs?: number;
}

/**
 * The server's verifier: Brokkr when `@brokkr/sdk` loads (routing per project), otherwise
 * configured Brokkr projects fail closed; other projects retain test-command verification.
 */
export async function selectVerifier(options: SelectVerifierOptions): Promise<Verifier> {
  const fallback = new TestCommandVerifier(
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
  );
  const sdk = await (options.load ?? (() => loadBrokkrSdk()))();
  if (sdk === null) {
    options.log.warn({}, "verifier: brokkr unavailable");
    return new RoutingVerifier(
      {
        verify: async () => {
          throw new MimirError(
            "internal",
            "Brokkr verification is configured but its SDK is unavailable",
          );
        },
      },
      fallback,
    );
  }
  options.log.info({}, "verifier: brokkr");
  // BrokkrVerifier implements the Verifier port structurally (checked here by the compiler).
  const brokkr: Verifier = new BrokkrVerifier({ ...options.brokkr, sdk, dataDir: options.dataDir });
  return new RoutingVerifier(brokkr, fallback);
}
