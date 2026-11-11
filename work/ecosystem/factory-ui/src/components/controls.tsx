import * as RadioGroup from "@radix-ui/react-radio-group";
import * as SelectPrimitive from "@radix-ui/react-select";
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { cn, focusRing } from "../lib.js";
import { InfoHint, Tooltip } from "./overlay.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ControlSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary: "bg-surface text-fg border-line hover:bg-hover hover:border-line-strong",
  ghost: "bg-transparent text-fg border-transparent hover:bg-hover",
  danger: "bg-surface text-danger-fg border-danger-border hover:bg-danger-bg",
  link: "h-auto! border-transparent bg-transparent px-0! text-accent-fg underline-offset-4 hover:underline",
};
const sizes: Record<ControlSize, string> = {
  sm: "h-control-sm px-3 gap-1.5 text-sm",
  md: "h-control-md px-4 gap-2 text-sm",
  lg: "h-control-lg px-5 gap-2 text-md",
};

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant | undefined;
  size?: ControlSize | undefined;
  loading?: boolean | undefined;
  /**
   * Why the button is disabled: shown as a tooltip and announced as the description only, so the
   * accessible name stays the visible label. Implies disabled.
   */
  disabledReason?: string | undefined;
  icon?: IconName | undefined;
  iconRight?: IconName | undefined;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabledReason,
  icon,
  iconRight,
  className,
  children,
  disabled,
  onClick,
  type = "button",
  "aria-describedby": describedBy,
  ...props
}: ButtonProps) {
  const reasonId = useId();
  // A reasoned-disabled button stays focusable (aria-disabled) so the reason can be read.
  const softDisabled = Boolean(disabledReason);
  const button = (
    <button
      type={type}
      disabled={softDisabled ? undefined : disabled || loading}
      aria-disabled={softDisabled || undefined}
      aria-busy={loading || undefined}
      aria-describedby={
        [softDisabled ? reasonId : undefined, describedBy].filter(Boolean).join(" ") || undefined
      }
      onClick={softDisabled || loading ? (e) => e.preventDefault() : onClick}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors duration-[var(--duration-fast)] select-none",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        variant === "primary" && "font-semibold",
        sizes[size],
        variants[variant],
        focusRing,
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} />}
      {/* `hidden` keeps the reason out of the name computed from content, while
          aria-describedby still reads hidden targets; staying inside the button keeps a single
          element for asChild/Slot parents. */}
      {softDisabled && (
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      )}
    </button>
  );
  return softDisabled ? <Tooltip content={disabledReason}>{button}</Tooltip> : button;
}

/** Square icon-only button; `label` is both its accessible name and its tooltip. */
export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  className,
  tooltip = true,
  ...props
}: Omit<ButtonProps, "children" | "icon" | "iconRight"> & {
  icon: IconName;
  label: string;
  tooltip?: boolean | undefined;
}) {
  const box = { sm: "size-control-sm", md: "size-control-md", lg: "size-control-lg" }[size];
  const button = (
    <Button
      {...props}
      variant={variant}
      size={size}
      aria-label={label}
      className={cn(box, "px-0!", className)}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 18} />
    </Button>
  );
  return tooltip && !props.disabledReason ? <Tooltip content={label}>{button}</Tooltip> : button;
}

interface FieldContextValue {
  id: string;
  describedBy?: string | undefined;
  invalid: boolean;
  required: boolean;
}
const FieldContext = createContext<FieldContextValue | null>(null);
/** Props a control needs to join its Field: id, aria-describedby, aria-invalid, required. */
export function useFieldControl(props: { id?: string | undefined; invalid?: boolean | undefined }) {
  const field = useContext(FieldContext);
  const invalid = props.invalid ?? field?.invalid ?? false;
  return {
    id: props.id ?? field?.id,
    "aria-describedby": field?.describedBy,
    "aria-invalid": invalid || undefined,
    ...(field?.required ? { "aria-required": true } : {}),
  };
}

