import { randomUUID } from 'node:crypto';
export class Simulator {
  mode = 'simulation';
  async create(input) { return { id: `sim-${randomUUID()}`, ...input, state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+input.minutes*60000).toISOString() }; }
  async transition(worker, action) {
    const transitions = { stop: ['running','stopped'], start: ['stopped','running'], reboot: ['running','running'], terminate: ['running,stopped','terminated'] };
    const [from, to] = transitions[action] ?? [];
    if (!from?.split(',').includes(worker.state)) throw new Error('That action is unavailable in the current state.');
    return { ...worker, state: to };
  }
}
