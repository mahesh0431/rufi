// Small parts every screen uses.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

const button = cva(
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium outline-offset-2 disabled:opacity-50",
  {
    variants: {
      look: {
        main: "bg-accent text-white hover:bg-accent-ink",
        plain: "border border-line bg-white hover:bg-page",
        quiet: "hover:bg-side",
      },
    },
    defaultVariants: { look: "plain" },
  },
);

export function Button({
  look,
  className,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof button>) {
  return (
    <button
      type="button"
      className={twMerge(button({ look }), className)}
      {...props}
    />
  );
}

/** What went wrong with a read, in the core's words, and a way to try again. */
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
      {retry && <Button onClick={retry}>Try again</Button>}
    </div>
  );
}
