// Mermaid diagrams in agent-written Markdown. Mermaid is loaded only when a page has a diagram,
// runs with `securityLevel: "strict"` (no scripts, no clicks, labels escaped), and a block that
// does not parse is shown as its source with the parser's message.
import type { CodeRenderer } from "@factory/ui";
import { useEffect, useId, useState } from "react";

let loaded: Promise<typeof import("mermaid").default> | null = null;
const mermaid = () => {
  loaded ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: "strict" });
    return m.default;
  });
  return loaded;
};

const dark = () =>
  document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" &&
    matchMedia("(prefers-color-scheme: dark)").matches);

export function MermaidDiagram({ code }: { code: string }) {
  const id = `m${useId().replace(/[^\w]/g, "")}`;
  const [state, setState] = useState<
    { svg: string } | { error: string } | null
  >(null);
  useEffect(() => {
    let gone = false;
    void mermaid()
      .then(async (m) => {
        m.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark() ? "dark" : "default",
        });
        const { svg } = await m.render(id, code);
        if (!gone) setState({ svg });
      })
      .catch((e: unknown) => {
        // A failed render leaves a stray error element in the body.
        document.getElementById(`d${id}`)?.remove();
        if (!gone)
          setState({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      gone = true;
    };
  }, [code, id]);
  if (state && "svg" in state)
    return (
      <figure
        className={
          // A timeline is unreadable shrunk to a phone's width; it keeps a readable width and
          // scrolls sideways instead.
          /^\s*gantt\b/.test(code)
            ? "my-2 overflow-x-auto rounded-md border border-line bg-surface p-3 [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:min-w-[640px]"
            : "my-2 overflow-x-auto rounded-md border border-line bg-surface p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        }
        tabIndex={0}
        aria-label="Diagram"
        // The SVG comes from Mermaid in strict mode, which escapes labels and drops scripts.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  return (
    <figure className="my-2 flex flex-col gap-1">
      <pre data-lang="mermaid">
        <code>{code}</code>
      </pre>
      <figcaption className="text-xs text-muted">
        {state
          ? `This diagram could not be drawn: ${state.error.split("\n")[0]}`
          : "Drawing the diagram…"}
      </figcaption>
    </figure>
  );
}

/** Pass to `Markdown`/`ResearchDoc` `renderCode`: draws ```mermaid blocks. */
export const renderDiagrams: CodeRenderer = (lang, code) =>
  lang === "mermaid" ? <MermaidDiagram code={code} /> : undefined;
