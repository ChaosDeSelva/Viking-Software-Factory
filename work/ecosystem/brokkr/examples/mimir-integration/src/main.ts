// Usage: pnpm --filter @brokkr-examples/mimir-integration start <repo> <worktree>
import { planMission, verifyMission } from "./orchestrator.ts";

const [repo, worktree] = process.argv.slice(2);
if (!repo || !worktree) {
  console.error("usage: main.ts <repo> <worktree>");
  process.exit(2);
}
const selection = await planMission(repo, {
  id: "QA-1",
  title: "Regression pass",
  description: "Verify the worktree",
  taskTypes: ["qa"],
});
// In a real orchestrator the lock comes from the mission record written at acceptance.
const pinnedLock = selection.lock;
const outcome = await verifyMission({
  repo,
  worktree,
  missionId: "mission-demo",
  selection,
  pinnedLock,
});
for (const e of outcome.log) console.log(`#${e.sequence} ${e.type}`);
console.log(`verdict ${outcome.report.verdict} -> mission ${outcome.state}`);
for (const d of outcome.diagnosis) console.log(`  ${d}`);
