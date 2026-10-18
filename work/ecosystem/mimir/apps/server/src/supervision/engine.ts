import { randomUUID } from "node:crypto";
import { SupervisorStore, type Message, type Lease } from "./store.js";
/** Durable inbox pump. Human holds are explicit, silence never triggers restart. */
export class SupervisorEngine {
  private closing = false;
  private owner = randomUUID();
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly store: SupervisorStore,
    private readonly execute: (message: Message, lease: Lease) => Promise<string>,
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return (this.active ??= this.run().finally(() => {
      this.active = undefined;
    }));
  }
  private async run() {
    this.store.scheduleThoughts();
    for (const actor of this.store.list()) {
      if (this.closing) break;
      const lease = this.store.acquire(actor.id, this.owner);
      if (!lease) continue;
      const message = this.store.claim(lease);
      if (!message) continue;
      const heartbeat = setInterval(() => {
        try {
          this.store.acquire(actor.id, this.owner);
        } catch {
          /* Lease renewal will be checked on completion. */
        }
      }, 3000);
      heartbeat.unref();
      try {
        const result = await this.execute(message, lease);
        this.store.finish(lease, message.id, "done", result);
      } catch {
        try {
          this.store.finish(
            lease,
            message.id,
            "uncertain",
            "Control outcome unknown; inspect session evidence before resolving",
          );
        } catch {
          /* Another owner has fenced this operation. */
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
  async stop() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
