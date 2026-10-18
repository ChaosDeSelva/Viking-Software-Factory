/**
 * Chaos fixture: the real server boot (startMimir, as main.ts) plus an in-process producer that
 * appends CHAOS_EVENTS durable events with deterministic `(source, sourceEventId)` ids, starting
 * from 0 on every boot (as a producer re-delivering after a crash would), and prints `ack <i>`
 * after each append has committed. Stands in for the orchestrator until T12 lands.
 */
import { startMimir } from "../../../src/start.js";

const mimir = await startMimir(process.env);
console.log(`mimir server listening on ${mimir.url}`);

const total = Number(process.env["CHAOS_EVENTS"] ?? "0");
const streams = 5;
let i = 0;
function tick(): void {
  for (let k = 0; k < 10 && i < total; k++, i++) {
    const now = new Date().toISOString();
    mimir.store.append({
      streamId: `chaos-${i % streams}`,
      type: "session.output",
      source: "chaos-producer",
      sourceEventId: `p-${i}`,
      provenance: "observed",
      occurredAt: now,
      observedAt: now,
      payload: { text: `line ${i}`, redacted: false, lines: 1 },
    });
    process.stdout.write(`ack ${i}\n`);
  }
  if (i < total) setImmediate(tick);
  else console.log("producer done");
}
tick();
