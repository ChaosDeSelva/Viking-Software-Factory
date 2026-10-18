import React, {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import { twMerge } from "tailwind-merge";
export const cn = (...values: (string | undefined | false)[]) =>
  twMerge(values.filter(Boolean).join(" "));
const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";
const buttonVariants = {
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-accent/50 hover:bg-accent/10",
  primary:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-semibold text-[#091610] hover:brightness-110",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-transparent px-3 py-2 text-sm text-muted hover:bg-accent/10 hover:text-foreground",
  danger:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger hover:bg-danger/20",
  unstyled: "",
};
export function Button({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof buttonVariants }) {
  return (
    <button
      className={cn(
        "min-h-11 cursor-pointer transition duration-150 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        focus,
        buttonVariants[variant],
        variant !== "unstyled" && "h-11 shrink-0 whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}
const fieldStyle =
  "w-full min-w-0 rounded-lg border border-line bg-input px-3.5 py-2.5 text-base text-foreground placeholder:text-muted/75 transition-colors hover:border-muted/50 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-40";
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        type === "checkbox"
          ? "size-5 shrink-0 accent-accent align-middle"
          : cn(fieldStyle, "h-11"),
        className,
      )}
      {...props}
    />
  );
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(fieldStyle, "min-h-32 resize-y leading-relaxed", className)}
      {...props}
    />
  );
}
const FieldContext = createContext<string | undefined>(undefined);
export function Field({
  className,
  children,
  ...props
}: ComponentProps<"label">) {
  const id = useId();
  return (
    <FieldContext.Provider value={id}>
      <label
        id={id}
        className={cn(
          "mb-3 block text-sm leading-7 text-muted [&>input]:mt-1 [&>textarea]:mt-1 [&>button]:mt-1",
          className,
        )}
        {...props}
      >
        {children}
      </label>
    </FieldContext.Provider>
  );
}
// Option is a declaration consumed by Select, never a native dropdown.
export function Option(_props: ComponentProps<"option">) {
  return null;
}
type SelectProps = Omit<ComponentProps<"button">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
};
export function Select({
  value,
  onValueChange,
  children,
  className,
  disabled,
  ...props
}: SelectProps) {
  const label = useContext(FieldContext);
  const options: { value: string; label: ReactNode; disabled?: boolean }[] = [];
  function collect(nodes: ReactNode) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement<ComponentProps<"option">>(child)) return;
      if (child.type === React.Fragment) collect(child.props.children);
      else
        options.push({
          value: String(child.props.value ?? ""),
          label: child.props.children,
          disabled: child.props.disabled,
        });
    });
  }
  collect(children);
  const empty = "__heimdall_empty_option__";
  return (
    <SelectPrimitive.Root
      value={value || empty}
      onValueChange={(v) => onValueChange(v === empty ? "" : v)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        aria-labelledby={props["aria-label"] ? undefined : label}
        className={cn(
          fieldStyle,
          "flex h-11 min-h-11 items-center justify-between gap-3 text-left [&>span:first-child]:truncate",
          focus,
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon aria-hidden>⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={8}
          className="select-menu z-[100] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border border-line bg-surface p-1.5 text-foreground shadow-2xl"
        >
          <SelectPrimitive.ScrollUpButton className="text-center text-muted">
            ⌃
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value || empty}
                disabled={o.disabled}
                className="relative flex min-h-11 cursor-pointer items-center gap-3 rounded-lg py-2 pr-8 pl-3 text-sm outline-none data-highlighted:bg-accent/15 data-highlighted:text-accent data-disabled:opacity-40"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2">
                  ✓
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="text-center text-muted">
            ⌄
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "panel min-w-0 rounded-xl border border-line bg-surface p-6",
        className,
      )}
      {...props}
    />
  );
}
export function CodeBlock({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-lg border border-line bg-input p-4 font-mono text-sm leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  );
}
export function Disclosure({ className, ...props }: ComponentProps<"details">) {
  return (
    <details
      className={cn(
        "group my-4 rounded-lg border border-line/70 px-4 open:bg-input/40",
        className,
      )}
      {...props}
    />
  );
}
export function DisclosureTrigger({
  className,
  ...props
}: ComponentProps<"summary">) {
  return (
    <summary
      className={cn(
        "cursor-pointer py-3 text-sm text-muted transition-colors hover:text-accent",
        focus,
        className,
      )}
      {...props}
    />
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty flex min-h-24 items-center gap-4 rounded-lg border border-dashed border-line bg-input/40 p-5 text-sm text-muted">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line text-accent"
        aria-hidden
      >
        ◇
      </span>
      <span>{children}</span>
    </div>
  );
}
const positive = [
  "completed",
  "approved",
  "satisfied",
  "connected",
  "passed",
  "delivered_pending_merge",
  "clear",
];
const negative = ["blocked", "failed", "needs_attention", "awaiting_approval"];
const running = ["running", "starting", "leased", "verifying", "busy"];
export function StatusBadge({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const text = String(value ?? "unknown");
  const tone = positive.includes(text)
    ? "border-success/30 bg-success/10 text-success"
    : negative.includes(text)
      ? "border-danger/30 bg-danger/10 text-danger"
      : running.includes(text)
        ? "border-accent/30 bg-accent/10 text-accent"
        : "border-line bg-panel text-muted";
  return (
    <span
      className={cn(
        "badge inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium leading-5 [overflow-wrap:anywhere]",
        tone,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          running.includes(text) && "animate-pulse motion-reduce:animate-none",
        )}
      />
      {text.replaceAll("_", " ")}
    </span>
  );
}
export function Progress({
  value = 0,
  max = 100,
  className,
  ...props
}: ComponentProps<"progress">) {
  return (
    <progress
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full accent-accent",
        className,
      )}
      value={value}
      max={max}
      {...props}
    />
  );
}
export function DialogSurface({
  children,
  titleId,
  onClose,
  side = "center",
  busy = false,
  className,
}: {
  children: ReactNode;
  titleId: string;
  onClose: () => void;
  side?: "center" | "right";
  busy?: boolean;
  className?: string;
}) {
  const opener = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[#030711]/75 backdrop-blur-md" />
        <DialogPrimitive.Content
          aria-labelledby={titleId}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener.current?.focus();
          }}
          className={cn(
            "fixed z-50 overflow-y-auto overscroll-contain border border-line bg-surface text-foreground shadow-2xl outline-none",
            side === "right"
              ? "drawer inset-y-0 right-0 w-full max-w-[840px] p-6 sm:p-9"
              : "confirm top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6 sm:p-8",
            className,
          )}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export const DialogTitle = DialogPrimitive.Title;

export function ScrollArea({ children, className, "aria-label": label = "Scrollable content", ...props }: ComponentProps<"div">) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const id = useId();
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setEdges({ left: element.scrollLeft > 2, right: element.scrollWidth - element.clientWidth - element.scrollLeft > 2 });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
      update();
    };
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(element, { childList: true });
    observeChildren();
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => { mutations.disconnect(); resize.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  const move = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * .75, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  return <div className="scroll-area">
    {(edges.left || edges.right) && <div className="scroll-hint">
      <span>{edges.left && edges.right ? "More content on both sides" : edges.right ? "More content to the right" : "More content to the left"}</span>
      <div className="scroll-controls"><Button aria-label={`Scroll ${label} left`} aria-controls={id} disabled={!edges.left} onClick={() => move(-1)}>←</Button><Button aria-label={`Scroll ${label} right`} aria-controls={id} disabled={!edges.right} onClick={() => move(1)}>→</Button></div>
    </div>}
    <div {...props} id={id} ref={viewport} role="region" aria-label={label} tabIndex={0} className={cn("overflow-x-auto", className)}>{children}</div>
  </div>;
}
