import { useEffect, useState } from "react";
import { Button, DialogSurface, DialogTitle, Input, EmptyState } from "./ui";
export type JumpItem = {
  id: string;
  label: string;
  group: string;
  run: () => void;
};
export function CommandPalette({
  items,
  onClose,
}: {
  items: JumpItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const results = items
    .filter((item) =>
      (item.label + " " + item.group)
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 30);
  return (
    <DialogSurface titleId="jump-title" onClose={onClose}>
      <DialogTitle id="jump-title" className="mb-4 text-xl font-semibold">
        Jump to anything
      </DialogTitle>
      <Input
        autoFocus
        aria-label="Search navigation and records"
        placeholder="Search pages, tasks, projects…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            document
              .querySelector<HTMLButtonElement>("[data-jump-result]")
              ?.focus();
          }
        }}
      />
      <p className="my-3 text-xs text-muted">
        ↓ to browse · Enter to open · Esc to close
      </p>
      <div
        className="max-h-[50vh] overflow-auto"
        onKeyDown={(e) => {
          if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault();
          const nodes = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[data-jump-result]",
            ),
          );
          const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
          nodes[
            (i + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length
          ]?.focus();
        }}
      >
        {results.map((item) => (
          <Button
            data-jump-result
            key={item.id}
            variant="ghost"
            className="w-full justify-between text-left"
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span className="min-w-0 truncate text-foreground">
              {item.label}
            </span>
            <span className="shrink-0 text-xs text-muted">{item.group}</span>
          </Button>
        ))}
        {!results.length && (
          <EmptyState>No matching pages or records.</EmptyState>
        )}
      </div>
    </DialogSurface>
  );
}
export function useCommandShortcut(enabled: boolean, open: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (enabled && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, open]);
}
