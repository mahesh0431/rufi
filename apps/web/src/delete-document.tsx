// Delete, on a document's page: a preview of what goes and what
// stays, then the delete (docs/help/documents.md). When results saved from
// the document are in the record, the preview lists them and the person
// chooses: Delete file keeps them; Delete file and results opens the chat,
// where the AI goes through them and removes each one on a yes. A delete
// made on a preview that changed meanwhile (another tab saved a result) is
// refused, and the preview shows how it is now.
import { Dialog } from "@base-ui/react/dialog";
import {
  DeletePreview,
  type DeleteDocument as Confirm,
} from "@rufi/contracts/documents";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileX, Trash2, X } from "lucide-react";
import { Schema } from "effect";
import { useState } from "react";
import { ApiError, read } from "./api.ts";
import { chatPage, isSmall, usePanel } from "./panel.ts";
import { Button, Problem } from "./ui.tsx";

const PANEL =
  "fixed top-1/2 left-1/2 z-40 w-[480px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none flex max-h-[calc(100vh-32px)] flex-col";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

const Deleted = Schema.Struct({ deleted: Schema.Literal(true) });

const deletePath = (personId: string, documentId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents/${encodeURIComponent(documentId)}/delete`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "2 other documents use it": the file stays while they do. */
const othersUse = (others: number) =>
  others === 1
    ? "1 other document uses it"
    : `${String(others)} other documents use it`;

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
        look="quiet"
        icon={Trash2}
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete
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
}: {
  personId: string;
  documentId: string;
  name: string;
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
    mutationFn: (body: Confirm) =>
      read(Deleted, "POST", deletePath(personId, documentId), body),
    onSuccess: (_, { saved }) => {
      // With its results: the chat opens, where the AI starts on them.
      if (saved === "remove" && isSmall()) {
        void navigate(chatPage(personId));
        return;
      }
      if (saved === "remove") usePanel.setState({ openNext: true });
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
  const saved = preview?.saved ?? [];
  /** A result, or a record when the list has another kind, such as a visit. */
  const noun = saved.every((r) => r.kind === "result") ? "result" : "record";
  const visit = saved.some((r) => r.kind === "visit");
  const shown = preview?.name ?? name;
  const title = `Delete ${shown}?`;
  const confirm = (choice?: Confirm["saved"]) => {
    if (!preview) return;
    setChanged(undefined);
    remove.mutate({
      version: preview.version,
      ...(choice && { saved: choice }),
    });
  };

  return (
    <>
      {/* One line: a long name is cut, and its tooltip has it whole. */}
      <Dialog.Title
        aria-label={title}
        className="flex min-w-0 px-4 pt-3.5 pb-1 text-[14px] font-semibold whitespace-pre"
      >
        {"Delete "}
        <span className="truncate" title={shown}>
          {shown}
        </span>
        ?
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
      {/* The title and the buttons stay; what is between scrolls. */}
      <div
        tabIndex={0}
        role="group"
        aria-label="What goes and what stays"
        className="min-h-0 flex-1 overflow-auto px-4 py-1"
      >
        {found.error && !preview && (
          <Problem
            error={found.error}
            retry={() => {
              void found.refetch();
            }}
          />
        )}
        {preview && saved.length > 0 && (
          <>
            <p className="mt-1.5 mb-2.5">
              {saved.length === 1
                ? `1 ${noun} in your health record comes from it:`
                : `${String(saved.length)} ${noun}s in your health record come from it:`}
            </p>
            {/* A long list scrolls by itself, so the choice stays in view. */}
            <ul
              tabIndex={0}
              aria-label="Saved results from this document"
              className="max-h-[30vh] overflow-auto rounded-[10px] border border-line"
            >
              {saved.map((record) => (
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
            {/* The list is what rests on the paper's pages: what was saved
                from a visit rests on the visit. */}
            {visit && (
              <p className="mt-2.5">
                Medicines or follow-ups saved from a visit here aren't listed;
                Rufi AI goes through them with you.
              </p>
            )}
            {/* One document of a split file: only its part goes. */}
            {preview.others > 0 && preview.place !== null && (
              <ul className="mt-2.5 list-disc pl-[18px]">
                <li>Its part of the file: {preview.place}</li>
                <li>The file stays: {othersUse(preview.others)}</li>
              </ul>
            )}
            <ul className="mt-2.5 flex flex-col gap-1.5">
              <li>
                <strong className="font-semibold">Delete file</strong>: the
                results stay in your health record. Where they came from says
                "document deleted".
              </li>
              <li>
                <strong className="font-semibold">
                  Delete file and results
                </strong>
                : the chat opens, and the AI goes through the results with you.
                It removes each one only when you say yes.
              </li>
            </ul>
          </>
        )}
        {/* With saved results, the two choices say what goes and stays. */}
        {preview && saved.length === 0 && (
          <>
            <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
              Goes from Rufi
            </h3>
            <ul className="list-disc pl-[18px]">
              {preview.others > 0 && preview.place !== null ? (
                <li>Its part of the file: {preview.place}</li>
              ) : (
                <li>The file: {filesIn(preview)}</li>
              )}
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
              {preview.others > 0 && (
                <li>The file: {othersUse(preview.others)}</li>
              )}
              <li>Your health record and its history</li>
              <li>
                The chat. Where it points at this document, it says "document
                deleted".
              </li>
            </ul>
          </>
        )}
        {preview && (
          <p className="mt-3 rounded-[10px] bg-side px-3 py-2 text-xs">
            Rufi can't reach copies outside it. Its backups keep this document
            until they age out, in about 5 weeks. Backups from before an update
            keep it until you remove them. Exports you saved, Time Machine, and
            what the AI already read keep theirs.
          </p>
        )}
        {remove.error && !changed && (
          <p role="alert" className="mt-2 text-muted">
            {remove.error.message}
          </p>
        )}
      </div>
      {/* The Mac's order: Cancel, then the actions. No default button: the
          dialog opens with the focus off them, so Return there deletes
          nothing; a delete button takes Return and Space when focused. */}
      <div className="flex flex-wrap justify-end gap-2 px-4 pt-3 pb-3.5">
        <Dialog.Close render={<Button icon={X} />}>Cancel</Dialog.Close>
        {saved.length > 0 ? (
          <>
            <Button
              look="delete"
              icon={FileX}
              disabled={remove.isPending}
              busy={
                remove.isPending &&
                remove.variables.saved === "keep" &&
                "Deleting…"
              }
              onClick={() => {
                confirm("keep");
              }}
            >
              Delete file
            </Button>
            <Button
              look="delete"
              icon={Trash2}
              disabled={remove.isPending}
              busy={
                remove.isPending &&
                remove.variables.saved === "remove" &&
                "Deleting…"
              }
              onClick={() => {
                confirm("remove");
              }}
            >
              Delete file and results
            </Button>
          </>
        ) : (
          <Button
            look="delete"
            icon={Trash2}
            disabled={preview === undefined}
            busy={remove.isPending && "Deleting…"}
            onClick={() => {
              confirm();
            }}
          >
            Delete
          </Button>
        )}
      </div>
    </>
  );
}
