// The Documents page: everything added for the person, newest first, with
// a kind filter. Files are added from the button or by dropping them on the
// page. Two or more photos first show "3 photos → one document", with a
// switch to make them separate and their order to change; a PDF is always
// a document of its own. A row opens the original in a popup: a PDF in the
// browser's own PDF viewer, photos one under the other (a HEIC through its
// JPEG copy).
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import type { Person } from "@rufi/contracts";
import {
  Added,
  type DocumentFile,
  type DocumentKind,
  type DocumentSummary,
} from "@rufi/contracts/documents";
import { useMutation } from "@tanstack/react-query";
import { FileText, GripVertical, Image, Plus, X } from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { fetchFile, upload } from "./api.ts";
import { printedDate, printedDay } from "./dates.ts";
import { queries, useDocuments } from "./reads.ts";
import {
  openReading,
  ReadCard,
  ReadItButton,
  RetryButton,
  TextButton,
} from "./reading.tsx";
import { Button, Problem } from "./ui.tsx";

const KINDS: readonly { id: DocumentKind; name: string }[] = [
  { id: "lab_report", name: "Lab reports" },
  { id: "prescription", name: "Prescriptions" },
  { id: "letter", name: "Letters" },
  { id: "other", name: "Other" },
];
const KIND_NAMES: Record<DocumentKind, string> = {
  lab_report: "Lab report",
  prescription: "Prescription",
  letter: "Letter",
  other: "Other",
};

/** What the file picker offers; Rufi itself goes by the content. */
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/*";

/** A chosen file and what its first bytes say it is. */
interface Chosen {
  file: File;
  kind: "pdf" | "jpeg" | "png" | "heic" | "other";
}

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
]);

/**
 * What a file is by its first bytes, not its name or the browser's type: a
 * hint for grouping photos. The core looks at the whole file and decides.
 */
async function look(file: File): Promise<Chosen> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const text = (from: number, to: number) =>
    String.fromCharCode(...head.subarray(from, to));
  const kind =
    text(0, 5) === "%PDF-"
      ? "pdf"
      : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        ? "jpeg"
        : text(0, 8) === "\x89PNG\r\n\x1a\n"
          ? "png"
          : text(4, 8) === "ftyp" && HEIC_BRANDS.has(text(8, 12))
            ? "heic"
            : "other";
  return { file, kind };
}

const isPhoto = ({ kind }: Chosen) =>
  kind === "jpeg" || kind === "png" || kind === "heic";

const isHeic = (type: string) => type === "image/heic" || type === "image/heif";

