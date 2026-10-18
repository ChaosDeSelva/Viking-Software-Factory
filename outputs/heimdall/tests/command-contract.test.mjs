import test from 'node:test';
import assert from 'node:assert/strict';
import { commandRoute } from '../apps/server/commands.mjs';
const routes = {
  'mission.pause':'mimir /v1/missions/item/pause', 'mission.resume':'mimir /v1/missions/item/resume', 'mission.cancel':'mimir /v1/missions/item/cancel',
  'crew.pause':'mimir /v1/crews/item/pause', 'crew.resume':'mimir /v1/crews/item/resume',
  'fleet.drain':'mimir /v1/fleet/item/drain', 'supervisor.register':'mimir /v1/supervisors',
  'supervisor.state':'mimir /v1/supervisors/item/state', 'supervisor.message':'mimir /v1/supervisors/item/messages',
  'supervisor.resolve':'mimir /v1/supervisors/item/resolve', 'supervisor.policy':'mimir /v1/supervisors/item/policy', 'supervisor.authorize':'mimir /v1/supervisors/item/authorize',
  'session.input':'mimir /v1/sessions/item/input', 'session.stop':'mimir /v1/sessions/item/stop',
  'task.retry':'mimir /v1/tasks/item/retry', 'task.verify':'mimir /v1/tasks/item/verify', 'approval.decide':'mimir /v1/approvals/item/decision',
  'spec.submit':'sindri /v1/specs/item/submit', 'spec.approve':'sindri /v1/specs/item/approve', 'spec.answer':'sindri /v1/specs/item/answer', 'spec.revise':'sindri /v1/specs/item/revise',
  'plan.submit':'sindri /v1/plans/item/submit', 'plan.approve':'sindri /v1/plans/item/approve', 'plan.revise':'sindri /v1/plans/item/revise',
  'execution.assess':'sindri /v1/executions/item/assess', 'execution.export':'sindri /v1/executions/item/pr', 'execution.resolve':'sindri /v1/executions/item/escalations/task',
  'project.create':'sindri /v1/projects', 'project.bootstrap':'sindri /v1/projects/item/bootstrap', 'intake.create':'sindri /v1/intakes', 'spec.draft':'sindri /v1/director/draft', 'plan.propose':'sindri /v1/plans/propose', 'execution.create':'sindri /v1/executions',
};
for (const [action, expected] of Object.entries(routes)) {
  test(`operator route contract: ${action}`, () => {
    const input = { action, id: 'item', taskId: 'task', body: action === 'session.stop' ? { mode: 'graceful' } : { reason: 'fixture' } };
    const route = commandRoute(input);
    assert.equal(`${route.source} ${route.path}`, expected);
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
