// What a reply shows besides its text: a picture the AI made, by the path
// the reply holds. A picture comes from the core by a short-lived address
// for that one file (/api/files). A file that is gone says so.
import { Dialog } from "@base-ui/react/dialog";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ShownFile } from "@rufi/contracts";
import { FileX, Image, LoaderCircle, RotateCw, X } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { ApiError, read } from "./api.ts";
import { Button } from "./ui.tsx";
import { Menus } from "./model-menu.tsx";

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

/** The path a reply's link or image names, as the AI wrote it. */
function pathOf(href: string): string {
  const bare = href.replace(/[?#].*$/, "");
  try {
    return decodeURI(bare);
  } catch {
    return bare; // not encoded as a URL: as written
  }
}

/**
 * The picture file a reply's link or image names, by its extension;
 * undefined for a web address or anything else.
 */
export function fileIn(href: string | undefined): string | undefined {
  if (href === undefined || href === "" || href.startsWith("#")) return;
  // Another scheme (a web page, data:, mailto:) isn't a file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
  const path = pathOf(href);
  return PICTURE.test(path) ? path : undefined;
}

/** A file's address lasts 10 minutes; one older than this is asked again. */
const FRESH_MS = 4 * 60_000;

const fileQuery = (path: string) => ({
  queryKey: ["file", path],
  queryFn: () =>
    read(ShownFile, "GET", `/api/files?path=${encodeURIComponent(path)}`),
  staleTime: FRESH_MS,
  gcTime: FRESH_MS,
  retry: false,
});

/** gone: inside the AI's folder but not there; refused: not a file Rufi shows. */
const problemOf = (error: unknown) =>
  error instanceof ApiError && error.status === 404
    ? "gone"
    : error instanceof ApiError && error.status === 403
      ? "refused"
      : "failed";

const nameOf = (path: string) => path.split("/").at(-1) ?? path;

/** A picture the AI made, its caption under it; a click opens it full size. */
export function Picture({ path, caption }: { path: string; caption: string }) {
  const file = useQuery(fileQuery(path));
  const portals = useContext(Menus);
  const [open, setOpen] = useState(false);
  // A picture that didn't load (gone meanwhile, or an old address) is asked
  // for again, once.
  const reloaded = useRef(false);
  // Closed, the focus goes back to the picture it opened from.
  const opener = useRef<HTMLButtonElement>(null);
  if (file.isPending) return <Loading />;
  if (file.isError) {
    const problem = problemOf(file.error);
    if (problem === "refused") return <span>{caption}</span>;
    if (problem === "gone") {
      return <Gone title={caption === "" ? nameOf(path) : caption} />;
    }
    return <Failed retry={() => void file.refetch()} />;
  }
  const { url } = file.data;
  return (
    <span className="my-1 block w-fit max-w-full">
      <button
        ref={opener}
        type="button"
        aria-label={`Open ${caption === "" ? file.data.name : caption} full size`}
        onClick={() => {
          setOpen(true);
        }}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-[10px] border border-line bg-surface"
      >
        <img
          src={url}
          alt={caption}
          className="block h-auto max-w-full"
          onError={() => {
            if (reloaded.current) return;
            reloaded.current = true;
            void file.refetch();
          }}
        />
      </button>
      {caption !== "" && (
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <Image size={12} className="shrink-0" aria-hidden />
          {caption}
        </span>
      )}
      {open && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        >
          <Dialog.Portal container={portals}>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/60" />
            <Dialog.Popup
              finalFocus={opener}
              className="fixed inset-6 z-40 flex flex-col items-center justify-center gap-2 outline-none"
            >
              <Dialog.Title className="sr-only">
                {caption === "" ? file.data.name : caption}
              </Dialog.Title>
              <Dialog.Close
                render={
                  <button
                    type="button"
                    className="flex min-h-0 cursor-zoom-out items-center justify-center"
                  />
                }
              >
                <img
                  src={url}
                  alt={caption}
                  className="max-h-[calc(100vh-6rem)] max-w-full rounded-lg bg-surface shadow-menu"
                />
              </Dialog.Close>
              <Dialog.Close render={<Button icon={X} />}>Close</Dialog.Close>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </span>
  );
}

/** A resolver's identity, including the checked name of a file that is gone. */
function identityOf(file: {
  data?: ShownFile;
  error: unknown;
}): string | undefined {
  if (file.data) return file.data.path;
  if (file.error instanceof ApiError && file.error.status === 404) {
    const body = file.error.body;
    if (
      typeof body === "object" &&
      body !== null &&
      "path" in body &&
      typeof body.path === "string"
    )
      return body.path;
  }
  return undefined;
}

/** A native picture is omitted only when Markdown shows the same file. */
export function NativePicture({
  path,
  alsoShown,
  entryId,
}: {
  path: string;
  alsoShown: string[];
  entryId: string;
}) {
  const file = useQuery(fileQuery(path));
  const references = useQueries({ queries: alsoShown.map(fileQuery) });
  const identity = identityOf(file);
  if (
    identity !== undefined &&
    references.some(
      (reference) =>
        (reference.data !== undefined ||
          problemOf(reference.error) === "gone") &&
        identityOf(reference) === identity,
    )
  )
    return null;
  return (
    <div data-entry={entryId} className="reply">
      <Picture path={path} caption="Made by the AI" />
    </div>
  );
}

/** The card of a file that is gone, with its title. */
function Gone({ title }: { title: string }) {
  return (
    <span className="my-1 flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface text-muted">
        <FileX size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold break-words">{title}</span>
        <span className="block text-xs text-muted">
          This file is no longer in the AI's folder.
        </span>
      </span>
    </span>
  );
}

function Loading() {
  return (
    <span className="my-1 flex items-center gap-1.5 text-muted">
      <LoaderCircle size={13} className="animate-spin" aria-hidden />
      Loading the file…
    </span>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <span role="alert" className="my-1 flex items-center gap-3 text-muted">
      Rufi couldn't load this file.
      <Button look="quiet" icon={RotateCw} onClick={retry}>
        Retry
      </Button>
    </span>
  );
}
