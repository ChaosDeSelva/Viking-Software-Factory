import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MimirError } from "@mimir/protocol";
export const ExeWorkerSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,46}[a-z0-9]$/),
    image: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/)
      .default("exeuntu"),
    cpu: z.number().int().min(1).max(64).default(2),
    memoryGb: z.number().int().min(1).max(256).default(4),
  })
  .strict();
type Plan = z.input<typeof ExeWorkerSchema>;
export function exePlan(input: Plan) {
  const p = ExeWorkerSchema.parse(input);
  const command = `new --name=${p.name} --image=${p.image} --cpu=${p.cpu} --memory=${p.memoryGb}GB --no-email`;
  return {
    command,
    vmName: p.name,
    requiresAccount: true,
    createsRemoteResource: true,
    privateByDefault: true,
  };
}
type Receipt = {
  fingerprint: string;
  state: "unknown" | "confirmed";
  vmName: string;
  worker?: { host: string; name: string };
};
/** Uses the documented plain-text POST /exec contract. Never retries a create. */
export class ExeProvider {
  private receipts: Record<string, Receipt> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly token: string,
    private readonly file: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (existsSync(file)) this.receipts = JSON.parse(readFileSync(file, "utf8"));
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + "." + randomUUID();
    writeFileSync(temp, JSON.stringify(this.receipts), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private async call(command: string) {
    if (!this.token)
      throw new MimirError(
        "capability_unavailable",
        "Set EXE_TOKEN on the controller before using exe.dev",
      );
    const response = await this.request("https://exe.dev/exec", {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "text/plain" },
      body: command,
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) throw new Error(`exe.dev returned HTTP ${response.status}`);
    let bytes = 0;
    const parts: Uint8Array[] = [];
    for await (const part of response.body!) {
      bytes += part.length;
      if (bytes > 1024 * 1024) throw new Error("Provider response exceeds limit");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  }
  async inventory() {
    return this.call("ls");
  }
  create(input: Plan, key: string): Promise<Receipt> {
    const operation = this.queue.then(async () => {
      const plan = exePlan(input);
      if (!key || key.length > 200)
        throw new MimirError("validation_failed", "Provisioning request key required");
      const fingerprint = createHash("sha256").update(plan.command).digest("hex");
      const id = createHash("sha256").update(key).digest("hex");
      const prior = this.receipts[id];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new MimirError("idempotency_replay_mismatch", "Provisioning request changed");
        return prior;
      }
      if (!this.token)
        throw new MimirError("capability_unavailable", "exe.dev credentials are not configured");
      const receipt: Receipt = { fingerprint, state: "unknown", vmName: plan.vmName };
      this.receipts[id] = receipt;
      this.save();
      try {
        const response = z
          .object({
            vm_name: z.string(),
            ssh_host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
          })
          .parse(await this.call(plan.command));
        if (response.vm_name !== plan.vmName) throw new Error("Provider identity mismatch");
        receipt.state = "confirmed";
        receipt.worker = { host: response.ssh_host, name: response.vm_name };
      } catch {
        /* May have created the VM. Inspect inventory; do not resubmit. */
      }
      this.save();
      return receipt;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
