import type { Scenario } from "../harness.js";
import { fanout } from "./fanout.js";
import { idempotency } from "./idempotency.js";
import { rebuild } from "./rebuild.js";
import { scheduler } from "./scheduler.js";
import { storeScenario } from "./store.js";
import { sustained } from "./sustained.js";
import { tick } from "./tick.js";

export const SCENARIOS: readonly Scenario[] = [
  sustained,
  scheduler,
  tick,
  fanout,
  storeScenario,
  rebuild,
  idempotency,
];
