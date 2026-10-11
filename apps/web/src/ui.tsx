// Small parts every screen uses.
import { Tooltip } from "@base-ui/react/tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, type LucideProps, RotateCw } from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import { twMerge } from "tailwind-merge";

/** A Lucide icon, or one drawn the same way. */
export type Icon = ComponentType<LucideProps>;

/**
 * Rufi's one button: four looks, one size, an icon before a short label.
 * main: the one main next action on a screen, at most one. plain: other
 * actions. quiet: actions repeated on rows, and small known actions as an
 * icon only. delete: only the last step of a delete that can't be undone.
 * 36 px high with a label, 32 × 32 px with only an icon. A link that acts
 * like a button takes the same look.
 */
export const buttonLook = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap disabled:opacity-50",
  {
    variants: {
      look: {
        main: "bg-accent text-on-accent not-disabled:hover:bg-accent-hover",
        plain: "border border-line bg-surface not-disabled:hover:bg-page",
        quiet: "not-disabled:hover:bg-side",
        delete:
          "border border-danger/35 bg-danger-soft text-danger not-disabled:hover:border-danger/70",
      },
      shape: { label: "h-9 px-3.5", icon: "size-8" },
    },
    compoundVariants: [
      {
        look: "quiet",
        shape: "icon",
        className: "text-muted not-disabled:hover:text-ink",
      },
    ],
    defaultVariants: { look: "plain", shape: "label" },
  },
);

type Look = NonNullable<VariantProps<typeof buttonLook>["look"]>;

/** The one icon size, before a label or alone. */
export const ICON = 16;

/**
 * A button with a label. `busy`: what it is doing ("Backing up…"), in place
 * of the label, with a spinner; it can't be pressed again meanwhile.
 */
export function Button({
  look,
  icon: Glyph,
  busy,
  disabled,
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  look?: Look;
  icon: Icon;
  busy?: string | false;
}) {
  const working = typeof busy === "string";
  return (
    <button
      type="button"
      disabled={disabled === true || working}
      className={twMerge(buttonLook({ look }), className)}
      {...props}
    >
      {working ? (
        <LoaderCircle size={ICON} className="animate-spin" aria-hidden />
      ) : (
        <Glyph size={ICON} aria-hidden />
      )}
      {working ? busy : children}
    </button>
  );
}

/**
 * A button that is only an icon: its label is its name, and a tooltip
 * shows it on the pointer and on keyboard focus.
 */
export function IconButton({
  label,
  icon: Glyph,
  look = "quiet",
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: Icon;
  look?: Look;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            aria-label={label}
            className={twMerge(buttonLook({ look, shape: "icon" }), className)}
            {...props}
          />
        }
      >
        <Glyph size={ICON} aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="z-50">
          <Tooltip.Popup className="rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-surface shadow-menu">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** What went wrong with a read, in the core's words, and Retry. */
export function Problem({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  return (
    <div role="alert" className="flex items-center gap-3 text-muted">
      <span>{error.message}</span>
      {retry && (
        <Button icon={RotateCw} onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
