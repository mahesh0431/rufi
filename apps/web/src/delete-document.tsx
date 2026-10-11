// Delete document, on a document's page: a preview of what goes and what
// stays, then the delete (docs/help/documents.md). While results saved from
// the document are in the record, it can't be deleted: the preview lists
// them, and Ask Rufi puts the document in the chat to remove them, or take
// the document off them, first. A delete made on a preview that changed
// meanwhile (another tab saved a result) is refused, and the preview shows
// how it is now.
import { Dialog } from "@base-ui/react/dialog";
import { DeletePreview } from "@rufi/contracts/documents";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { ApiError, read } from "./api.ts";
import { ASKS } from "./ask.tsx";
import { askRufi } from "./panel.ts";
import { Button, Problem } from "./ui.tsx";

const PANEL =
  "fixed top-1/2 left-1/2 z-40 w-[440px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

const Deleted = Schema.Struct({ deleted: Schema.Literal(true) });

const deletePath = (personId: string, documentId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents/${encodeURIComponent(documentId)}/delete`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "1 PDF, 3 pages", "2 photos". */
function filesIn(preview: DeletePreview): string {
  const pages = preview.files.reduce((sum, f) => sum + f.pages, 0);
  const pdfs = preview.files.filter((f) => /\.pdf$/i.test(f.name)).length;
  const photos = preview.files.length - pdfs;
  return [
    ...(pdfs > 0 ? [plural(pdfs, "PDF")] : []),
    ...(photos > 0 ? [plural(photos, "photo")] : []),
    ...(pdfs > 0 ? [plural(pages, "page")] : []),
  ].join(", ");
}

export function DeleteDocument({
  personId,
  documentId,
  name,
}: {
  personId: string;
  documentId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete document
      </Button>
      {open && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop className={BACKDROP} />
            <Dialog.Popup className={PANEL}>
              <Preview
                personId={personId}
                documentId={documentId}
                name={name}
                close={() => {
                  setOpen(false);
                }}
              />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

function Preview({
  personId,
  documentId,
  name,
  close,
}: {
  personId: string;
  documentId: string;
  name: string;
  close: () => void;
}) {
  const navigate = useNavigate();
  const found = useQuery({
    queryKey: ["delete-preview", personId, documentId],
    queryFn: () => read(DeletePreview, "GET", deletePath(personId, documentId)),
    gcTime: 0,
  });
  /** The preview a refused delete came back with: how it is now. */
  const [changed, setChanged] = useState<DeletePreview | undefined>(undefined);
  const remove = useMutation({
    mutationFn: (version: string) =>
      read(Deleted, "POST", deletePath(personId, documentId), { version }),
    onSuccess: () => {
      void navigate({
        to: "/people/$personId/documents",
        params: { personId },
      });
    },
    onError: (error) => {
      const fresh =
        error instanceof ApiError && error.status === 409
          ? Schema.decodeUnknownOption(DeletePreview)(
              (error.body as { preview?: unknown } | undefined)?.preview,
            )
          : undefined;
      if (fresh?._tag === "Some") {
        setChanged(fresh.value);
        remove.reset();
      }
    },
  });
  const preview = changed ?? found.data;
  const blocked = preview !== undefined && preview.blocking.length > 0;
  const title = blocked
    ? `${preview.name} can't be deleted yet`
    : `Delete ${preview?.name ?? name}?`;

  return (
    <>
      {/* One line: a long name is cut, and its tooltip has it whole. */}
      <Dialog.Title
        aria-label={title}
        className="flex min-w-0 px-4 pt-3.5 pb-1 text-[14px] font-semibold whitespace-pre"
      >
        {!blocked && "Delete "}
        <span className="truncate" title={preview?.name ?? name}>
          {preview?.name ?? name}
        </span>
        {blocked ? " can't be deleted yet" : "?"}
      </Dialog.Title>
      {changed && (
        <p
          role="status"
          className="mx-4 mt-1.5 rounded-[10px] bg-accent-soft px-3 py-2 text-xs"
        >
          Something changed since you opened this. Nothing was deleted. Here is
          how it is now.
        </p>
      )}
      <div className="px-4 py-1">
        {found.error && !preview && (
          <Problem
            error={found.error}
            retry={() => {
              void found.refetch();
            }}
          />
        )}
        {preview && blocked && (
          <>
            <p className="mt-1.5 mb-2.5">
              These results in your health record come from it:
            </p>
            <ul
              aria-label="Saved results from this document"
              className="overflow-hidden rounded-[10px] border border-line"
            >
              {preview.blocking.map((record) => (
                <li
                  key={`${record.kind}:${record.id}`}
                  className="flex gap-2 border-t border-line px-2.5 py-1.5 first:border-t-0"
                >
                  <span className="flex-1">
                    {record.label}
                    {record.replaced && (
                      <span className="text-muted"> · replaced</span>
                    )}
                  </span>
                  {record.date !== null && (
                    <span className="text-muted">{record.date}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2.5">
              In the chat, remove them, or take this document off them. Then
              delete it.
            </p>
          </>
        )}
        {preview && !blocked && (
          <>
            <h3 className="mt-2 mb-1 text-xs font-semibold text-muted">
              Goes from Rufi
            </h3>
            <ul className="list-disc pl-[18px]">
              <li>The file: {filesIn(preview)}</li>
              {preview.unsaved > 0 && (
                <li>
                  What the reader read:{" "}
                  {plural(preview.unsaved, "unsaved item")}
                </li>
              )}
              {preview.readings > 0 && <li>The reading under way stops</li>}
            </ul>
            <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
              Stays
            </h3>
            <ul className="list-disc pl-[18px]">
              <li>Your health record and its history</li>
              <li>
                The chat. Where it points at this document, it says "document
                deleted".
              </li>
            </ul>
            <p className="mt-3 rounded-[10px] bg-side px-3 py-2 text-xs">
              Rufi can't reach copies outside it. Its backups keep this document
              until they age out, in about 5 weeks. Backups from before an
              update keep it until you remove them. Exports you saved, Time
              Machine, and what the AI already read keep theirs.
            </p>
          </>
        )}
        {remove.error && !changed && (
          <p role="alert" className="mt-2 text-muted">
            {remove.error.message}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 px-4 pt-3 pb-3.5">
        <Dialog.Close render={<Button />}>
          {blocked ? "Close" : "Cancel"}
        </Dialog.Close>
        {blocked ? (
          <Button
            look="main"
            {...ASKS}
            onClick={() => {
              if (
                askRufi(personId, [
                  {
                    pointer: { type: "document", id: documentId },
                    label: preview.name,
                    detail: "",
                  },
                ])
              ) {
                close();
              }
            }}
          >
            Ask Rufi
          </Button>
        ) : (
          <Button
            look="main"
            disabled={preview === undefined || remove.isPending}
            onClick={() => {
              if (preview) {
                setChanged(undefined);
                remove.mutate(preview.version);
              }
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete document"}
          </Button>
        )}
      </div>
    </>
  );
}
