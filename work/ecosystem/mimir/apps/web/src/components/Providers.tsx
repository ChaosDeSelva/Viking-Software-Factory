import { GlossaryProvider, LinkProvider, type LinkProps } from "@factory/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { GLOSSARY, glossaryHref } from "../lib/docs.js";
import { ProjectScopeProvider } from "../lib/scope.js";

/** Every link @factory/ui draws goes through the router; other origins stay plain anchors. */
function renderLink({ href, ...props }: LinkProps) {
  return /^[a-z]+:/i.test(href) ? <a href={href} {...props} /> : <Link to={href} {...props} />;
}

/** Providers that need the router and the store: links, glossary InfoHints, project scope. */
export function RoutedProviders({ children }: { children: ReactNode }) {
  return (
    <LinkProvider render={renderLink}>
      <GlossaryProvider entries={GLOSSARY} docsHref={glossaryHref}>
        <ProjectScopeProvider>{children}</ProjectScopeProvider>
      </GlossaryProvider>
    </LinkProvider>
  );
}
