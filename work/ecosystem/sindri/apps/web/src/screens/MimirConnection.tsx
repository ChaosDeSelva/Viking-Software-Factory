import { useState } from "react";
import type { MimirStatus } from "../api/delivery-types.js";
import { Button, Card } from "../components/ui.js";
import { useApi, useReportError } from "../store/context.js";

function describe(s: MimirStatus): string {
  if (!s.configured)
    return "Mimir is not configured: set its URL and token secret name, then save.";
  if (s.blocked === "local_only")
    return `Blocked by local-only mode: ${s.url ?? "this URL"} is not a loopback address.`;
  if (s.reachable) return `Connected to Mimir ${s.serverVersion ?? ""} at ${s.url ?? ""}.`;
  return `Cannot reach Mimir at ${s.url ?? ""}${s.error ? `: ${s.error}` : ""}.`;
}

/** Settings card: checks the saved Mimir URL + token against the running Mimir. */
export function MimirConnection() {
  const api = useApi();
  const report = useReportError();
  const [status, setStatus] = useState<MimirStatus | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Mimir connection">
      <p className="text-sm">Runs execute through Mimir. Save settings first, then test.</p>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          api
            .mimirStatus()
            .then(setStatus, report)
            .finally(() => setBusy(false));
        }}
      >
        Test Mimir connection
      </Button>
      {status ? (
        <section aria-label="Mimir connection" className="text-sm">
          <p>{describe(status)}</p>
        </section>
      ) : null}
    </Card>
  );
}