export function DocumentsPage({ person }: { person: Person }) {
  const documents = useDocuments(person.id);
  const [kind, setKind] = useState<DocumentKind | "all">("all");
  /** Files picked with two or more photos, waiting for Add. */
  const [picked, setPicked] = useState<Chosen[] | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<DocumentSummary | undefined>(undefined);
  const picker = useRef<HTMLInputElement | null>(null);

  const add = useMutation({
    mutationFn: ({ files, together }: { files: File[]; together: boolean }) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      form.append("together", together ? "yes" : "no");
      return upload(
        Added,
        `/api/people/${encodeURIComponent(person.id)}/documents`,
        form,
      );
    },
    onSettled: () =>
      queries.invalidateQueries({ queryKey: ["documents", person.id] }),
  });

  /** Files chosen or dropped: added now, or first grouped when 2+ are photos. */
  const choose = async (files: File[]) => {
    if (files.length === 0) return;
    add.reset();
    const chosen = await Promise.all(files.map(look));
    if (chosen.filter(isPhoto).length >= 2) setPicked(chosen);
    else add.mutate({ files, together: true });
  };

  const list = documents.data ?? [];
  const shown = kind === "all" ? list : list.filter((d) => d.kind === kind);
  const byId = (id: string) => list.find((d) => d.id === id);

  return (
    <div
      className="relative mx-auto min-h-full max-w-[790px] px-6 py-8"
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
        void choose([...event.dataTransfer.files]);
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
        <Button
          look="main"
          disabled={add.isPending}
          onClick={() => picker.current?.click()}
        >
          <Plus size={15} aria-hidden />
          {add.isPending ? "Adding…" : "Add documents"}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Choose documents"
          className="hidden"
          onChange={(event) => {
            void choose([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>

      <div className="-mx-3">
        <ReadCard person={person} />
      </div>
      <Outcome
        added={add.data}
        error={add.error}
        open={(id) => {
          setOpen(byId(id));
        }}
      />

      {documents.data === undefined && documents.error ? (
        <Problem
          error={documents.error}
          retry={() => void documents.refetch()}
        />
      ) : documents.data === undefined ? null : list.length === 0 ? (
        <Empty add={() => picker.current?.click()} />
      ) : shown.length === 0 ? (
        <p className="text-muted">
          No {KINDS.find((k) => k.id === kind)?.name.toLowerCase()} yet.
        </p>
      ) : (
        <List personId={person.id} documents={shown} open={setOpen} />
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/90 text-[15px] font-semibold text-accent-ink">
          Drop to add documents
        </div>
      )}
      {picked && (
        <AddDialog
          chosen={picked}
          close={() => {
            setPicked(undefined);
          }}
          add={(files, together) => {
            setPicked(undefined);
            add.mutate({ files, together });
          }}
        />
      )}
      {open && (
        <Viewer
          person={person.id}
          document={open}
          close={() => {
            setOpen(undefined);
          }}
        />
      )}
    </div>
  );
}

function Empty({ add }: { add: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border-[1.5px] border-dashed border-line bg-surface px-6 py-14 text-center">
      <FileText size={28} className="text-muted" aria-hidden />
      <h2 className="mt-2 text-[15px] font-semibold">No documents yet</h2>
      <p className="text-muted">
        Add a lab report or another document as a PDF, or as photos (JPEG, PNG
        or HEIC).
        <br />
        You can also drop files here. Rufi keeps each original exactly as it
        came.
      </p>
      <Button look="main" className="mt-3" onClick={add}>
        <Plus size={15} aria-hidden />
        Add documents
      </Button>
    </div>
  );
}

/** What the last add did: how many were added, which were already there, or why none. */
function Outcome({
  added,
  error,
  open,
}: {
  added: Added | undefined;
  error: Error | null;
  open: (id: string) => void;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-accent-ink"
      >
        {error.message}
      </p>
    );
  }
  if (!added) return null;
  const count = added.added.length;
  return (
    <div
      role="status"
      className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-accent-ink"
    >
      {count > 0 && (
        <span>
          Added {count} {count === 1 ? "document" : "documents"}.{" "}
        </span>
      )}
      {added.already.map((file, index) => (
        <span key={index}>
          <b>{file.name}</b> was already added:{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              open(file.documentId);
            }}
          >
            open it
          </button>
          .{" "}
        </span>
      ))}
    </div>
  );
}

/** A document's name: its first file's, and what else it holds. */
function describe(document: DocumentSummary): { name: string; more: string } {
  const [first] = document.files;
  const photos = document.files.length;
  const more =
    first?.mediaType === "application/pdf"
      ? first.pages === 1
        ? "1 page"
        : `${String(first.pages)} pages`
      : photos > 1
        ? `+ ${String(photos - 1)} more ${photos === 2 ? "photo" : "photos"}`
        : "";
  return { name: first?.name ?? "Document", more };
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
  const words =
    document.status === "not_read" || reading === null
      ? "Not read yet"
      : document.status === "reading"
        ? `Reading · saved ${String(reading.saved)} of ${String(reading.of)}`
        : document.status === "failed"
          ? `Failed · saved ${String(reading.saved)} of ${String(reading.of)}`
          : reading.results === 0
            ? "Nothing to save"
            : `To check · ${reading.results === 1 ? "1 result" : `${String(reading.results)} results`}`;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="rounded-full bg-side px-2 py-px text-xs text-muted">
        {words}
      </span>
      {document.status === "not_read" && (
        <ReadItButton personId={personId} document={document} />
      )}
      {reading?.canRetry === true && (
        <RetryButton personId={personId} documentId={document.id} />
      )}
      {document.status !== "not_read" && (
        <TextButton
          onClick={() => {
            openReading(personId, document.id);
          }}
        >
          Open
        </TextButton>
      )}
    </span>
  );
}

