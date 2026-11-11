import { Dialog, Link, Markdown, Switch } from "@factory/ui";
import { useEffect, useState } from "react";
import { useShortcutsEnabled } from "../lib/shortcutsPref.js";
import { SHORTCUTS } from "../lib/useShortcuts.js";
import type { ScreenId } from "./Screen.js";

/**
 * The "?" dialog: what the current screen is for (its docs section), then the keyboard shortcuts
 * and the switch for single-key shortcuts. Focus trap, Esc and focus return come from Dialog.
 */
export function HelpDialog({
  open,
  onClose,
  screen,
}: {
  open: boolean;
  onClose: () => void;
  screen: ScreenId | undefined;
}) {
  const [shortcutsOn, setShortcutsOn] = useShortcutsEnabled();
  const section = useScreenSection(screen);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Help and keyboard shortcuts"
      description={
        section && section !== "failed" ? `About ${section.title}` : "Keyboard shortcuts"
      }
      size="md"
    >
      <div className="flex flex-col gap-6">
        {section === "failed" && (
          <p className="text-sm text-muted">
            The guide for this screen did not load. Mimir may have been updated since this page
            opened; reload to get the current version.
          </p>
        )}
        {section && section !== "failed" && (
          <section aria-labelledby="help-screen" className="flex flex-col gap-2">
            <h3 id="help-screen" className="text-md font-semibold">
              On this screen
            </h3>
            <Markdown source={section.markdown} className="text-sm" />
            <Link
              href={section.href}
              onClick={onClose}
              className="text-sm font-medium text-accent-fg"
            >
              Read the full guide in Docs
            </Link>
          </section>
        )}
        <section aria-labelledby="help-title" className="flex flex-col gap-3">
          <h3 id="help-title" className="text-md font-semibold">
            Keyboard shortcuts
          </h3>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="rounded-sm border border-line bg-sunken px-1.5 py-0.5 font-mono text-xs">
                    {s.keys}
                  </kbd>
                </dt>
                <dd>{s.description}</dd>
              </div>
            ))}
          </dl>
          <Switch
            checked={shortcutsOn}
            onCheckedChange={setShortcutsOn}
            label="Single-key shortcuts"
            description="Turn off if they clash with speech input or assistive technology."
          />
        </section>
      </div>
    </Dialog>
  );
}

type Section = { title: string; markdown: string; href: string };

/**
 * The docs section for a screen. The docs text loads on first use (it is most of the docs bundle);
 * if it cannot load, the dialog still opens with the shortcuts and their switch.
 */
function useScreenSection(screen: ScreenId | undefined): Section | "failed" | null {
  const [section, setSection] = useState<Section | "failed" | null>(null);
  useEffect(() => {
    if (!screen || screen === "docs") return setSection(null);
    let live = true;
    import("../lib/docsSection.js").then(
      (m) => live && setSection(m.screenSection(screen)),
      () => live && setSection("failed"),
    );
    return () => {
      live = false;
    };
  }, [screen]);
  return section;
}
