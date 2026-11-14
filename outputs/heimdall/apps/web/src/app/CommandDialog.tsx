// Every operator command stops here: what it does, its target and payload, and the audit reason.
import {
  Button,
  Callout,
  Dialog,
  Disclosure,
  Field,
  Id,
  Textarea,
} from "@factory/ui";
import { useEffect, useRef } from "react";
import { Raw } from "../components/app";
import type { R } from "../lib/api";

/** "mission.pause" → "Pause mission"; unknown actions fall back to their words. */
export function commandTitle(action: string, body: R = {}): string {
  // Chained controls (one click from a draft) are named for everything they do.
  if (action === "spec.approve" && body.thenPropose) return "Approve and plan";
  if (action === "plan.approve" && body.thenStart) return "Approve and start";
  if (action === "intake.create" && body.thenDraft)
    return "Save and draft spec";
  const known: Record<string, string> = {
    "budget.raise": "Raise budget",
    "execution.create": "Start approved plan",
    "execution.cancel": "Cancel run",
    "execution.resolve": "Resolve escalation",
    "execution.assess": "Reassess quality gates",
    "execution.export": "Request local export",
    "delivery.rework": "Request changes to a delivery",
    "approval.decide": "Decide approval",
    "intake.create": "Save intake",
    "intake.import": "Import pull request for review",
    "research.accept": "Accept research document",
    "research.reject": "Reject research document",
    "research.followUp": "Ask a follow-up question",
    "session.stop": "Stop agent session",
    "project.profile": "Change execution profile",
    "project.feedbackGraph": "Change Feedback Graph link",
    "steward.mode": "Change steward mode",
    "steward.globalNote": "Add a note for the steward",
  };
  if (known[action]) return known[action];
  const [noun = "", verb = ""] = action.split(".");
  const words = (s: string) =>
    s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const text = verb ? `${words(verb)} ${words(noun)}` : words(noun);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function CommandDialog({
  command,
  reason,
  setReason,
  busy,
  error,
  onCancel,
  onSend,
}: {
  command: R | null;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSend: () => void;
}) {
  const reasonField = useRef<HTMLTextAreaElement>(null);
  // Radix focuses the first tabbable element (the Close button) on open; the reason is what the
  // operator types next, so move focus there once the dialog has settled.
  useEffect(() => {
    if (!command) return;
    // The reason starts prefilled; selecting it lets typing replace it.
    const frame = requestAnimationFrame(() => reasonField.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [command]);
  return (
    <Dialog
      open={!!command}
      onOpenChange={(open) => !open && onCancel()}
      busy={busy}
      title={command ? commandTitle(command.action, command.body) : ""}
      description="Confirm to send this to the factory. The reason is kept in the audit history."
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Go back
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabledReason={
              !busy && !reason.trim() ? "Write the reason first." : undefined
            }
            onClick={onSend}
          >
            {busy ? "Sending…" : "Confirm"}
          </Button>
        </>
      }
    >
      {command && (
        <div className="flex flex-col gap-4">
          <Disclosure title="Technical details">
            <div className="flex flex-col gap-3">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Target</span>
                <Id value={String(command.id)} />
                <code className="text-xs text-muted">{command.action}</code>
              </p>
              <Raw data={command.body} title="Command payload" />
            </div>
          </Disclosure>
          <Field
            label="Reason"
            hint={
              "reason" in (command.body ?? {})
                ? "Sent to the factory with your decision."
                : "Prefilled as a note for the audit history; edit it if you like."
            }
          >
            <Textarea
              ref={reasonField}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the decision for the audit trail"
            />
          </Field>
          {error && (
            <Callout tone="danger" title="The source did not confirm">
              {error}
            </Callout>
          )}
        </div>
      )}
    </Dialog>
  );
}
