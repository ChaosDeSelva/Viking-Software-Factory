import { useState } from "react";
import { useApi, useReportError } from "../store/context.js";
import { Button, Field, inputClass } from "./ui.js";

/**
 * Approvals need the pairing code shown in the terminal that ran `sindri start` (audit M9).
 * It is traded for an approval secret held in this tab's memory only. Renders nothing once
 * approvals are unlocked; `onUnlocked` lets the parent re-render.
 */
export function ApprovalUnlock({ id, onUnlocked }: { id: string; onUnlocked: () => void }) {
  const api = useApi();
  const report = useReportError();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  if (api.hasApprovalSession()) return null;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        setBusy(true);
        api
          .unlockApprovals(code)
          .then(() => {
            setCode("");
            onUnlocked();
          })
          .catch(report)
          .finally(() => setBusy(false));
      }}
    >
      <Field
        label="Approval pairing code"
        id={id}
        hint="Shown in the terminal that ran `sindri start`. Approving needs it so an agent with the API token cannot approve on its own. Never paste it into an agent."
      >
        <input
          id={id}
          type="password"
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          className={inputClass}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="secondary" disabled={busy || !code.trim()}>
        Unlock approvals
      </Button>
    </form>
  );
}
