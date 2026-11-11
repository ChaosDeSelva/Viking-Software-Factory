import { screenHref } from "@factory/docs";
import { Link, Page, PageHeader, type Crumb, type Scope } from "@factory/ui";
import type { ReactNode } from "react";
import { usePageScope } from "../lib/scope.js";

/** Screen ids from @factory/docs NAV (mimir); they also key the "?" help and the Docs link. */
export type ScreenId =
  | "overview"
  | "missions"
  | "mission-detail"
  | "crews"
  | "crew-detail"
  | "agent"
  | "reviews"
  | "activity"
  | "projects"
  | "settings"
  | "docs";

/**
 * Page frame for every screen: header (title, one-line description with "Learn more" into the
 * docs, scope chip, actions) and the content column. Project pages show the selected project in
 * the chip; global pages pass `global`.
 */
export function Screen({
  screen,
  title,
  description,
  term,
  global = false,
  actions,
  breadcrumbs,
  meta,
  children,
}: {
  screen: ScreenId;
  title: ReactNode;
  description?: ReactNode;
  term?: string;
  global?: boolean;
  actions?: ReactNode;
  breadcrumbs?: readonly Crumb[];
  meta?: ReactNode;
  children: ReactNode;
}) {
  const projectScope = usePageScope();
  const scope: Scope = global ? { global: true } : projectScope;
  const href = screenHref("mimir", screen);
  return (
    <Page>
      <PageHeader
        title={title}
        scope={scope}
        description={description}
        // learnMore keeps the link and the term's InfoHint on one line (no lone wrapped "?").
        learnMore={
          description && href ? (
            <Link
              href={href}
              className="font-medium text-accent-fg underline-offset-2 hover:underline"
            >
              Learn more
            </Link>
          ) : undefined
        }
        term={term}
        actions={actions}
        breadcrumbs={breadcrumbs}
        meta={meta}
      />
      {children}
    </Page>
  );
}
