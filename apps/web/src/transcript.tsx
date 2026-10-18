// The chat's transcript as the core stored it: your messages, the AI's
// replies as Markdown, with the pictures, pages and diagrams they show
// (files.tsx), each picture the AI generated, and under each answer its
// Activity and, once it completed, Based on beside it; Rufi's receipt for
// each save to the record, Rufi's own event lines (never your words), the
// line of each visit brief, which opens it, and how a reply ended when it
// didn't finish. A line between days, and a quiet line where a new AI thread
// started, and where Codex compacts or compacted the chat history. Activity is what the AI's agent reported,
// in order: its progress notes in full, its thinking headings and its steps,
// each step opening to all the agent gave about it (activity.tsx). While the
// AI works it is open and live; once the reply ended it folds into one line,
// as the Activity setting says; a click folds or opens it. It is plain
// content in the chat, never a box of its own. The chat opens at the latest
// page; older pages load as you scroll up, and the view stays where it is.
// Each entry reads only itself from the live store, so a streaming reply
// re-renders alone.
import { Popover } from "@base-ui/react/popover";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Bell,
  Brain,
  Check,
  ChevronRight,
  FileText,
  Info,
  LoaderCircle,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import remend from "remend";
import type { ActivityShown, Entry, Turn } from "@rufi/contracts";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { useShallow } from "zustand/shallow";
import { MiddleCut, StepDetails, took } from "./activity.tsx";
import { boxFor } from "./boxes.ts";
import { ChipView } from "./chips.tsx";
import { Diagram, fileIn, NativePicture, Page, Picture } from "./files.tsx";
import { dayLine, dayOf, printedTime } from "./dates.ts";
import type { Live } from "./live.ts";
import { RetryButton } from "./reading.tsx";
import { useSettings } from "./reads.ts";
import { Menus } from "./model-menu.tsx";
import { latestHeading } from "./thinking.ts";
import { isRunning } from "./transcript-state.ts";
import { Dog, LiveDog } from "./dog.tsx";
import { Button, buttonLook, ICON } from "./ui.tsx";

