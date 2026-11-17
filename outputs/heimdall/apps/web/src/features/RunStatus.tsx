// A run's status, or the decision on the document it delivered: an accepted plan no longer
// waits for review, though its run's own status still says so.
import { Badge } from "@factory/ui";
import { Status } from "../components/app";
import type { R } from "../lib/api";
import { documentDecision } from "./workKinds";

export function RunStatus({ execution, deliveries }: { execution: R; deliveries: R[] }) {
  const decided = documentDecision(deliveries, execution.id);
  if (!decided) return <Status value={execution.status} domain="run" />;
  const what = decided.kind === "proposal" ? "Plan" : "Document";
  return decided.decision === "accepted" ? (
    <Badge tone="forest">{what} accepted</Badge>
  ) : (
    <Badge tone="danger">{what} rejected</Badge>
  );
}
