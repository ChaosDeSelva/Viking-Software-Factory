// Usage: pnpm --filter @brokkr-examples/sindri-integration start [repo]
import { planHarnesses } from "./plan.ts";

const repo = process.argv[2] ?? process.cwd();
const plan = await planHarnesses(repo, [
  {
    id: "UI-142",
    title: "Build analytics dashboard",
    description: "Create a responsive analytics UI",
    taskTypes: ["frontend"],
    tags: ["react"],
  },
  {
    id: "QA-142",
    title: "Regression pass for the analytics dashboard",
    description: "Independent regression test plan and evidence",
    taskTypes: ["qa"],
  },
]);
for (const p of plan) {
  console.log(`${p.taskId}: ${p.harnesses.join(", ")}`);
  console.log(`  skills: ${p.skills.join(", ")}`);
  console.log(`  gates:  ${p.requiredChecks.join(", ")}`);
  console.log(`  lock:   ${p.lockDigest}`);
}