// The AI's text is shown as Markdown, never as HTML: no raw HTML, no remote
// images, and links only to http(s) pages, opened outside Rufi with no opener
// or referrer. A reply also shows a picture or a page in a file the AI made
// (an image or a link to its path), and draws a Mermaid diagram once it has
// ended. Anything else shows as its text.
const WEB = /^https?:\/\//i;
const webLink: Components["a"] = ({ href, children }) =>
  href !== undefined && WEB.test(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
const components: Components = { a: webLink };
const REMARK = [remarkGfm];

/** Text of a Markdown element, as written. */
const textOf = (node: {
  type: string;
  value?: string;
  children?: unknown[];
}): string =>
  node.type === "text"
    ? (node.value ?? "")
    : (node.children ?? [])
        .map((child) => textOf(child as Parameters<typeof textOf>[0]))
        .join("");

/** A reply's parts; `streaming`: it is still being written. */
const replyComponents = (streaming: boolean): Components => ({
  a: ({ href, children, node, ...rest }) => {
    const file = fileIn(href);
    if (!file) return webLink({ href, children, node, ...rest });
    const words = node ? textOf(node) : "";
    return file.shape === "page" ? (
      <Page path={file.path} title={words} />
    ) : (
      <Picture path={file.path} caption={words} />
    );
  },
  img: ({ src, alt }) => {
    const file = fileIn(typeof src === "string" ? src : undefined);
    if (!file) return null;
    return file.shape === "page" ? (
      <Page path={file.path} title={alt ?? ""} />
    ) : (
      <Picture path={file.path} caption={alt ?? ""} />
    );
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    const mermaid =
      code?.type === "element" &&
      code.tagName === "code" &&
      Array.isArray(code.properties["className"]) &&
      code.properties["className"].includes("language-mermaid");
    // Half-written, a diagram stays its code until the reply ends.
    return mermaid && !streaming ? (
      <Diagram source={textOf(code)}>
        <pre>{children}</pre>
      </Diagram>
    ) : (
      <pre>{children}</pre>
    );
  },
});

/** Made once each, so a reply's pictures don't draw again as it grows. */
const WRITING = replyComponents(true);
const ENDED = replyComponents(false);

/** A file's path, kept as written (file: too); the parts above check it. */
const keepFiles = (url: string) =>
  /^file:/i.test(url) ? url : defaultUrlTransform(url);

/** The same Markdown tree and file rules as the reply renderer above. */
const parser = unified()
  .use(remarkParse)
  .use(REMARK)
  .use(remarkRehype, { allowDangerousHtml: true });
function picturesIn(text: string): string[] {
  const tree = parser.runSync(parser.parse(text));
  const paths = new Set<string>();
  const visit = (node: (typeof tree)["children"][number] | typeof tree) => {
    if (
      node.type === "element" &&
      (node.tagName === "a" || node.tagName === "img")
    ) {
      const url = node.properties[node.tagName === "a" ? "href" : "src"];
      const file = fileIn(typeof url === "string" ? keepFiles(url) : undefined);
      if (file) {
        if (file.shape === "picture") paths.add(file.path);
        return; // A file renderer replaces this element and its children.
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return [...paths];
}

const readableReply = (text: string, streaming: boolean) =>
  streaming ? remend(text, { linkMode: "text-only" }) : text;

/**
 * Markdown shown safely. Rufi's receipt shows no links at all: a web address
 * saved in a record is its text, not a link Rufi vouches for.
 */
export function Marked({
  text,
  links = true,
  reply,
}: {
  text: string;
  links?: boolean;
  /** A reply: it shows the files it names; `streaming` while it is written. */
  reply?: { streaming: boolean };
}) {
  if (reply) {
    return (
      <Markdown
        remarkPlugins={REMARK}
        components={reply.streaming ? WRITING : ENDED}
        urlTransform={keepFiles}
        skipHtml
      >
        {text}
      </Markdown>
    );
  }
  return (
    <Markdown
      remarkPlugins={REMARK}
      components={components}
      disallowedElements={links ? ["img"] : ["img", "a"]}
      unwrapDisallowed
      skipHtml
    >
      {text}
    </Markdown>
  );
}

function Reply({
  id,
  text,
  streaming,
}: {
  id: string;
  text: string;
  streaming: boolean;
}) {
  return (
    <div className="reply" data-entry={id}>
      {/* While it streams, half-written Markdown is closed so it reads right;
          a half-written link shows as its text. */}
      <Marked text={readableReply(text, streaming)} reply={{ streaming }} />
    </div>
  );
}

/** A reply that ended without completing says how. */
const cut = (turn: Turn) =>
  turn.status !== "running" && turn.status !== "completed";

/**
 * Whether an entry is part of its reply's Activity: the AI's thinking, its
 * notes and its steps; not a compaction (a quiet line of its own) or a
 * picture the reply shows.
 */
const inActivity = (entry: Entry) =>
  entry.kind === "reasoning" ||
  (entry.kind === "activity" &&
    entry.activity !== "compaction" &&
    !(
      entry.activity === "picture" &&
      entry.status === "done" &&
      entry.detail !== null
    ));

/** An Activity line shows: thinking with no summary has nothing to show. */
const shows = (entry: Entry) =>
  entry.kind !== "reasoning" || entry.text.trim() !== "";

/**
 * What the transcript shows, in order, each as a key: "d:" a day's line
 * before an entry, "a:" a new thread started for a turn, "k:" a compaction
 * running, "c:" a compaction completed, "e:" an entry, "s:" a turn's Activity and Based on, "x:" how
 * a turn ended. A turn's Activity takes the place of its first line while it
 * runs, and sits under its answer once it ended, with Based on beside it
 * when the AI wrote How. Keys, so the list draws again only when what it
 * shows changes.
 */
function lines(state: Live): string[] {
  const { order, entries } = state;
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const lastReply = new Map<string, string>();
  const firstStep = new Map<string, string>();
  for (const id of order) {
    const entry = entries[id];
    if (!entry?.turnId) continue;
    if (!first.has(entry.turnId)) first.set(entry.turnId, id);
    last.set(entry.turnId, id);
    if (entry.kind === "reply") lastReply.set(entry.turnId, id);
    if (inActivity(entry) && !firstStep.has(entry.turnId)) {
      firstStep.set(entry.turnId, id);
    }
  }
  /** Lines before an entry, and after one ("": before them all). */
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  const add = (to: Map<string, string[]>, at: string, line: string) => {
    to.set(at, [...(to.get(at) ?? []), line]);
  };
  const turns = Object.values(state.turns).toSorted((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  for (const turn of turns) {
    const opens = first.get(turn.id);
    const closes = last.get(turn.id);
    if (opens === undefined || closes === undefined) {
      // Nothing of it was stored: its lines go where it started.
      const at =
        order.findLast(
          (id) => (entries[id]?.createdAt ?? "") <= turn.startedAt,
        ) ?? "";
      if (turn.newThread) add(after, at, `a:${turn.id}`);
      if (cut(turn)) add(after, at, `x:${turn.id}`);
      continue;
    }
    if (turn.newThread) add(before, opens, `a:${turn.id}`);
    const step = firstStep.get(turn.id);
    const answer = lastReply.get(turn.id);
    if (turn.status !== "running" && answer !== undefined) {
      if (step !== undefined || turn.how !== null) {
        add(after, answer, `s:${turn.id}`);
      }
    } else if (step !== undefined) add(before, step, `s:${turn.id}`);
    if (cut(turn)) add(after, closes, `x:${turn.id}`);
  }
  const shown = [...(after.get("") ?? [])];
  let day = "";
  for (const id of order) {
    const entry = entries[id];
    if (!entry) continue;
    shown.push(...(before.get(id) ?? []));
    // A line of a turn's Activity shows in it.
    const stepOf = entry.turnId !== null && state.turns[entry.turnId];
    if (!(stepOf && inActivity(entry))) {
      const today = dayOf(entry.createdAt);
      if (today !== day) shown.push(`d:${id}`);
      day = today;
      if (entry.activity === "compaction") {
        // One running shows until it ends; one cut (a Stop, a crash) shows
        // nothing.
        if (entry.status === "running") shown.push(`k:${id}`);
        if (entry.status === "done") shown.push(`c:${id}`);
      } else shown.push(`e:${id}`);
    }
    shown.push(...(after.get(id) ?? []));
  }
  return shown;
}

/** Where a scrolling area is, how tall its content is, and how tall its view. */
type View = { top: number; height: number; view: number };
const viewOf = (element: HTMLElement): View => ({
  top: element.scrollTop,
  height: element.scrollHeight,
  view: element.clientHeight,
});
/**
 * It moved up further than the browser moves it to keep the end in view
 * when the view grows (the box shrinks after a send) or the content gets
 * shorter (Activity folds): you scrolled.
 */
const scrolledUp = (was: View, now: View) =>
  now.top <
  was.top -
    Math.max(0, now.view - was.view) -
    Math.max(0, was.height - now.height) -
    1;

export function TranscriptView({
  live,
  personId,
  onOlder,
  className,
  inner,
}: {
  live: StoreApi<Live>;
  /** Whose chat it is, for the links its lines open. */
  personId: string;
  /** Loads the page before what is shown. */
  onOlder: () => void;
  /** The scrolling area's classes, and those of what it holds. */
  className?: string;
  inner?: string;
}) {
  const shown = useStore(live, useShallow(lines));
  const status = useStore(live, (state) => state.status);
  const empty = useStore(live, (state) => state.order.length === 0);
  const before = useStore(live, (state) => state.before);
  const older = useStore(live, (state) => state.older);
  const running = useStore(live, isRunning);
  const opening = useStore(live, (state) => state.window);
  const now = useToday();

  // Follows the reply as it streams, unless you scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef<View>({ top: 0, height: 0, view: 0 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const follow = () => {
      if (!pinned.current) return;
      // Scrolled up since, before the scroll was even reported: you read.
      if (scrolledUp(seen.current, viewOf(element))) {
        pinned.current = false;
        return;
      }
      element.scrollTop = element.scrollHeight;
      seen.current = viewOf(element);
    };
    follow();
    // New text, and a smaller view (waiting messages above the box).
    const changes = new MutationObserver(follow);
    changes.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resizes = new ResizeObserver(follow);
    resizes.observe(element);
    return () => {
      changes.disconnect();
      resizes.disconnect();
    };
  }, []);
  // What you send is followed, also if you had scrolled up before it.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    return boxFor(personId).store.subscribe((state, before) => {
      if (!state.sending || before.sending) return;
      pinned.current = true;
      element.scrollTop = element.scrollHeight;
      seen.current = viewOf(element);
    });
  }, [personId]);

  // Near the top, the page before loads; again after each one, until the
  // view is full or the chat's start is there.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = top.current;
    const root = scroller.current;
    if (!element || !root || older !== "idle") return;
    const seen = new IntersectionObserver(
      (found) => {
        if (found.some((one) => one.isIntersecting)) onOlder();
      },
      { root, rootMargin: "400px 0px 0px 0px" },
    );
    seen.observe(element);
    return () => {
      seen.disconnect();
    };
  }, [before, older, onOlder]);

  // What you read stays where it is when a page comes in above it: the
  // first entry is measured before, and the view moves by what was added.
  // A new latest page (a reconnect) opens at its end, as the chat opens.
  const anchor = useRef<{ node: Element; top: number } | null>(null);
  const opened = useRef(opening);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const topOf = (node: Element) =>
      node.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop;
    const kept = anchor.current;
    if (opened.current !== opening) {
      opened.current = opening;
      pinned.current = true;
      root.scrollTop = root.scrollHeight;
    } else if (kept?.node.isConnected && !pinned.current) {
      root.scrollTop += topOf(kept.node) - kept.top;
    }
    const node = log.current?.querySelector("[data-entry]");
    anchor.current = node ? { node, top: topOf(node) } : null;
  });

  // Positioned, so what is placed in the transcript (the screen-reader words
  // of each step) scrolls with it and never makes the page around it scroll.
  return (
    <div
      ref={scroller}
      className={`${className ?? ""} relative [overflow-anchor:none]`}
      onScroll={(event) => {
        const element = event.currentTarget;
        const now = viewOf(element);
        if (now.height - now.top - now.view < 40) pinned.current = true;
        else if (scrolledUp(seen.current, now)) pinned.current = false;
        seen.current = now;
      }}
      // A wheel up is you reading, also before its scroll is reported.
      onWheel={(event) => {
        if (event.deltaY < 0 && event.currentTarget.scrollTop > 0)
          pinned.current = false;
      }}
    >
      <div
        className={`${inner ?? ""} ${status === "open" && empty ? "h-full" : ""}`}
      >
        {status === "missing" ? (
          <p className="text-muted">There is no chat here.</p>
        ) : status === "open" && empty ? (
          // A new chat: Rufi says hello over the box.
          <div className="flex h-full items-center justify-center">
            <LiveDog size={80} />
          </div>
        ) : (
          <div
            ref={log}
            role="log"
            aria-label="Messages"
            aria-busy={running}
            className="flex flex-col gap-3"
          >
            {before !== null && (
              <div ref={top} className="min-h-px text-center text-muted">
                {older === "loading" ? (
                  <p className="flex items-center justify-center gap-1.5">
                    <LoaderCircle
                      size={13}
                      className="animate-spin"
                      aria-hidden
                    />
                    Loading earlier messages…
                  </p>
                ) : older === "failed" ? (
                  <p
                    role="alert"
                    className="flex items-center justify-center gap-1.5"
                  >
                    Rufi couldn't load earlier messages.
                    <Button look="quiet" icon={RotateCw} onClick={onOlder}>
                      Retry
                    </Button>
                  </p>
                ) : null}
              </div>
            )}
            <Whose value={personId}>
              <Today value={now}>
                {shown.map((line) => (
                  <Line key={line} live={live} line={line} />
                ))}
              </Today>
            </Whose>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ live, line }: { live: StoreApi<Live>; line: string }) {
  const id = line.slice(2);
  switch (line.slice(0, 2)) {
    case "d:":
      return <DayLine live={live} id={id} />;
    case "a:":
      return <QuietLine>New thread started</QuietLine>;
    case "k:":
      return <QuietLine>Compacting chat history…</QuietLine>;
    case "c:":
      return <QuietLine>Chat history compacted</QuietLine>;
    case "s:":
      return <ActivityView live={live} turnId={id} />;
    case "x:":
      return <Ending live={live} turnId={id} />;
    default:
      return <EntryView live={live} id={id} />;
  }
}

/** Whose chat it is, for the lines that open a page of theirs. */
const Whose = createContext("");

/** Now, for the day lines: one value for all of them. */
const Today = createContext(new Date(0));

/**
 * Now, read again at midnight and when the window gets focus (after the Mac
 * slept past midnight); it changes only when the day does.
 */
function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const next = new Date();
      setNow((was) =>
        dayOf(was.toISOString()) === dayOf(next.toISOString()) ? was : next,
      );
      const midnight = new Date(next);
      midnight.setHours(24, 0, 0, 0);
      clearTimeout(timer);
      timer = setTimeout(check, midnight.getTime() - next.getTime());
    };
    check();
    globalThis.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      globalThis.removeEventListener("focus", check);
    };
  }, []);
  return now;
}

