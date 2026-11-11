import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as ToastPrimitive from "@radix-ui/react-toast";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Icon } from "../icons.js";
import { cn, focusRing, Link } from "../lib.js";

const floating =
  "z-[var(--z-dropdown)] rounded-md border border-line bg-raised text-fg shadow-1 fui-anim-pop";

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 400,
  open,
}: {
  content: ReactNode;
  /** One focusable element; it becomes the trigger. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  delay?: number | undefined;
  open?: boolean | undefined;
}) {
  if (content == null || content === "") return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={200}>
      <TooltipPrimitive.Root {...(open === undefined ? {} : { open })}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="fui-anim-pop z-[var(--z-tooltip)] max-w-72 rounded-md bg-fg px-3 py-2 text-xs leading-4 text-canvas shadow-1"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-fg" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/** Same shape as `@factory/docs` glossary.json entries. */
export interface GlossaryEntry {
  term: string;
  short: string;
  long?: string | undefined;
  seeAlso?: string[] | undefined;
}
interface GlossaryValue {
  lookup: (term: string) => GlossaryEntry | undefined;
  docsHref: (term: string) => string;
}
export const glossarySlug = (term: string) =>
  term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const GlossaryContext = createContext<GlossaryValue>({
  lookup: () => undefined,
  docsHref: (term) => `/docs/glossary#${glossarySlug(term)}`,
});

export function GlossaryProvider({
  entries,
  docsHref = (term) => `/docs/glossary#${glossarySlug(term)}`,
  children,
}: {
  entries: readonly GlossaryEntry[];
  docsHref?: ((term: string) => string) | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => {
    const index = new Map(entries.map((e) => [glossarySlug(e.term), e]));
    return { lookup: (term: string) => index.get(glossarySlug(term)), docsHref };
  }, [entries, docsHref]);
  return <GlossaryContext.Provider value={value}>{children}</GlossaryContext.Provider>;
}
export const useGlossary = () => useContext(GlossaryContext);

/**
 * "?" button that opens a short definition. With `term`, text comes from the glossary;
 * `children` is the fallback (or the whole text when there is no glossary entry).
 */
export function InfoHint({
  term,
  label,
  children,
  docsHref,
}: {
  term?: string | undefined;
  /** Accessible name of the button; defaults to "What is {term}?". */
  label?: string | undefined;
  children?: ReactNode | undefined;
  docsHref?: string | undefined;
}) {
  const glossary = useGlossary();
  const entry = term ? glossary.lookup(term) : undefined;
  const body = entry?.short ?? children;
  if (!body) return null;
  const href = docsHref ?? (term ? glossary.docsHref(entry?.term ?? term) : undefined);
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={label ?? (term ? `What is ${entry?.term ?? term}?` : "More information")}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-subtle transition-colors hover:bg-hover hover:text-fg data-[state=open]:text-accent-fg",
          focusRing,
        )}
      >
        <Icon name="help" size={15} />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className={cn(floating, "w-72 max-w-[calc(100vw-24px)] p-4 text-sm")}
        >
          {term && <p className="mb-1 font-semibold">{entry?.term ?? term}</p>}
          <div className="text-muted">{body}</div>
          {href && (
            <Link
              href={href}
              className={cn(
                "mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline",
                focusRing,
              )}
            >
              Read more in Docs <Icon name="arrowRight" size={14} />
            </Link>
          )}
          <PopoverPrimitive.Arrow className="fill-raised" width={12} height={6} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export function PopoverContent({
  className,
  children,
  ...props
}: PopoverPrimitive.PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn(floating, "p-4", className)}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

type DialogSize = "sm" | "md" | "lg";
const dialogWidth: Record<DialogSize, string> = {
  sm: "max-w-[440px]",
  md: "max-w-[560px]",
  lg: "max-w-[800px]",
};

interface SurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** Buttons, right-aligned (stacked full width ≤640px). */
  footer?: ReactNode | undefined;
  /** Blocks Escape and outside clicks while an action is in flight. */
  busy?: boolean | undefined;
  className?: string | undefined;
}

/** Escape/outside-click blocking while busy, and focus back to whatever opened the surface. */
function useSurface(open: boolean, busy: boolean | undefined) {
  const opener = useRef<HTMLElement | null>(null);
  if (open && !opener.current && typeof document !== "undefined")
    opener.current = document.activeElement as HTMLElement | null;
  const block = (e: Event) => {
    if (busy) e.preventDefault();
  };
  return {
    onEscapeKeyDown: block,
    onPointerDownOutside: block,
    onInteractOutside: block,
    onCloseAutoFocus: (e: Event) => {
      const el = opener.current;
      opener.current = null;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}

function CloseButton() {
  return (
    <DialogPrimitive.Close
      aria-label="Close"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg",
        focusRing,
      )}
    >
      <Icon name="x" />
    </DialogPrimitive.Close>
  );
}

function SurfaceHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-sm text-muted">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      <CloseButton />
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3 [&>*]:w-full sm:[&>*]:w-auto">
      {children}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  busy,
  size = "md",
  role,
  className,
}: SurfaceProps & { size?: DialogSize; role?: "dialog" | "alertdialog" }) {
  const guards = useSurface(open, busy);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => (busy && !v ? undefined : onOpenChange(v))}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fui-anim-fade fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <DialogPrimitive.Content
          {...(role ? { role } : {})}
          {...(description ? {} : { "aria-describedby": undefined })}
          {...guards}
          className={cn(
            "fui-anim-pop fixed top-1/2 left-1/2 z-[var(--z-dialog)] flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-lg border border-line bg-raised p-6 text-fg shadow-2 outline-none",
            dialogWidth[size],
            className,
          )}
        >
          <SurfaceHeader title={title} description={description} />
          {children ? <div className="min-w-0 text-sm">{children}</div> : null}
          {footer ? <Footer>{footer}</Footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Destructive confirmation (archive, cancel run, terminate, delete data). */
export function ConfirmDialog({
  confirmLabel,
  onConfirm,
  cancelLabel = "Cancel",
  tone = "danger",
  ...props
}: Omit<SurfaceProps, "footer"> & {
  confirmLabel: string;
  onConfirm: () => void;
  cancelLabel?: string | undefined;
  tone?: "danger" | "primary" | undefined;
}) {
  return (
    <Dialog
      {...props}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <DialogPrimitive.Close
            disabled={props.busy}
            className={cn(
              "inline-flex h-control-md items-center justify-center rounded-md border border-line bg-surface px-4 text-sm font-medium hover:bg-hover disabled:opacity-50",
              focusRing,
            )}
          >
            {cancelLabel}
          </DialogPrimitive.Close>
          <button
            type="button"
            onClick={onConfirm}
            disabled={props.busy}
            aria-busy={props.busy || undefined}
            className={cn(
              "inline-flex h-control-md items-center justify-center rounded-md px-4 text-sm font-semibold disabled:opacity-60",
              tone === "danger"
                ? "bg-danger-fg text-surface hover:opacity-90"
                : "bg-accent text-on-accent hover:bg-accent-hover",
              focusRing,
            )}
          >
            {props.busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    />
  );
}

/** Side panel for record inspectors (right) or a bottom sheet on phones (bottom). */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  busy,
  side = "right",
  className,
}: SurfaceProps & { side?: "right" | "bottom" }) {
  const guards = useSurface(open, busy);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => (busy && !v ? undefined : onOpenChange(v))}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fui-anim-fade fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <DialogPrimitive.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          {...guards}
          className={cn(
            "fixed z-[var(--z-dialog)] flex flex-col bg-raised text-fg shadow-2 outline-none",
            side === "right"
              ? "fui-anim-right inset-y-0 right-0 w-full max-w-[560px] border-l border-line"
              : "fui-anim-up inset-x-0 bottom-0 max-h-[85dvh] rounded-t-lg border-t border-line pb-[env(safe-area-inset-bottom)]",
            className,
          )}
        >
          {side === "bottom" && (
            <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong" />
          )}
          <div className="border-b border-line px-6 py-4">
            <SurfaceHeader title={title} description={description} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-sm">{children}</div>
          {footer ? (
            <div className="border-t border-line px-6 py-4">
              <Footer>{footer}</Footer>
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type ToastTone = "info" | "success" | "warning" | "danger";
export interface ToastInput {
  title: string;
  description?: string | undefined;
  tone?: ToastTone | undefined;
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
}
const ToastContext = createContext<(t: ToastInput) => void>(() => {
  throw new Error("useToast() needs <ToastProvider> (AppShell includes one)");
});
export const useToast = () => useContext(ToastContext);

const toastTone: Record<ToastTone, string> = {
  info: "text-progress-fg",
  success: "text-success-fg",
  warning: "text-warning-fg",
  danger: "text-danger-fg",
};
const toastIcon: Record<ToastTone, "info" | "check" | "alert"> = {
  info: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
};

/** Errors and warnings persist until dismissed; info and success clear after 5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback(
    (t: ToastInput) => setItems((list) => [...list, { ...t, id: Date.now() + Math.random() }]),
    [],
  );
  return (
    <ToastContext.Provider value={push}>
      <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
        {children}
        {items.map((t) => {
          const tone = t.tone ?? "info";
          const sticky = tone === "danger" || tone === "warning";
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={sticky ? Infinity : 5000}
              type={sticky ? "foreground" : "background"}
              onOpenChange={(open) => {
                if (!open) setItems((list) => list.filter((x) => x.id !== t.id));
              }}
              className="fui-anim-pop flex items-start gap-3 rounded-lg border border-line bg-raised p-4 text-sm shadow-3"
            >
              <span className={cn("mt-0.5", toastTone[tone])}>
                <Icon name={toastIcon[tone]} />
              </span>
              <div className="min-w-0 flex-1">
                <ToastPrimitive.Title className="font-semibold">{t.title}</ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="mt-1 text-muted">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
                {t.action && (
                  <ToastPrimitive.Action
                    altText={t.action.label}
                    onClick={t.action.onClick}
                    className={cn("mt-2 font-medium text-accent-fg hover:underline", focusRing)}
                  >
                    {t.action.label}
                  </ToastPrimitive.Action>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label="Dismiss"
                className={cn("rounded-sm text-muted hover:text-fg", focusRing)}
              >
                <Icon name="x" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-[calc(var(--bottombar-height)+16px+env(safe-area-inset-bottom))] z-[var(--z-toast)] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
