// What a reply shows besides its text: a picture or a page the AI made, by
// the path the reply holds, and a Mermaid diagram. A file comes from the core
// by a short-lived address for that one file (/api/files); a page opens over
// the chat in a locked frame, and a diagram draws in one (diagram/frame.ts).
// A file that is gone keeps its card and says so.
import { Dialog } from "@base-ui/react/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShownFile } from "@rufi/contracts";
import {
  ExternalLink,
  FileCode,
  FileX,
  Image,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ApiError, read } from "./api.ts";
import {
  DIAGRAM_COLOURS,
  type DiagramAnswer,
  type DiagramAsk,
} from "./diagram/message.ts";
import { Button } from "./ui.tsx";

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const PAGE = /\.html?$/i;

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
 * What a reply's link or image names: a picture or a page in a file, by
 * its extension; undefined for a web address or anything else.
 */
export function fileIn(
  href: string | undefined,
): { path: string; shape: "picture" | "page" } | undefined {
  if (href === undefined || href === "" || href.startsWith("#")) return;
  // Another scheme (a web page, data:, mailto:) isn't a file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
  const path = pathOf(href);
  if (PICTURE.test(path)) return { path, shape: "picture" };
  if (PAGE.test(path)) return { path, shape: "page" };
  return undefined;
}

/** Whether a reply's text shows the file at `path` itself. */
export const shows = (text: string, path: string) =>
  text.includes(path) || text.includes(encodeURI(path));

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
  const [open, setOpen] = useState(false);
  // A picture that didn't load (gone meanwhile, or an old address) is asked
  // for again, once.
  const reloaded = useRef(false);
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
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/60" />
            <Dialog.Popup className="fixed inset-6 z-40 flex flex-col items-center justify-center gap-2 outline-none">
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

/**
 * A page the AI made, as a card with its title (the reply's words for it, or
 * its file name) and Open; it runs only once opened, over the chat.
 */
export function PageCard({ path, title }: { path: string; title: string }) {
  const client = useQueryClient();
  const [opened, setOpened] = useState<ShownFile | null>(null);
  const [state, setState] = useState<"idle" | "opening" | "gone" | "failed">(
    "idle",
  );
  const name = title === "" ? nameOf(path) : title;
  if (state === "gone") return <Gone title={name} />;
  return (
    <span className="my-1 flex items-center gap-3 rounded-xl border border-line bg-side px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface text-accent-ink">
        <FileCode size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold break-words">{name}</span>
        <span className="block text-xs break-all text-muted">
          {state === "failed"
            ? "Rufi couldn't open this file. Try again."
            : path}
        </span>
      </span>
      <Button
        icon={ExternalLink}
        busy={state === "opening" && "Opening…"}
        aria-label={`Open ${name}`}
        onClick={() => {
          setState("opening");
          // A fresh address, and a check the file is there: a frame can't
          // say that its page didn't load.
          client
            .query({ ...fileQuery(path), staleTime: 0 })
            .then((file) => {
              setState("idle");
              setOpened(file);
            })
            .catch((error: unknown) => {
              setState(problemOf(error) === "gone" ? "gone" : "failed");
            });
        }}
      >
        Open
      </Button>
      {opened && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setOpened(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/25" />
            <Dialog.Popup className="fixed inset-4 z-40 flex flex-col overflow-hidden rounded-[14px] bg-surface shadow-menu outline-none">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <FileCode
                  size={18}
                  className="shrink-0 text-accent-ink"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="truncate text-[13px] font-semibold">
                    {name}
                  </Dialog.Title>
                  <p className="truncate text-xs text-muted">{path}</p>
                </div>
                <Dialog.Close render={<Button icon={X} />}>Close</Dialog.Close>
              </div>
              {/* Locked twice: this frame's sandbox and the page's own policy. */}
              <iframe
                src={opened.url}
                title={name}
                sandbox="allow-scripts"
                className="m-2.5 min-h-0 flex-1 rounded-lg border border-line bg-paper"
              />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </span>
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

/** The theme in use, as public/theme.js names it on <html data-theme>. */
function useTheme(): string {
  return useSyncExternalStore(
    (changed) => {
      const watch = new MutationObserver(changed);
      watch.observe(document.documentElement, {
        attributeFilter: ["data-theme"],
      });
      return () => {
        watch.disconnect();
      };
    },
    () => document.documentElement.dataset["theme"] ?? "light",
  );
}

/** How long a diagram may take to draw before its source stays shown. */
const DRAW_MS = 15_000;

/**
 * A Mermaid diagram, drawn in its locked frame in the theme's colours. Until
 * it is drawn, and when it can't be, its source shows as the code block.
 */
export function Diagram({
  source,
  children,
}: {
  source: string;
  /** The code block, shown until the diagram is drawn. */
  children: ReactNode;
}) {
  const theme = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [drawn, setDrawn] = useState<
    { src: string; height: number } | "failed" | null
  >(null);
  const style = getComputedStyle(document.documentElement);
  const ask: DiagramAsk = {
    source,
    colours: Object.fromEntries(
      DIAGRAM_COLOURS.map((name) => [
        name,
        style.getPropertyValue(`--${name}`).trim(),
      ]),
    ) as DiagramAsk["colours"],
    font: style.fontFamily,
    dark: theme === "dark",
  };
  // The theme is part of the address: a new theme draws it again.
  const src = `/diagram.html#${encodeURIComponent(JSON.stringify(ask))}`;
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const answer = event.data as Partial<DiagramAnswer> | null;
      if (answer?.type !== "rufi-diagram") return;
      setDrawn(
        answer.drawn === true && typeof answer.height === "number"
          ? { src, height: answer.height }
          : "failed",
      );
    };
    globalThis.addEventListener("message", heard);
    const late = setTimeout(() => {
      setDrawn((now) => now ?? "failed");
    }, DRAW_MS);
    return () => {
      globalThis.removeEventListener("message", heard);
      clearTimeout(late);
    };
  }, [src]);
  if (drawn === "failed") return children;
  const height = drawn?.src === src ? drawn.height : undefined;
  const shown = height !== undefined;
  return (
    <>
      {!shown && children}
      <iframe
        key={src}
        ref={frame}
        src={src}
        title="Diagram"
        sandbox="allow-scripts"
        className={
          shown
            ? "mb-2 block w-full rounded-[10px] border border-line bg-surface p-2.5"
            : "invisible absolute size-0"
        }
        // Its padding and border around the diagram's own height.
        style={shown ? { height: height + 22 } : undefined}
      />
    </>
  );
}
