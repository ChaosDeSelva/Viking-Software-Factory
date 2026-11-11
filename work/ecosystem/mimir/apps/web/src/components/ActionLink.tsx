import { cn, focusRing, Icon, Link, type IconName } from "@factory/ui";
import type { ReactNode } from "react";

/** A link that looks like a secondary (or primary) button: for "next step" actions that navigate. */
export function ActionLink({
  href,
  children,
  icon,
  primary = false,
  size = "sm",
}: {
  href: string;
  children: ReactNode;
  icon?: IconName;
  primary?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 font-medium whitespace-nowrap transition-colors",
        size === "sm" ? "h-control-sm text-sm" : "h-control-md text-sm",
        primary
          ? "border-accent bg-accent text-on-accent hover:bg-accent-hover"
          : "border-line bg-surface text-fg hover:bg-hover",
        focusRing,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </Link>
  );
}
