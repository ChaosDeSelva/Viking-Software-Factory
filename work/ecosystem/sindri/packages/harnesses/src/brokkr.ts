import { Brokkr } from "@brokkr/sdk";
import { SelectionSchema, type HarnessService, type ResolveInput, type Selection, type HarnessSummary, type RepoSignals } from "./types.js";
export interface BrokkrHarnessServiceOptions { cwd: string; offline?: boolean; }
/** Resolves real, pinned harness content through the published Brokkr SDK. */
export class BrokkrHarnessService implements HarnessService {
  readonly sdk: Brokkr;
  readonly cwd: string;
  constructor(options: BrokkrHarnessServiceOptions) { this.cwd = options.cwd; this.sdk = new Brokkr({ cwd: options.cwd }); }
  async resolve(input: ResolveInput): Promise<Selection> {
    const request = input.profile !== undefined ? { task: input.task, profile: input.profile }
      : input.harnesses !== undefined ? { task: input.task, harnesses: input.harnesses } : { task: input.task };
    return SelectionSchema.parse(await this.sdk.resolve(request));
  }
  listHarnesses(): Promise<HarnessSummary[]> { return this.sdk.listHarnesses(); }
  async inspectRepo(): Promise<RepoSignals> { return this.sdk.inspectRepo(); }
}
