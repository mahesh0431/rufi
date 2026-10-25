// Files waiting to be attached: their kinds, and the question for several photos.
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import { GripVertical, Plus, X } from "lucide-react";
import { type KeyboardEvent, type RefObject, useState } from "react";
import { Button, IconButton } from "./ui.tsx";

/** What the file picker offers; Rufi itself goes by the content. */
export const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/*";

/** A chosen file and what its first bytes say it is. */
export interface Chosen {
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
export async function look(file: File): Promise<Chosen> {
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

export const isPhoto = ({ kind }: Chosen) =>
  kind === "jpeg" || kind === "png" || kind === "heic";

const PANEL =
  "fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/** Before adding two or more photos: one document or several, and their order. */
export function AddDialog({
  chosen,
  close,
  add,
  container,
}: {
  chosen: Chosen[];
  close: () => void;
  add: (files: File[], together: boolean) => void;
  /** Where it opens: inside the chat panel, so it counts as the panel's. */
  container?: RefObject<HTMLElement | null> | null;
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
      <Dialog.Portal container={container ?? undefined}>
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
                <IconButton
                  label={`Move ${file.file.name}`}
                  icon={GripVertical}
                  className="cursor-grab"
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "ArrowUp") move(index, index - 1);
                    else if (event.key === "ArrowDown") move(index, index + 1);
                    else return;
                    event.preventDefault();
                  }}
                />
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
            <Dialog.Close render={<Button icon={X} />}>Cancel</Dialog.Close>
            <Button
              look="main"
              icon={Plus}
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
