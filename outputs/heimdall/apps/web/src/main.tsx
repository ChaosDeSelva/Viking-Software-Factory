// Entry: shared providers (in-app links go through the router; InfoHints read the shared glossary).
import { glossary, getTerm, termHref } from "@factory/docs";
import { GlossaryProvider, LinkProvider, type LinkProps } from "@factory/ui";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { isPlainClick, navigate } from "./lib/router";
import "./style.css";

/** Same-origin page links navigate in place; API paths, other apps and new-tab clicks do not. */
function RouterLink({ href, onClick, ...props }: LinkProps) {
  const internal =
    href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/");
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (internal && isPlainClick(e) && !props.target && !props.download) {
          e.preventDefault();
          navigate(href);
        }
      }}
    />
  );
}

const docsHref = (term: string) => {
  const entry = getTerm(term);
  return entry ? termHref(entry) : "/docs/glossary";
};

createRoot(document.getElementById("root")!).render(
  <LinkProvider render={(p) => <RouterLink {...p} />}>
    <GlossaryProvider entries={glossary} docsHref={docsHref}>
      <App />
    </GlossaryProvider>
  </LinkProvider>,
);