/** The day of the entry it comes before: "Today", "Yesterday", "Thu 8 Oct". */
function DayLine({ live, id }: { live: StoreApi<Live>; id: string }) {
  const at = useStore(live, (state) => state.entries[id]?.createdAt);
  const now = use(Today);
  if (at === undefined) return null;
  return (
    <h2 className="flex items-center gap-3 text-xs font-normal text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      {dayLine(at, now)}
    </h2>
  );
}

/** Where a new AI thread started, or Codex compacts the chat history. */
function QuietLine({ children }: { children: ReactNode }) {
  return <p className="text-center text-xs text-muted italic">{children}</p>;
}

function EntryView({ live, id }: { live: StoreApi<Live>; id: string }) {
  const entry = useStore(live, (state) => state.entries[id]);
  const turn = useStore(live, (state) => state.turns[entry?.turnId ?? ""]);
  const streaming = turn?.status === "running";
  if (!entry) return null;
  return entry.kind === "message" || entry.kind === "steer" ? (
    <div
      data-entry={id}
      className="max-w-[85%] self-end rounded-2xl bg-accent-soft px-3.5 py-2"
    >
      {entry.kind === "steer" && (
        <p className="text-xs text-accent-ink">Added to the reply</p>
      )}
      {entry.refs && entry.refs.length > 0 && (
        <ul
          aria-label="Added to this message"
          className="mb-1 flex flex-wrap gap-1.5"
        >
          {entry.refs.map(({ ref, label, detail, deleted }) => (
            <li key={`${ref.type}:${ref.id}`} className="max-w-full">
              <ChipView chip={{ pointer: ref, label, detail, deleted }} />
            </li>
          ))}
        </ul>
      )}
      <p className="break-words whitespace-pre-wrap">{entry.text}</p>
    </div>
  ) : entry.kind === "receipt" ? (
    // Rufi's own receipt for a save, from what it saved: never the AI's
    // words. The core writes it as Markdown with every value escaped.
    <div
      data-entry={id}
      className="flex items-start gap-1.5 rounded-lg border border-line bg-side px-3 py-2"
    >
      <Check size={14} className="mt-1 shrink-0 text-accent-ink" aria-hidden />
      <Receipt text={entry.text} />
    </div>
  ) : entry.kind === "event" ? (
    // Rufi's own line about something that happened: never your words.
    <div
      data-entry={id}
      className="flex items-start gap-2 rounded-lg border border-line bg-side px-3 py-2"
    >
      <Bell size={14} className="mt-1 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1 break-words">
        <p className="text-xs text-muted">Rufi</p>
        <p className="whitespace-pre-wrap">{entry.text}</p>
      </div>
      {entry.link && (
        <span className="shrink-0 self-center">
          <EventLink link={entry.link} />
        </span>
      )}
    </div>
  ) : entry.kind === "brief" ? (
    <BriefLine id={id} text={entry.text} />
  ) : entry.kind === "activity" &&
    entry.activity === "picture" &&
    entry.status === "done" &&
    entry.detail !== null ? (
    // A picture the AI generated, shown even when its reply doesn't.
    <GeneratedPicture live={live} entry={entry} />
  ) : entry.kind === "activity" || entry.kind === "reasoning" ? (
    <Step live={live} id={id} />
  ) : (
    <Reply id={id} text={entry.text} streaming={streaming} />
  );
}

