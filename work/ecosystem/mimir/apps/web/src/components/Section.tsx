import { useId, type ReactNode, type Ref } from "react";

/** A labelled region: `<section>` named by its `<h2>`. */
export function Section({
  title,
  children,
  actions,
  headingRef,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** When given, the heading is programmatically focusable (focus recovery targets). */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mb-6">
      <div className="mb-2 flex items-center gap-3">
        <h2
          id={id}
          ref={headingRef}
          {...(headingRef ? { tabIndex: -1 } : {})}
          className="text-xl font-semibold"
        >
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-2xl font-semibold">{children}</h1>;
}
