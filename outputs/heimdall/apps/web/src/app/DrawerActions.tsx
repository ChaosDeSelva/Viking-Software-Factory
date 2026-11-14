// A drawer's decisions sit in its sticky footer, never below the fold: a section renders its
// buttons inside <DrawerActions> where its logic lives, and they appear in the footer.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The footer element of the open drawer, or null outside a drawer. */
export const DrawerFooter = createContext<HTMLElement | null>(null);

export function DrawerActions({ children }: { children: ReactNode }) {
  const footer = useContext(DrawerFooter);
  const actions = <div className="flex min-w-0 flex-col gap-2">{children}</div>;
  return footer ? createPortal(actions, footer) : actions;
}
