// The Documents page: everything added for the person, newest first, with
// a kind filter. Files are added from the button or by dropping them on the
// page. Two or more photos first show "3 photos → one document", with a
// switch to make them separate and their order to change; a PDF is always
// a document of its own. A row opens the document's page; its original
// opens from there in a popup: a PDF in the browser's own PDF viewer,
// photos one under the other (a HEIC through its JPEG copy). Ask Rufi on a
// row puts its chip in the chat box.
import { Dialog } from "@base-ui/react/dialog";
import type { Person } from "@rufi/contracts";
import {
  type DocumentFile,
  type DocumentKind,
  type DocumentSummary,
} from "@rufi/contracts/documents";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileText, Image, Plus, ScanText, X } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { fetchFile } from "./api.ts";
import { ACCEPT } from "./attach-choice.tsx";
import { chooseFiles, showChat } from "./attach.tsx";
import { AskRufi } from "./ask.tsx";
import { askRufi, openPanel } from "./panel.ts";
import { printedDate, printedDay } from "./dates.ts";
import { useDocuments } from "./reads.ts";
import { openReading, RetryButton } from "./reading.tsx";
import { Button, EmptyState, IconButton, Problem } from "./ui.tsx";

const KINDS: readonly { id: DocumentKind; name: string }[] = [
  { id: "lab_report", name: "Lab reports" },
  { id: "prescription", name: "Prescriptions" },
  { id: "letter", name: "Letters" },
  { id: "other", name: "Other" },
];
export const KIND_NAMES: Record<DocumentKind, string> = {
  lab_report: "Lab report",
  prescription: "Prescription",
  letter: "Letter",
  other: "Other",
};

const isHeic = (type: string) => type === "image/heic" || type === "image/heif";

