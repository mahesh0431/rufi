// A chip: a reference to health data in the chat box or a sent message. Its
// icon says what it is (a document, a draft item, a saved record), its name
// is what the page calls it, and the pointer shows where it comes from.
import type { Pointer } from "@rufi/contracts";
import { Activity, FileText, FlaskConical, X } from "lucide-react";

const ICONS = {
  document: FileText,
  draft_item: FlaskConical,
  record: Activity,
} as const;

export function ChipView({
  chip,
  onRemove,
}: {
  chip: { pointer: Pointer; label: string; detail: string };
  /** Takes it out of the box; none in a sent message. */
  onRemove?: () => void;
}) {
  const Icon = ICONS[chip.pointer.type];
  const label = chip.label === "" ? "Adding…" : chip.label;
  return (
    <span
      title={chip.detail === "" ? label : `${label}\n${chip.detail}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-side py-px pr-1 pl-2 text-[12.5px]"
    >
      <Icon size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="max-w-[220px] truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Take ${label} out of the message`}
          onClick={onRemove}
          className="grid size-[18px] shrink-0 place-items-center rounded-md text-muted hover:bg-line hover:text-ink"
        >
          <X size={11} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}
