import type { Selection } from "./types.js";

/** Human-readable lines for a selection. A pass-through of Brokkr's rationale, nothing added. */
export function explainSelection(selection: Selection): string[] {
  return selection.rationale.map(
    (r) =>
      `${r.kind} ${r.name}: ${r.selected ? "selected" : "not selected"} (${r.reason}${
        r.score === undefined ? "" : `; score ${r.score}`
      })`,
  );
}
