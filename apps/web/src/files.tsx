// What a reply shows besides its text: a picture or a page the AI made, by
// the path the reply holds, and a Mermaid diagram. A file comes from the core
// by a short-lived address for that one file (/api/files); a page draws in the
// reply in a locked frame and opens large over the chat in another, and a
// diagram draws in one (diagram/frame.ts). A file that is gone says so.
import { Dialog } from "@base-ui/react/dialog";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { PAGE_ESCAPE, ShownFile } from "@rufi/contracts";
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
  useContext,
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
import { Menus } from "./model-menu.tsx";

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
        (reference.data?.shape === "picture" ||
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

/** Keep an inline page's automatic first load from taking the focus. */
function keepFocusOnLoad(frame: HTMLIFrameElement | null) {
  if (!frame) return;
  const before = document.activeElement;
  const loaded = () => {
    if (document.activeElement === frame && before instanceof HTMLElement) {
      before.focus({ preventScroll: true });
    }
  };
  frame.addEventListener("load", loaded, { once: true });
  return () => {
    frame.removeEventListener("load", loaded);
  };
}

/**
 * A page the AI made, drawn in the reply at a fixed height (it scrolls inside
 * its frame), with its title (the reply's words for it, or its file name)
 * and Open, which shows it large over the chat.
 */
export function Page({ path, title }: { path: string; title: string }) {
  // Rufi's appearance, when it is light or dark, goes in the page's address:
  // a frame follows the system's otherwise. A new one loads the page again.
  const appearance = useRootData("appearance", "system");
  return (
    <ShownPage
      key={appearance}
      path={path}
      title={title}
      appearance={appearance}
    />
  );
}

/** A page's address, with Rufi's appearance when it is light or dark. */
const inAppearance = (url: string, appearance: string) =>
  appearance === "light" || appearance === "dark"
    ? `${url}${url.includes("?") ? "&" : "?"}appearance=${appearance}`
    : url;

function ShownPage({
  path,
  title,
  appearance,
}: {
  path: string;
  title: string;
  appearance: string;
}) {
  const client = useQueryClient();
  // Closed, the focus goes back to Open.
  const opener = useRef<HTMLButtonElement>(null);
  const portals = useContext(Menus);
  const file = useQuery(fileQuery(path));
  // The frame in the reply keeps the address it loaded, so a fresh one (for
  // Open) doesn't load the page again and lose what it shows. A stale address
  // may have run out; the query is asking for a fresh one.
  const [src, setSrc] = useState<string>();
  if (src === undefined && file.data && !file.isStale) {
    setSrc(inAppearance(file.data.url, appearance));
  }
  const [opened, setOpened] = useState<ShownFile | null>(null);
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const frame = useRef<HTMLIFrameElement>(null);
  // The served page relays only Esc. Its opaque origin cannot reach this
  // dialog's keys, so check the sender frame instead of moving its focus.
  useEffect(() => {
    if (!opened) return;
    const heard = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.data === PAGE_ESCAPE
      ) {
        setOpened(null);
      }
    };
    addEventListener("message", heard);
    return () => {
      removeEventListener("message", heard);
    };
  }, [opened]);
  const name = title === "" ? nameOf(path) : title;
  if (file.isError) {
    const problem = problemOf(file.error);
    if (problem === "gone") return <Gone title={name} />;
    if (problem === "refused") return <span>{name}</span>;
    return <Failed retry={() => void file.refetch()} />;
  }
  if (src === undefined) return <Loading />;
  return (
    <span className="my-1 block">
      {/* Locked twice: this frame's sandbox and the page's own policy. */}
      <iframe
        ref={keepFocusOnLoad}
        src={src}
        title={name}
        sandbox="allow-scripts"
        className="block h-100 w-full rounded-[10px] border border-line bg-paper"
      />
      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <FileCode size={12} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 break-words">
          {state === "failed"
            ? "Rufi couldn't open this file. Try again."
            : name}
        </span>
        <Button
          ref={opener}
          look="quiet"
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
                // A page gone meanwhile says so (the query says).
                setState(problemOf(error) === "gone" ? "idle" : "failed");
              });
          }}
        >
          Open
        </Button>
      </span>
      {opened && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setOpened(null);
          }}
        >
          <Dialog.Portal container={portals}>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/25" />
            <Dialog.Popup
              finalFocus={opener}
              className="fixed inset-4 z-40 flex flex-col overflow-hidden rounded-[14px] bg-surface shadow-menu outline-none"
            >
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
                ref={frame}
                src={inAppearance(opened.url, appearance)}
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

/**
 * A value on <html>, as it changes: the theme in use (`data-theme`, named by
 * public/theme.js) or the appearance chosen (`data-appearance`).
 */
function useRootData(name: "theme" | "appearance", otherwise: string): string {
  return useSyncExternalStore(
    (changed) => {
      const watch = new MutationObserver(changed);
      watch.observe(document.documentElement, {
        attributeFilter: [`data-${name}`],
      });
      return () => {
        watch.disconnect();
      };
    },
    () => document.documentElement.dataset[name] ?? otherwise,
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
  const theme = useRootData("theme", "light");
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