/** Native pictures stay until an actual reference in this turn shows them. */
function GeneratedPicture({
  live,
  entry,
}: {
  live: StoreApi<Live>;
  entry: Entry;
}) {
  const references = useStore(
    live,
    useShallow((state) => [
      ...new Set(
        state.order.flatMap((id) => {
          const reply = state.entries[id];
          return reply?.kind === "reply" && reply.turnId === entry.turnId
            ? picturesIn(
                readableReply(
                  reply.text,
                  state.turns[entry.turnId ?? ""]?.status === "running",
                ),
              )
            : [];
        }),
      ),
    ]),
  );
  return (
    <NativePicture
      path={entry.detail ?? ""}
      entryId={entry.id}
      alsoShown={references}
    />
  );
}

const steps = (n: number) => `${String(n)} ${n === 1 ? "step" : "steps"}`;

/**
 * A reply's Activity: its lines in order, open while the AI works and folded
 * into one line once the reply ended, as the Activity setting says ("always
 * show": open after too; "always hide": one working line, then folded). A
 * click folds or opens it; that choice holds until the reply ends, and is
 * this page's own. Based on sits on its line. No line when there is nothing
 * to show.
 */
function ActivityView({
  live,
  turnId,
}: {
  live: StoreApi<Live>;
  turnId: string;
}) {
  const ids = useStore(
    live,
    useShallow((state) =>
      state.order.filter((id) => {
        const entry = state.entries[id];
        return entry?.turnId === turnId && inActivity(entry) && shows(entry);
      }),
    ),
  );
  const [failed, stopped] = useStore(
    live,
    useShallow((state) => [
      ids.filter((id) => state.entries[id]?.status === "failed").length,
      ids.filter((id) => state.entries[id]?.status === "stopped").length,
    ]),
  );
  const newest = useStore(live, (state) => state.entries[ids.at(-1) ?? ""]);
  const turn = useStore(live, (state) => state.turns[turnId]);
  const setting: ActivityShown = useSettings().data?.activity ?? "working";
  const running = turn?.status === "running";
  const [chosen, choose] = useState<{ open: boolean; running: boolean }>();
  const list = useId();
  if (!turn || (ids.length === 0 && turn.how === null)) return null;
  const open =
    chosen?.running === running
      ? chosen.open
      : running
        ? setting !== "hidden"
        : setting === "shown";
  // A crash's end is a restart's time, not when the reply stopped.
  const end =
    turn.status === "interrupted" && turn.endReason === null
      ? null
      : turn.endedAt;
  const label = running
    ? open
      ? `Activity · working · ${steps(ids.length)}`
      : `Working · ${steps(ids.length)}`
    : [
        `Activity · ${steps(ids.length)}`,
        failed > 0 && `${String(failed)} failed`,
        stopped > 0 && `${String(stopped)} stopped`,
        end !== null && took(Date.parse(end) - Date.parse(turn.startedAt)),
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-activity={turnId}>
      <div className="flex min-w-0 items-center gap-4">
        {ids.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={list}
            onClick={() => {
              choose({ open: !open, running });
            }}
            className="flex min-h-8 w-fit max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left text-muted hover:text-ink"
          >
            {running ? (
              <span aria-hidden className="shrink-0">
                <Dog mood="thinking" size={20} />
              </span>
            ) : (
              <ChevronRight
                size={ICON}
                className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                aria-hidden
              />
            )}
            <span className="shrink-0">{label}</span>
            {running && !open && newest && (
              <MiddleCut
                text={
                  newest.kind === "reasoning"
                    ? latestHeading(newest.text)
                    : newest.text
                }
                mono={newest.kind === "activity" && newest.activity !== "note"}
              />
            )}
          </button>
        )}
        {turn.how !== null && <BasedOn how={turn.how} />}
      </div>
      {open && (
        <ol
          id={list}
          aria-label="Activity"
          className="flex flex-col gap-1.5 pl-5.5"
        >
          {ids.map((id) => (
            <li key={id} className="min-w-0">
              <Step live={live} id={id} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One line of Activity, as the agent reported it: a progress note in full;
 * a thinking heading, which opens to the whole summary when it has more; a
 * step with its sign, its text cut in the middle and its detail, which
 * opens to everything the agent gave about it.
 */
function Step({ live, id }: { live: StoreApi<Live>; id: string }) {
  const entry = useStore(live, (state) => state.entries[id]);
  const personId = use(Whose);
  const [open, setOpen] = useState(false);
  const details = useId();
  if (!entry) return null;
  if (entry.activity === "note") {
    return (
      // The AI's working words: in the steps' colour and at their text's
      // indent, so the answer stands out when it comes.
      <div data-entry={id} className="note pl-[19px] break-words text-muted">
        <Marked text={readableReply(entry.text, entry.status === "running")} />
      </div>
    );
  }
  if (entry.kind === "reasoning") {
    const heading = latestHeading(entry.text);
    const sign =
      entry.status === "running" ? (
        <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden />
      ) : (
        <Brain size={13} className="shrink-0" aria-hidden />
      );
    // Only a heading: nothing more to open.
    if (entry.text.replaceAll("*", "").trim() === heading) {
      return (
        <p
          data-entry={id}
          className="flex min-w-0 items-center gap-1.5 text-muted"
        >
          {sign}
          <span className="truncate">{heading}</span>
        </p>
      );
    }
    return (
      <details data-entry={id} className="group text-muted">
        <summary className="flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-1.5 hover:text-ink [&::-webkit-details-marker]:hidden">
          {sign}
          <span className="truncate">{heading}</span>
          <ChevronRight
            size={13}
            className="shrink-0 transition-transform group-open:rotate-90"
            aria-hidden
          />
        </summary>
        <div className="thought mt-1 text-[13px] break-words text-ink">
          <Marked text={entry.text} />
        </div>
      </details>
    );
  }
  return (
    <div data-entry={id} className="min-w-0 text-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        title={entry.text}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left hover:text-ink"
      >
        <ActivityIcon status={entry.status} />
        <MiddleCut
          text={
            entry.detail === null
              ? entry.text
              : `${entry.text} · ${entry.detail}`
          }
          mono
        />
      </button>
      {open && (
        <div
          id={details}
          className="mt-1 mb-1 flex flex-col gap-1.5 pl-5 text-xs"
        >
          <StepDetails personId={personId} id={id} version={entry.updatedAt} />
        </div>
      )}
    </div>
  );
}

/** A receipt longer than this many lines shows its summary, its list folded. */
const RECEIPT_LINES = 5;

/**
 * Rufi's receipt: its heading and its lines. A big save's summary shows,
 * and its list folds under "Show what was saved".
 */
export function Receipt({ text }: { text: string }) {
  const [head = "", ...rest] = text.split("\n\n");
  const list = rest.join("\n\n");
  const long = list.split("\n").length > RECEIPT_LINES;
  return (
    <div className="receipt min-w-0 flex-1 break-words">
      {long ? (
        <>
          <Marked text={head} links={false} />
          <details>
            <summary className="w-fit cursor-pointer text-[13px] text-accent-ink">
              {/* A set-aside's receipt; an older one says Dismissed. */}
              {/^\*\*(Set aside|Dismissed)\*\*/.test(head)
                ? "Show the items"
                : "Show what was saved"}
            </summary>
            <Marked text={list} links={false} />
          </details>
        </>
      ) : (
        <Marked text={text} links={false} />
      )}
    </div>
  );
}

/** An event's way to its document: Open its page, or Retry it. */
function EventLink({ link }: { link: NonNullable<Entry["link"]> }) {
  const personId = use(Whose);
  return link.action === "retry" ? (
    <RetryButton personId={personId} documentId={link.document} />
  ) : (
    <Link
      to="/people/$personId/documents/$documentId"
      params={{ personId, documentId: link.document }}
      className={buttonLook({ look: "quiet" })}
    >
      <ArrowUpRight size={ICON} aria-hidden />
      Open
    </Link>
  );
}

/** Rufi's line for a visit brief the AI made, which opens it. */
function BriefLine({ id, text }: { id: string; text: string }) {
  const personId = use(Whose);
  return (
    <div
      data-entry={id}
      className="flex items-center gap-2.5 rounded-lg border border-line bg-side px-3 py-2"
    >
      <FileText size={16} className="shrink-0 text-accent-ink" aria-hidden />
      <div className="min-w-0 flex-1 break-words">
        <p className="text-xs text-muted">Rufi</p>
        <p>{text}</p>
      </div>
      <Link
        to="/people/$personId/briefs/$briefId"
        params={{ personId, briefId: id }}
        aria-label={`Open ${text}`}
        className={buttonLook()}
      >
        <ArrowUpRight size={ICON} aria-hidden />
        Open
      </Link>
    </div>
  );
}

const STATUS_WORDS = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
} as const;

function ActivityIcon({
  status,
}: {
  status: keyof typeof STATUS_WORDS | null;
}) {
  // The sign keeps its size beside a long detail.
  const icon =
    status === "running" ? (
      <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden />
    ) : status === "failed" ? (
      <X size={13} className="shrink-0" aria-hidden />
    ) : status === "stopped" ? (
      <Square size={11} className="shrink-0" aria-hidden />
    ) : (
      <Check size={13} className="shrink-0" aria-hidden />
    );
  return (
    <>
      {icon}
      <span className="sr-only">{status && STATUS_WORDS[status]}:</span>
    </>
  );
}

/**
 * Based on, beside a reply's Activity once it completed: How, the AI's own
 * words on where the answer comes from, as plain text in a popover. A click
 * outside, Esc or Close closes it, and the focus goes back to Based on.
 */
function BasedOn({ how }: { how: string }) {
  const portals = use(Menus);
  // Opened, the popover itself has the focus, so its words come first.
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger className="flex min-h-8 w-fit shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-muted hover:text-ink data-[popup-open]:text-ink">
        <Info size={ICON} className="shrink-0" aria-hidden />
        Based on
      </Popover.Trigger>
      <Popover.Portal container={portals}>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-30"
        >
          <Popover.Popup
            ref={popup}
            initialFocus={popup}
            className="w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-surface/95 py-2 pr-1.5 pl-3 shadow-menu backdrop-blur-xl outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <Popover.Title className="text-xs font-normal text-muted">
                Based on
              </Popover.Title>
              {/* No tooltip: one would take the first Esc. */}
              <Popover.Close
                aria-label="Close"
                className={buttonLook({ look: "quiet", shape: "icon" })}
              >
                <X size={ICON} aria-hidden />
              </Popover.Close>
            </div>
            <p className="pr-1.5 break-words whitespace-pre-wrap text-ink">
              {how}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * How a reply ended, when it didn't finish, in the core's words: the
 * service's own, when it gave some, else Rufi's, with a usage limit's reset.
 */
function Ending({ live, turnId }: { live: StoreApi<Live>; turnId: string }) {
  const turn = useStore(live, (state) => state.turns[turnId]);
  if (!turn) return null;
  if (turn.endText !== null)
    return <p className="text-muted">{turn.endText}</p>;
  return (
    <p className="text-muted">
      This reply didn't finish.
      {turn.endReason === "usage_limit" && turn.resetsAt !== null && (
        <> It resets {printedTime(turn.resetsAt)}.</>
      )}
    </p>
  );
}
