// A chip: a reference to health data in the chat box or a sent message. Its
// icon says what it is (a document, a draft item, a saved record, a
// report's results), its name
// is what the page calls it, and the pointer shows where it comes from. In
// the box, a Retry chip says read again. A chip
// whose document was deleted keeps its name, says so, and is dimmed.
import type { Pointer } from "@rufi/contracts";
import { Activity, FileText, FlaskConical, Table2, X } from "lucide-react";
import { IconButton } from "./ui.tsx";

const ICONS = {
  document: FileText,
  draft_item: FlaskConical,
  record: Activity,
  report: Table2,
} as const;

export function ChipView({
  chip,
  onRemove,
}: {
  chip: {
    pointer: Pointer;
    label: string;
    detail: string;
    deleted?: true | undefined;
  };
  /** Takes it out of the box; none in a sent message. */
  onRemove?: () => void;
}) {
  const Icon = ICONS[chip.pointer.type];
  const label = chip.label === "" ? "Adding…" : chip.label;
  const again =
    chip.pointer.type === "document" && chip.pointer.readAgain === true;
  const named = `${label}${chip.deleted ? " · document deleted" : again ? " · read again" : ""}`;
  return (
    <span
      title={
        chip.detail === "" || chip.deleted ? named : `${named}\n${chip.detail}`
      }
      className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-side py-px pr-1 pl-2 text-[12.5px] ${chip.deleted ? "text-muted" : ""}`}
    >
      <Icon size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="max-w-[220px] truncate">{label}</span>
      {chip.deleted && (
        <span className="shrink-0 whitespace-nowrap"> · document deleted</span>
      )}
      {again && !chip.deleted && (
        <span className="text-muted"> · read again</span>
      )}
      {onRemove ? (
        // The one smaller button: a chip is a word in the message, and a
        // full-size button would make every chip a row of its own.
        <IconButton
          label={`Take ${label} out of the message`}
          icon={X}
          onClick={onRemove}
          className="size-6"
        />
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}
