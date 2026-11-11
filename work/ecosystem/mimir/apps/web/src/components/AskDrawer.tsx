import { Button, Callout, Drawer, Link } from "@factory/ui";
import { docsHrefFor } from "../lib/docs.js";
import { SINDRI_URL } from "./apps.js";
import type { ScreenId } from "./Screen.js";

const SUGGESTED = [
  "Why is a task blocked by its budget, and how do I raise it?",
  "What does a crew do, and why is mine idle?",
  "Where do I see what an agent is doing right now?",
];

/**
 * Ask opens the factory Guide. Mimir holds no Sindri token, so it cannot call the Guide itself:
 * the drawer says so and links to Sindri's Overview, where the Guide chat lives.
 */
export function AskDrawer({
  open,
  onClose,
  screen,
}: {
  open: boolean;
  onClose: () => void;
  screen: ScreenId | undefined;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Ask the guide"
      description="A read-only assistant that answers from the factory docs and state."
    >
      <div className="flex flex-col gap-5">
        <Callout tone="info" title="The Guide runs in Sindri">
          Mimir has no Sindri access token, so it cannot ask the Guide from here. Open Sindri's
          Overview and use its Ask card; it knows Mimir's screens too.
        </Callout>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Questions it answers well</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
            {SUGGESTED.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`${SINDRI_URL}/`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-control-md items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            Open the Guide in Sindri
          </a>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="text-sm text-muted">
          Or read about this screen in{" "}
          <Link href={docsHrefFor(screen)} onClick={onClose} className="font-medium text-accent-fg">
            Docs
          </Link>
          .
        </p>
      </div>
    </Drawer>
  );
}