/** Label (htmlFor), optional hint, error and InfoHint around one control. */
export function Field({
  label,
  hint,
  error,
  info,
  term,
  required = false,
  children,
  className,
  id: idProp,
}: {
  label: ReactNode;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  /** Inline InfoHint text, or use `term` for a glossary lookup. */
  info?: ReactNode | undefined;
  term?: string | undefined;
  required?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
  id?: string | undefined;
}) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cn("flex min-w-0 flex-col gap-label", className)}>
        <div className="flex items-center gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-fg">
            {label}
            {required && (
              <span className="text-danger-fg" aria-hidden>
                {" "}
                *
              </span>
            )}
          </label>
          {(info || term) && (
            <InfoHint
              {...(term ? { term } : {})}
              label={`About ${typeof label === "string" ? label : "this field"}`}
            >
              {info}
            </InfoHint>
          )}
        </div>
        {children}
        {hint && !error && (
          <p id={hintId} className="text-xs text-muted">
            {hint}
          </p>
        )}
        {hint && error && (
          <p id={hintId} className="sr-only">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="flex items-center gap-1.5 text-xs font-medium text-danger-fg">
            <Icon name="alert" size={14} />
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

const fieldBox =
  "w-full min-w-0 rounded-md border border-line bg-raised text-sm text-fg transition-colors placeholder:text-subtle hover:border-line-strong focus:border-focus focus:outline-2 focus:outline-offset-0 focus:outline-focus/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger-fg";

export function Input({
  className,
  invalid,
  prefix,
  suffix,
  id,
  ...props
}: Omit<ComponentProps<"input">, "prefix"> & {
  invalid?: boolean | undefined;
  /** Icon name or node shown inside the left edge (e.g. "search"). */
  prefix?: IconName | ReactNode | undefined;
  suffix?: ReactNode | undefined;
}) {
  const control = useFieldControl({ id, invalid });
  const input = (
    <input
      {...control}
      {...props}
      className={cn(
        fieldBox,
        "h-control-md px-3",
        prefix != null && "pl-9",
        suffix != null && "pr-10",
        !prefix && !suffix && className,
      )}
    />
  );
  if (prefix == null && suffix == null) return input;
  return (
    <div className={cn("relative flex min-w-0 items-center", className)}>
      {prefix != null && (
        <span className="pointer-events-none absolute left-3 text-subtle">
          {typeof prefix === "string" ? <Icon name={prefix as IconName} /> : prefix}
        </span>
      )}
      {input}
      {suffix != null && <span className="absolute right-2 flex items-center">{suffix}</span>}
    </div>
  );
}

export function Textarea({
  className,
  invalid,
  id,
  ...props
}: ComponentProps<"textarea"> & { invalid?: boolean }) {
  const control = useFieldControl({ id, invalid });
  return (
    <textarea
      {...control}
      {...props}
      className={cn(fieldBox, "min-h-24 resize-y px-3 py-2 leading-5", className)}
    />
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean | undefined;
}
const EMPTY = "__factory_empty__";

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  invalid,
  id,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
  size?: "sm" | "md" | undefined;
  "aria-label"?: string | undefined;
}) {
  const control = useFieldControl({ id, invalid });
  return (
    <SelectPrimitive.Root
      value={value === "" ? EMPTY : value}
      onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)}
      {...(disabled ? { disabled } : {})}
    >
      <SelectPrimitive.Trigger
        {...control}
        aria-label={ariaLabel}
        className={cn(
          fieldBox,
          "flex items-center justify-between gap-2 px-3 text-left data-[placeholder]:text-subtle [&>span:first-child]:truncate",
          size === "sm" ? "h-control-sm" : "h-control-md",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-muted">
          <Icon name="chevronDown" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="fui-anim-pop z-[var(--z-dropdown)] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-line bg-raised p-1 text-fg shadow-1"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value === "" ? EMPTY : o.value}
                {...(o.disabled ? { disabled: true } : {})}
                className="relative flex h-control-sm cursor-pointer items-center rounded-sm pr-8 pl-3 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 text-accent-fg">
                  <Icon name="check" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Checkbox({
  label,
  description,
  className,
  id: idProp,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; description?: ReactNode }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={description ? `${id}-d` : undefined}
        className={cn(
          "mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm accent-[var(--accent)] disabled:cursor-not-allowed",
          focusRing,
        )}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm text-fg">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  id: idProp,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
}) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-[var(--duration-fast)] disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-line-strong bg-sunken",
          focusRing,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-4 rounded-full shadow-1 transition-transform duration-[var(--duration-fast)]",
            checked ? "translate-x-[19px] bg-white" : "translate-x-[3px] bg-muted",
          )}
        />
      </button>
    </div>
  );
}

/** One-of-N choice shown as joined buttons (modes, views). Arrow keys move; it is a radio group. */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  disabled,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: ReactNode; disabled?: boolean; icon?: IconName }[];
  /** Accessible name of the group. */
  label: string;
  size?: "sm" | "md" | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onValueChange}
      aria-label={label}
      orientation="horizontal"
      {...(disabled ? { disabled } : {})}
      className={cn(
        "inline-flex w-fit max-w-full items-stretch gap-0.5 overflow-x-auto rounded-md border border-line bg-sunken p-0.5",
        size === "sm" ? "h-control-sm" : "h-control-md",
        className,
      )}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          {...(o.disabled ? { disabled: true } : {})}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50",
            "data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-[0_0_0_1px_var(--border-default)]",
            focusRing,
          )}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
