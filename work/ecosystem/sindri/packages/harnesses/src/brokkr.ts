import { Brokkr, BrokkrError } from "@brokkr/sdk";
import {
  HarnessServiceError,
  SelectionSchema,
  type HarnessRequest,
  type HarnessService,
  type ResolveInput,
  type Selection,
  type HarnessSummary,
  type RepoSignals,
} from "./types.js";
export interface BrokkrHarnessServiceOptions {
  cwd: string;
  offline?: boolean;
  /** Holds `.brokkr/harnesses` (user harnesses, loaded as trusted). Default: the OS home. */
  homeDir?: string;
  /** Default contract: what `resolve` selects when given neither a profile nor harnesses. */
  harnesses?: HarnessRequest[];
}
/** Resolves real, pinned harness content through the published Brokkr SDK. */
export class BrokkrHarnessService implements HarnessService {
  readonly sdk: Brokkr;
  readonly cwd: string;
  constructor(options: BrokkrHarnessServiceOptions) {
    this.cwd = options.cwd;
    this.sdk = new Brokkr({
      cwd: options.cwd,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.harnesses?.length ? { harnesses: options.harnesses } : {}),
    });
  }
  async resolve(input: ResolveInput): Promise<Selection> {
    const request = input.profile !== undefined ? { task: input.task, profile: input.profile }
      : input.harnesses !== undefined ? { task: input.task, harnesses: input.harnesses } : { task: input.task };
    try {
      return SelectionSchema.parse(await this.sdk.resolve(request));
    } catch (err) {
      // Callers map HarnessServiceError to 404/422; a bare BrokkrError would surface as 500.
      if (err instanceof BrokkrError)
        throw new HarnessServiceError(
          err.code === "not-found" ? "not_found" : "invalid_request",
          err.message,
        );
      throw err;
    }
  }
  listHarnesses(): Promise<HarnessSummary[]> { return this.sdk.listHarnesses(); }
  async inspectRepo(): Promise<RepoSignals> { return this.sdk.inspectRepo(); }
}
