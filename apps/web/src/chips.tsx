// A chip: a reference to health data in the chat box or a sent message. Its
// icon says what it is (a document, a draft item, a saved record, a
// report's results), its name
// is what the page calls it, and the pointer shows where it comes from. In
// the box, a document's chip also says what Rufi is doing with it. A chip
// whose document was deleted keeps its name, says so, and is dimmed.
import type { Pointer } from "@rufi/contracts";
import {
  Activity,
  FileText,
  FlaskConical,
  LoaderCircle,
  Table2,
  X,
} from "lucide-react";
import { type ChipState, chipState } from "./chip-state.ts";
import { useReadings } from "./reading.tsx";
import { useDocuments } from "./reads.ts";
import { IconButton } from "./ui.tsx";

const ICONS = {
  document: FileText,
  draft_item: FlaskConical,
  record: Activity,
  report: Table2,
} as const;

/**
 * The state of each document chip in a person's box, from their documents
 * and reading jobs: one read of each for the whole box.
 */
export function useChipStates(
  personId: string,
): (pointer: Pointer) => ChipState | undefined {
  const documents = useDocuments(personId).data;
  const readings = useReadings(personId).data;
  return (pointer) =>
    pointer.type === "document"
      ? chipState(
          documents?.find((d) => d.id === pointer.id),
          readings?.find((r) => r.documentId === pointer.id),
        )
      : undefined;
}

export function ChipView({
  chip,
  state,
  onRemove,
}: {
  chip: {
    pointer: Pointer;
    label: string;
    detail: string;
    deleted?: true | undefined;
  };
  /** What Rufi is doing with it: only in the box. */
  state?: ChipState | undefined;
  /** Takes it out of the box; none in a sent message. */
  onRemove?: () => void;
}) {
  const Icon = ICONS[chip.pointer.type];
  const label = chip.label === "" ? "Adding…" : chip.label;
  const named = chip.deleted
    ? `${label} · document deleted`
    : state === undefined
      ? label
      : `${label} · ${state.text}`;
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
        <span className="shrink-0 whitespace-nowrap">· document deleted</span>
      )}
      {state !== undefined && (
        <span className="-ml-1.5 shrink-0 whitespace-nowrap text-muted">
          {" · "}
          {state.busy && (
            <LoaderCircle
              size={11}
              className="mr-1 inline animate-spin align-[-1px]"
              aria-hidden
            />
          )}
          {state.text}
        </span>
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
