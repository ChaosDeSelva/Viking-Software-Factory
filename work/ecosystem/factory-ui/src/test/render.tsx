import { render, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

/** Render with a userEvent instance (pointer checks off: jsdom has no layout). */
export function setup(ui: ReactElement, options?: RenderOptions) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return { user, ...render(ui, options) };
}

/** Text of the elements named by aria-describedby (what a screen reader announces). */
export function description(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
    .join(" ")
    .trim();
}

export function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked";
}