function List({
  personId,
  documents,
  open,
}: {
  personId: string;
  documents: readonly DocumentSummary[];
  open: (document: DocumentSummary) => void;
}) {
  return (
    <>
      <div className="rounded-xl border border-line bg-surface px-3">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2 font-normal">Document</th>
              <th className="py-2 font-normal">Kind</th>
              <th className="py-2 font-normal">Date</th>
              <th className="py-2 font-normal">Added</th>
              <th className="py-2 font-normal">Status</th>
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
                <tr key={document.id} className="border-t border-line">
                  <td className="py-2.5">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left font-semibold hover:underline"
                      onClick={() => {
                        open(document);
                      }}
                    >
                      <Icon
                        size={16}
                        className="shrink-0 text-muted"
                        aria-hidden
                      />
                      {name}
                    </button>
                    {more && <div className="ml-6 text-muted">{more}</div>}
                  </td>
                  <td className="py-2.5 text-muted">
                    {document.kind ? KIND_NAMES[document.kind] : "—"}
                  </td>
                  <td className="py-2.5 text-muted">
                    {document.date ? printedDate(document.date) : "—"}
                  </td>
                  <td className="py-2.5">{printedDay(document.addedAt)}</td>
                  <td className="py-2.5">
                    <Status personId={personId} document={document} />
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

/** Before adding two or more photos: one document or several, and their order. */
function AddDialog({
  chosen,
  close,
  add,
}: {
  chosen: Chosen[];
  close: () => void;
  add: (files: File[], together: boolean) => void;
}) {
  const [order, setOrder] = useState(chosen);
  const [together, setTogether] = useState(true);
  const [dragged, setDragged] = useState<number | undefined>(undefined);
  const photos = order.filter(isPhoto);
  const pdfs = order.length - photos.length;
  const count = together ? pdfs + 1 : order.length;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [file] = next.splice(from, 1);
    if (file) next.splice(to, 0, file);
    setOrder(next);
  };
  const what = [
    `${String(photos.length)} photos`,
    ...(pdfs > 0 ? [pdfs === 1 ? "1 PDF" : `${String(pdfs)} PDFs`] : []),
  ].join(" and ");

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup className={`${PANEL} w-[460px] max-w-[92vw] p-[18px]`}>
          <Dialog.Title className="text-[15px] font-semibold">
            Add {what}
          </Dialog.Title>
          <Dialog.Description className="text-muted">
            Drag a photo, or use the arrow keys on its handle, to change its
            place.
          </Dialog.Description>
          <ol className="my-3 rounded-[10px] border border-line">
            {order.map((file, index) => (
              <li
                // The file itself, so its handle keeps focus as it moves.
                key={chosen.indexOf(file)}
                draggable
                onDragStart={() => {
                  setDragged(index);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (dragged !== undefined) move(dragged, index);
                  setDragged(undefined);
                }}
                className="flex items-center gap-2.5 border-t border-line px-2.5 py-2 first:border-t-0"
              >
                <button
                  type="button"
                  aria-label={`Move ${file.file.name}`}
                  className="cursor-grab rounded text-muted"
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "ArrowUp") move(index, index - 1);
                    else if (event.key === "ArrowDown") move(index, index + 1);
                    else return;
                    event.preventDefault();
                  }}
                >
                  <GripVertical size={16} aria-hidden />
                </button>
                <Thumb file={file} />
                <span className="min-w-0 flex-1 truncate">
                  {file.file.name}
                </span>
                <span className="shrink-0 text-muted">
                  {together && isPhoto(file)
                    ? `page ${String(photos.indexOf(file) + 1)}`
                    : "own document"}
                </span>
              </li>
            ))}
          </ol>
          <label className="flex items-center gap-2.5 rounded-[10px] bg-side p-2.5">
            <Switch.Root
              checked={together}
              onCheckedChange={setTogether}
              className="relative h-[18px] w-8 shrink-0 rounded-full bg-line outline-offset-2 data-[checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-on-accent transition-transform data-[checked]:translate-x-4" />
            </Switch.Root>
            <span>
              <b>
                {String(photos.length)} photos →{" "}
                {together
                  ? "one document"
                  : `${String(photos.length)} documents`}
              </b>
              <span className="block text-muted">
                {together
                  ? "Usually one report, photographed page by page."
                  : "Each photo is its own document."}
              </span>
            </span>
          </label>
          <div className="mt-3.5 flex justify-end gap-2">
            <Dialog.Close render={<Button />}>Cancel</Dialog.Close>
            <Button
              look="main"
              onClick={() => {
                add(
                  order.map(({ file }) => file),
                  together,
                );
              }}
            >
              Add {count} {count === 1 ? "document" : "documents"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A small picture of a photo the browser can show; a label otherwise. */
function Thumb({ file: { file, kind } }: { file: Chosen }) {
  const shows = kind === "jpeg" || kind === "png";
  const label = kind === "other" ? "File" : kind.toUpperCase();
  return (
    <span className="flex h-11 w-[34px] shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-side text-[10px] text-muted">
      {shows ? (
        <img
          alt=""
          className="size-full object-cover"
          // The picture lives as long as the image shows.
          ref={(img) => {
            if (!img) return undefined;
            const url = URL.createObjectURL(file);
            img.src = url;
            return () => {
              URL.revokeObjectURL(url);
            };
          }}
        />
      ) : (
        label
      )}
    </span>
  );
}

/** The original in a popup: the PDF viewer, or the photos one under the other. */
function Viewer({
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
            <Dialog.Close render={<Button look="quiet" aria-label="Close" />}>
              <X size={15} aria-hidden />
            </Dialog.Close>
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
