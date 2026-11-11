import { Card } from "@factory/ui";
import type { ReactNode } from "react";

/**
 * A page region in a bordered card: `<section>` named by its `<h2>`. `flush` is for bodies that
 * are a table or a list (no inner padding, a rule under the header).
 */
export function Section({
  title,
  children,
  actions,
  description,
  term,
  count,
  flush,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  /** Glossary term for an InfoHint beside the title. */
  term?: string;
  count?: number;
  flush?: boolean;
  className?: string;
}) {
  return (
    <Card
      title={title}
      headingLevel={2}
      actions={actions}
      description={description}
      term={term}
      count={count}
      flush={flush}
      className={className}
    >
      {children}
    </Card>
  );
}
