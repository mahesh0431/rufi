// Small parts every screen uses.
import { Tooltip } from "@base-ui/react/tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, type LucideProps, RotateCw } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  useId,
} from "react";
import { twMerge } from "tailwind-merge";
import { LiveDog } from "./dog.tsx";

/** A Lucide icon, or one drawn the same way. */
export type Icon = ComponentType<LucideProps>;

/**
 * Rufi's one button: four looks, one size, an icon before a short label.
 * main: the one main next action on a screen, at most one. plain: other
 * actions. quiet: actions repeated on rows, and small known actions as an
 * icon only. delete: only the last step of a delete that can't be undone.
 * 36 px high with a label, 32 × 32 px with only an icon; on a touch screen
 * (a coarse pointer) at least 44 × 44 px, Apple's smallest touch target. A
 * link that acts like a button takes the same look.
 */
export const buttonLook = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-[0.8125rem] font-medium whitespace-nowrap disabled:opacity-50 pointer-coarse:min-h-[44px]",
  {
    variants: {
      look: {
        main: "bg-accent text-on-accent not-disabled:hover:bg-accent-hover",
        plain: "border border-line bg-surface not-disabled:hover:bg-page",
        quiet: "not-disabled:hover:bg-side",
        delete:
          "border border-danger/35 bg-danger-soft text-danger not-disabled:hover:border-danger/70",
      },
      shape: {
        label: "h-9 px-3.5",
        icon: "size-8 pointer-coarse:min-w-[44px]",
      },
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

/*
 * A row in a page narrower than 640 px (a phone; each page is a container):
 * its name and its button on the first line, then RowBreak, then its other
 * parts on one line, a dot between them (laterParts). On the Mac's wider
 * page the same parts are the row's grid columns.
 */
export const NARROW_ROW =
  "@max-[640px]:flex @max-[640px]:flex-wrap @max-[640px]:items-center @max-[640px]:gap-x-1.5 @max-[640px]:gap-y-0.5";
/** The row's name, first: it takes the first line's room. */
export const NARROW_FIRST = "@max-[640px]:min-w-0 @max-[640px]:flex-1";
/** What ends the first line, such as Ask Rufi. */
export const NARROW_END = "@max-[640px]:order-1";
/**
 * In a stacked row, the dot after a part that another follows: it stays
 * with that part, so a wrapped line never starts with one.
 */
export const DOT = "@max-[640px]:after:ml-1.5 @max-[640px]:after:content-['·']";

/**
 * A row's own control that isn't a button look (its name, a value's date,
 * a link to what it is about), on a touch screen (a coarse pointer): at
 * least 44 × 44 px, Apple's smallest touch target, its text where it was.
 * A button centres its text in the room itself; a link takes TOUCH_LINK.
 */
export const TOUCH = "pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]";
export const TOUCH_LINK = `${TOUCH} pointer-coarse:inline-flex pointer-coarse:items-center`;

/** Ends a stacked row's first line; nothing on a wider page. */
export function RowBreak() {
  return (
    <span
      aria-hidden
      className="hidden @max-[640px]:order-2 @max-[640px]:block @max-[640px]:basis-full"
    />
  );
}

/**
 * Each of a row's later parts, by its classes in a stacked row: after the
 * first line, a dot after each but the last shown, an empty one hidden.
 */
export function laterParts<const T extends readonly unknown[]>(
  parts: T,
): { [K in keyof T]: string } {
  const empty = (part: unknown) =>
    part === undefined || part === null || part === "" || part === false;
  const last = parts.findLastIndex((part) => !empty(part));
  return parts.map((part, index) =>
    empty(part)
      ? "@max-[640px]:hidden"
      : `@max-[640px]:order-3 ${index < last ? DOT : ""}`,
  ) as { [K in keyof T]: string };
}

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
  tip = label,
  icon: Glyph,
  look = "quiet",
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  /** Its tooltip, when it says more than the name. */
  tip?: string;
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
            {tip}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * One part of Settings, named by its heading: its options. `id` names the
 * heading, for a choice it labels too.
 */
export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) {
  const own = useId();
  const heading = id ?? own;
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2 border-t border-line pt-5 first:border-t-0 first:pt-0"
    >
      <h4 id={heading} className="font-semibold">
        {title}
      </h4>
      {children}
    </section>
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

/**
 * A page with nothing on it yet: Rufi saying hello, a heading, a line and
 * one action, each only when the page has it.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border-[1.5px] border-dashed border-line bg-surface px-6 py-14 text-center">
      <LiveDog size={64} />
      {title !== undefined && (
        <h2 className="mt-3 text-[0.9375rem] font-semibold">{title}</h2>
      )}
      {children !== undefined && (
        <p
          className={`max-w-md text-muted ${title === undefined ? "mt-3" : ""}`}
        >
          {children}
        </p>
      )}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}
