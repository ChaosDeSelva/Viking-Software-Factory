import test from 'node:test';
import assert from 'node:assert/strict';
import { commandRoute } from '../apps/server/commands.mjs';
const routes = {
  'mission.pause':'mimir POST /v1/missions/item/pause', 'mission.resume':'mimir POST /v1/missions/item/resume', 'mission.cancel':'mimir POST /v1/missions/item/cancel',
  'crew.pause':'mimir POST /v1/crews/item/pause', 'crew.resume':'mimir POST /v1/crews/item/resume',
  'fleet.drain':'mimir POST /v1/fleet/item/drain', 'supervisor.register':'mimir POST /v1/supervisors',
  'supervisor.state':'mimir POST /v1/supervisors/item/state', 'supervisor.message':'mimir POST /v1/supervisors/item/messages',
  'supervisor.resolve':'mimir POST /v1/supervisors/item/resolve', 'supervisor.policy':'mimir POST /v1/supervisors/item/policy', 'supervisor.authorize':'mimir POST /v1/supervisors/item/authorize',
  'session.input':'mimir POST /v1/sessions/item/input', 'session.stop':'mimir POST /v1/sessions/item/stop',
  'task.retry':'mimir POST /v1/tasks/item/retry', 'task.verify':'mimir POST /v1/tasks/item/verify', 'approval.decide':'mimir POST /v1/approvals/item/decision',
  'spec.submit':'sindri POST /v1/specs/item/submit', 'spec.approve':'sindri POST /v1/specs/item/approve', 'spec.answer':'sindri POST /v1/specs/item/answer', 'spec.revise':'sindri POST /v1/specs/item/revise',
  'plan.submit':'sindri POST /v1/plans/item/submit', 'plan.approve':'sindri POST /v1/plans/item/approve', 'plan.revise':'sindri POST /v1/plans/item/revise',
  'execution.assess':'sindri POST /v1/executions/item/assess', 'execution.export':'sindri POST /v1/executions/item/pr', 'execution.resolve':'sindri POST /v1/executions/item/escalations/task', 'delivery.rework':'sindri POST /v1/deliveries/item/rework',
  'project.create':'sindri POST /v1/projects', 'project.bootstrap':'sindri POST /v1/projects/item/bootstrap', 'intake.create':'sindri POST /v1/intakes', 'spec.draft':'sindri POST /v1/director/draft', 'plan.propose':'sindri POST /v1/plans/propose', 'execution.create':'sindri POST /v1/executions',
  'execution.cancel':'sindri POST /v1/executions/item/cancel', 'project.profile':'sindri PUT /v1/projects/item/profile',
  'budget.raise':'mimir PATCH /v1/crews/item/budget',
};
for (const [action, expected] of Object.entries(routes)) {
  test(`operator route contract: ${action}`, () => {
    const input = { action, id: 'item', taskId: 'task', body: action === 'session.stop' ? { mode: 'graceful' } : action === 'budget.raise' ? { limitTokens: 10 } : { reason: 'fixture' } };
    const route = commandRoute(input);
    assert.equal(`${route.source} ${route.method} ${route.path}`, expected);
    assert.deepEqual(route.body, action === 'session.stop' ? { mode: 'soft' } : input.body);
    assert.throws(() => commandRoute({ ...input, id: '../escape' }));
  });
}
test('dangerous or unknown control variants fail closed', () => {
  assert.throws(() => commandRoute({ action: 'session.stop', id: 'item', body: { mode: 'kill' } }));
  assert.throws(() => commandRoute({ action: 'execution.resolve', id: 'item', taskId: '../escape' }));
  assert.throws(() => commandRoute({ action: 'project.delete', id: 'item' }));
  assert.throws(() => commandRoute({ action: 'mission.cancel', id: 'item', body: { reason: 'x'.repeat(500001) } }));
});