export function DocumentsPage({ person }: { person: Person }) {
  const documents = useDocuments(person.id);
  const [kind, setKind] = useState<DocumentKind | "all">("all");
  const [dragging, setDragging] = useState(false);
  const navigate = useNavigate();
  const picker = useRef<HTMLInputElement | null>(null);
  const choose = (files: File[]) => {
    showChat(person.id, navigate);
    void chooseFiles(person.id, files);
  };
  const pick = () => {
    // Keep this input mounted until the picker answers, even in a small window.
    openPanel();
    picker.current?.click();
  };

  const list = documents.data ?? [];
  const shown = kind === "all" ? list : list.filter((d) => d.kind === kind);

  return (
    <div
      className="relative mx-auto min-h-full max-w-[880px] px-6 py-8"
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event: DragEvent) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        choose([...event.dataTransfer.files]);
      }}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <select
          aria-label="Kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as DocumentKind | "all");
          }}
          className="rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="all">All kinds</option>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <Button look="main" icon={Plus} onClick={pick}>
          Add…
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Choose documents"
          className="hidden"
          onChange={(event) => {
            choose([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>

      {documents.data === undefined && documents.error ? (
        <Problem
          error={documents.error}
          retry={() => void documents.refetch()}
        />
      ) : documents.data === undefined ? null : list.length === 0 ? (
        <Empty add={pick} />
      ) : shown.length === 0 ? (
        <p className="text-muted">
          No {KINDS.find((k) => k.id === kind)?.name.toLowerCase()} yet.
        </p>
      ) : (
        <List personId={person.id} documents={shown} />
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/90 text-[15px] font-semibold text-accent-ink">
          Drop to add documents
        </div>
      )}
    </div>
  );
}

function Empty({ add }: { add: () => void }) {
  return (
    <EmptyState
      title="No documents yet"
      // The page's main Add is above; this one is plain.
      action={
        <Button icon={Plus} onClick={add}>
          Add…
        </Button>
      }
    >
      Add a lab report or another document as a PDF, or as photos (JPEG, PNG or
      HEIC). You can also drop files here. Rufi keeps each original exactly as
      it came.
    </EmptyState>
  );
}

/** Pages as "1–4, 6". */
function ranges(positions: readonly number[]): string {
  const parts: [number, number][] = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    if (last && last[1] === p - 1) last[1] = p;
    else parts.push([p, p]);
  }
  return parts
    .map(([a, b]) => (a === b ? String(a) : `${String(a)}–${String(b)}`))
    .join(", ");
}

/** A document split from an add: "pages 1–2 of 5", "page 5 of 5". */
export function placeWords(
  place: NonNullable<DocumentSummary["place"]>,
): string {
  return `${place.pages.length === 1 ? "page" : "pages"} ${ranges(place.pages)} of ${String(place.of)}`;
}

/** A document's name: its first file's, and what else it holds. */
export function describe(document: DocumentSummary): {
  name: string;
  more: string;
} {
  const [first] = document.files;
  const photos = document.files.length;
  const more = document.place
    ? placeWords(document.place)
    : first?.mediaType === "application/pdf"
      ? first.pages === 1
        ? "1 page"
        : `${String(first.pages)} pages`
      : photos > 1
        ? `+ ${String(photos - 1)} more ${photos === 2 ? "photo" : "photos"}`
        : "";
  return { name: first?.name ?? "Document", more };
}

const results = (count: number) =>
  count === 1 ? "1 result" : `${String(count)} results`;

/**
 * A document's status on the list, from its reading's state and its items'
 * counts: while any item waits (an earlier value too) it is Not saved;
 * once none waits, Saved when any was saved, else Set aside, else nothing
 * was found.
 */
function statusOf(document: DocumentSummary): string {
  const reading = document.reading;
  // Its reader at work: it saves its pages at once, so no count yet.
  if (document.status === "reading" && document.reader !== null) {
    return "Reading";
  }
  if (document.status === "not_read" || reading === null) return "Not read yet";
  const read = `read ${String(reading.saved)} of ${String(reading.of)}`;
  if (document.status === "reading") return `Reading · ${read}`;
  if (document.status === "failed") return `Failed · ${read}`;
  if (document.notSorted) return "Not sorted yet";
  if (reading.hasPending) {
    return reading.results > 0
      ? `Not saved · ${results(reading.results)}`
      : "Not saved";
  }
  if (reading.canRetry) return "To check";
  if (reading.itemsSaved > 0) return `Saved · ${results(reading.itemsSaved)}`;
  if (reading.itemsSetAside > 0) {
    return `Set aside · ${results(reading.itemsSetAside)}`;
  }
  return "Nothing to save";
}

/** A document's reading, in words, with what can be done about it. */
function Status({
  personId,
  document,
}: {
  personId: string;
  document: DocumentSummary;
}) {
  const reading = document.reading;
  return (
    <>
      <span className="rounded-full bg-side px-2 py-px text-xs text-muted">
        {statusOf(document)}
      </span>
      {document.status !== "reading" &&
        (document.status === "not_read" || reading?.canRetry === true) && (
          <RetryButton personId={personId} documentId={document.id} />
        )}
      {reading !== null && (
        <Button
          look="quiet"
          icon={ScanText}
          onClick={() => {
            openReading(personId, document.id);
          }}
        >
          View reading
        </Button>
      )}
    </>
  );
}

function List({
  personId,
  documents,
}: {
  personId: string;
  documents: readonly DocumentSummary[];
}) {
  return (
    <>
      {/* The name keeps a minimum width and the dates one line; the status
          asks for room for one line and wraps first. Only a window too
          narrow for every column scrolls sideways. */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface px-3">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-muted [&>th]:pr-2.5">
              <th className="py-2 font-normal">Document</th>
              <th className="py-2 font-normal">Kind</th>
              <th className="py-2 font-normal">Date</th>
              <th className="py-2 font-normal">Added</th>
              <th className="w-[376px] py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const { name, more } = describe(document);
              const Icon =
                document.files[0]?.mediaType === "application/pdf"
                  ? FileText
                  : Image;
              return (
                <tr
                  key={document.id}
                  className="group border-t border-line hover:bg-side [&>td]:pr-2.5 [&>td:last-child]:pr-0"
                >
                  <td className="py-2.5">
                    <Link
                      to="/people/$personId/documents/$documentId"
                      params={{ personId, documentId: document.id }}
                      className="flex w-fit min-w-28 items-center gap-2 text-left font-semibold hover:underline"
                    >
                      <Icon
                        size={16}
                        className="shrink-0 text-muted"
                        aria-hidden
                      />
                      <span className="min-w-0 wrap-anywhere">{name}</span>
                    </Link>
                    {more && <div className="ml-6 text-muted">{more}</div>}
                  </td>
                  <td className="py-2.5 text-muted">
                    {document.kind ? KIND_NAMES[document.kind] : "—"}
                  </td>
                  <td className="py-2.5 whitespace-nowrap text-muted">
                    {document.date ? printedDate(document.date) : "—"}
                  </td>
                  <td className="py-2.5 whitespace-nowrap">
                    {printedDay(document.addedAt)}
                  </td>
                  <td className="py-2.5">
                    {/* The status, then what can be done: on one line when there is room. */}
                    <div className="flex flex-wrap items-center gap-1">
                      <Status personId={personId} document={document} />
                      {document.status !== "reading" && (
                        <AskRufi
                          className="ml-auto"
                          onClick={() => {
                            askRufi(personId, [
                              {
                                pointer: { type: "document", id: document.id },
                                label: name,
                                detail: "",
                              },
                            ]);
                          }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 px-0.5 text-muted">
        Newest first. Two files with the same name are two documents when their
        content differs.
      </p>
    </>
  );
}

const PANEL =
  "fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/** The original in a popup: the PDF viewer, or the photos one under the other. */
export function Viewer({
  person,
  document,
  close,
}: {
  person: string;
  document: DocumentSummary;
  close: () => void;
}) {
  const { name } = describe(document);
  const first = document.files[0];
  const what =
    first?.mediaType === "application/pdf"
      ? `PDF · ${describe(document).more}`
      : document.files.length === 1
        ? "Photo"
        : `${String(document.files.length)} photos`;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup
          className={`${PANEL} flex h-[88vh] w-[86vw] flex-col overflow-hidden`}
        >
          <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
            <Dialog.Title className="min-w-0 flex-1 truncate">
              <b className="text-[14px]">{name}</b>{" "}
              <span className="text-muted">
                · {what} · added {printedDay(document.addedAt)}
              </span>
            </Dialog.Title>
            <Dialog.Close render={<IconButton label="Close" icon={X} />} />
          </div>
          {/* Focusable, so the keyboard can scroll it too. */}
          <div
            tabIndex={0}
            role="group"
            aria-label="Pages"
            className="flex flex-1 flex-col items-center gap-3.5 overflow-auto bg-side p-4"
          >
            {document.files.map((file, index) => (
              <Shown
                key={file.id}
                path={`/api/people/${encodeURIComponent(person)}/documents/${encodeURIComponent(document.id)}/files/${file.id}`}
                file={file}
                caption={
                  document.files.length > 1
                    ? `Photo ${String(index + 1)} of ${String(document.files.length)}`
                    : undefined
                }
              />
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One file, fetched with the tab's proof and shown from a blob of this page. */
function Shown({
  path,
  file,
  caption,
}: {
  path: string;
  file: DocumentFile;
  caption: string | undefined;
}) {
  const heic = isHeic(file.mediaType);
  const [shown, setShown] = useState<{ url?: string; error?: Error }>({});
  useEffect(() => {
    let url: string | undefined;
    let gone = false;
    fetchFile(heic ? `${path}/display` : path).then(
      (blob) => {
        // The type as Rufi keeps it, so the viewer knows what it shows.
        url = URL.createObjectURL(
          new Blob([blob], { type: heic ? "image/jpeg" : file.mediaType }),
        );
        if (gone) URL.revokeObjectURL(url);
        else setShown({ url });
      },
      (error: unknown) => {
        if (!gone) setShown({ error: error as Error });
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, heic, file.mediaType]);

  if (shown.error) return <Problem error={shown.error} />;
  if (!shown.url) {
    return (
      <p role="status" className="m-auto text-muted">
        {heic ? "Preparing the photo…" : "Opening…"}
      </p>
    );
  }
  if (file.mediaType === "application/pdf") {
    if (!navigator.pdfViewerEnabled) {
      return (
        <p className="m-auto text-muted">
          This window can't show PDFs.{" "}
          <a
            href={shown.url}
            download={file.name}
            className="text-accent-ink underline"
          >
            Save a copy
          </a>{" "}
          to open it on your Mac.
        </p>
      );
    }
    return (
      <iframe
        src={shown.url}
        title={file.name}
        className="size-full flex-1 rounded-md border-0"
      />
    );
  }
  return (
    <>
      <img
        src={shown.url}
        alt={caption ?? file.name}
        className="max-w-[min(100%,900px)] rounded-md"
      />
      {caption && <p className="-mt-2 text-xs text-muted">{caption}</p>}
    </>
  );
}
