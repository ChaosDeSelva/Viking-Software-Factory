import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";

export type FleetNode = {
  id: string;
  runtime: RuntimeAdapter;
  capacity: number;
  identity: string;
  agentKinds?: string[];
};
type Placement = { node: string; key: string; fingerprint: string; session: RuntimeSession };
type NodeState = { identity: string; draining: boolean };
const terminal = new Set(["completed", "failed", "stopped", "lost"]);
/** One controller (protected by Mimir's store lock), durable placement before dispatch.
 * An uncertain dispatch reserves capacity until the SAME worker confirms its outcome.
 */
export class FleetRuntime implements RuntimeAdapter {
  private placements = new Map<string, Placement>();
  private states = new Map<string, NodeState>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private subscriptions: { close(): void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | undefined;
  constructor(
    private readonly nodes: FleetNode[],
    private readonly stateFile: string,
  ) {
    if (
      !nodes.length ||
      new Set(nodes.map((n) => n.id)).size !== nodes.length ||
      nodes.some(
        (n) =>
          !/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) || !Number.isInteger(n.capacity) || n.capacity < 1,
      )
    )
      throw new Error("Fleet requires unique safe node IDs and positive capacities");
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf8")) as {
        version: number;
        nodes: [string, NodeState][];
        placements: [string, Placement][];
      };
      if (data.version !== 1) throw new Error("Unsupported fleet state");
      this.states = new Map(data.nodes);
      this.placements = new Map(data.placements);
    }
    for (const node of nodes) {
      const prior = this.states.get(node.id);
      if (prior && prior.identity !== node.identity)
        throw new Error(`Fleet node ${node.id} changed identity; use a new node ID`);
      this.states.set(node.id, prior ?? { identity: node.identity, draining: false });
    }
    for (const p of this.placements.values())
      if (!nodes.some((n) => n.id === p.node) && !terminal.has(p.session.state))
        throw new Error(`Cannot remove fleet node ${p.node} with unresolved work; drain it first`);
    this.save();
  }
  private save() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ version: 1, nodes: [...this.states], placements: [...this.placements] }),
      { mode: 0o600 },
    );
    renameSync(temp, this.stateFile);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private async connect() {
    this.ready ??= (async () => {
      for (const node of this.nodes)
        this.subscriptions.push(
          await node.runtime.subscribe((event) => {
            if ("sessionId" in event) {
              const p = this.placements.get(event.sessionId);
              if (!p || p.node !== node.id) return;
              if (event.kind === "session.state_changed") {
                p.session.state = event.state;
                p.session.lastObservedAt = event.observedAt;
                this.save();
              }
            }
            for (const handler of this.listeners) handler(event);
          }),
        );
    })();
    await this.ready;
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = await Promise.all(this.nodes.map((n) => n.runtime.capabilities()));
    return {
      runtime: "fleet",
      version: "1",
      agentKinds: [
        ...new Set(
          caps.flatMap((c, i) =>
            c.agentKinds.filter(
              (k) => !this.nodes[i]!.agentKinds || this.nodes[i]!.agentKinds!.includes(k),
            ),
          ),
        ),
      ],
      features: {
        createSession: true,
        sendInput: caps.some((c) => c.features.sendInput),
        sendKeys: caps.some((c) => c.features.sendKeys),
        softStop: true,
        forceStop: true,
        pause: false,
        subscribe: true,
        terminalRead: true,
        processInfo: false,
        multiHost: true,
        notify: false,
      },
    };
  }
  async health() {
    const results = await Promise.all(
      this.nodes.map((n) => n.runtime.health().catch(() => ({ ok: false }))),
    );
    return {
      ok: results.some((r) => r.ok),
      detail: `${results.filter((r) => r.ok).length}/${results.length} workers reachable`,
    };
  }
  async inventory() {
    return Promise.all(
      this.nodes.map(async (node) => ({
        id: node.id,
        capacity: node.capacity,
        draining: this.states.get(node.id)!.draining,
        active: [...this.placements.values()].filter(
          (p) => p.node === node.id && !terminal.has(p.session.state),
        ).length,
        health: await node.runtime
          .health()
          .catch(() => ({ ok: false, detail: "Worker observation unavailable" })),
        capabilities: await node.runtime.capabilities().catch(() => null),
        sessions: [...this.placements.values()]
          .filter((p) => p.node === node.id)
          .map((p) => ({ ...p.session })),
      })),
    );
  }
  async setDraining(id: string, draining: boolean) {
    return this.serial(async () => {
      const state = this.states.get(id);
      if (!state || !this.nodes.some((n) => n.id === id))
        throw new MimirError("not_found", "Worker not found");
      state.draining = draining;
      this.save();
    });
  }
  async createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    await this.connect();
    return this.serial(async () => {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            ...spec,
            env: Object.fromEntries(
              Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)),
            ),
          }),
        )
        .digest("hex");
      const prior = [...this.placements.values()].find((p) => p.key === spec.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new MimirError("idempotency_replay_mismatch", "Fleet request changed");
        return { ...prior.session };
      }
      if (this.placements.has(spec.sessionId))
        throw new MimirError("conflict", "Fleet session ID already exists");
      const eligible: { node: FleetNode; load: number }[] = [];
      for (const node of this.nodes) {
        if (
          this.states.get(node.id)!.draining ||
          (node.agentKinds && !node.agentKinds.includes(spec.agentKind))
        )
          continue;
        const active = [...this.placements.values()].filter(
          (p) => p.node === node.id && !terminal.has(p.session.state),
        ).length;
        if (active >= node.capacity) continue;
        try {
          if (
            (await node.runtime.capabilities()).agentKinds.includes(spec.agentKind) &&
            (await node.runtime.health()).ok
          )
            eligible.push({ node, load: active / node.capacity });
        } catch {
          /* Unavailable inventory is not an empty worker. */
        }
      }
      eligible.sort((a, b) => a.load - b.load || a.node.id.localeCompare(b.node.id));
      const node = eligible[0]?.node;
      if (!node)
        throw new MimirError(
          "runtime_unavailable",
          "No reachable, compatible fleet worker has capacity",
        );
      const placement: Placement = {
        node: node.id,
        key: spec.idempotencyKey,
        fingerprint,
        session: {
          sessionId: spec.sessionId,
          state: "starting",
          runtimeRef: { workspaceId: node.id },
          agentKind: spec.agentKind,
          cwd: spec.cwd,
          lastObservedAt: new Date().toISOString(),
        },
      };
      this.placements.set(spec.sessionId, placement);
      this.save();
      try {
        placement.session = await node.runtime.createSession(spec);
      } catch {
        placement.session.state = "unknown";
      } // Never spill an uncertain mutation onto another host.
      this.save();
      return { ...placement.session };
    });
  }
  private owner(id: string) {
    const p = this.placements.get(id);
    const node = this.nodes.find((n) => n.id === p?.node);
    if (!p || !node) throw new MimirError("not_found", "Fleet session owner unavailable");
    return { p, node };
  }
  async listSessions() {
    return [...this.placements.values()].map((p) => ({ ...p.session }));
  }
  async getSession(id: string) {
    return this.placements.has(id) ? { ...this.placements.get(id)!.session } : null;
  }
  async sendInput(id: string, input: { text?: string; keys?: string[] }) {
    const { node } = this.owner(id);
    return node.runtime.sendInput(id, input);
  }
  async requestStop(id: string, mode: "soft" | "force") {
    const { node } = this.owner(id);
    return node.runtime.requestStop(id, mode);
  }
  async readTerminal(id: string, lines = 200) {
    const { node } = this.owner(id);
    const reader = node.runtime as RuntimeAdapter & {
      readTerminal?: (id: string, lines: number) => Promise<string>;
    };
    if (!reader.readTerminal)
      throw new MimirError("capability_unavailable", "Worker cannot read terminal");
    return reader.readTerminal(id, lines);
  }
  async subscribe(handler: (event: RuntimeEvent) => void) {
    this.listeners.add(handler);
    await this.connect();
    return {
      close: () => {
        this.listeners.delete(handler);
      },
    };
  }
  async reconcile() {
    await this.connect();
    return this.serial(async () => {
      for (const node of this.nodes) {
        let observed: RuntimeSession[] = [];
        try {
          observed = (await node.runtime.reconcile()).sessions;
        } catch {
          /* Preserve the owner and reservation. */
        }
        for (const p of this.placements.values()) {
          if (p.node !== node.id || terminal.has(p.session.state)) continue;
          const session = observed.find((s) => s.sessionId === p.session.sessionId);
          if (session) p.session = session;
          else p.session = { ...p.session, state: "unknown" }; // Missing is not proof of termination.
        }
      }
      this.save();
      return { sessions: await this.listSessions(), lost: [] };
    });
  }
  async dispose() {
    await this.queue;
    for (const sub of this.subscriptions) sub.close();
    await Promise.all(this.nodes.map((n) => n.runtime.dispose()));
    this.listeners.clear();
  }
}
