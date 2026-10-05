// A conversation's transcript as the core stored it: your messages, one line
// per thing the AI did, the AI's replies as Markdown, Rufi's receipt for
// each save to the record, and how a reply ended when it didn't finish. Each
// entry reads only itself from the live store, so a streaming reply
// re-renders alone.
import { Link } from "@tanstack/react-router";
import { Check, LoaderCircle, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { useShallow } from "zustand/shallow";
import { printedTime } from "./dates.ts";
import type { Live } from "./live.ts";
import { isRunning } from "./transcript-state.ts";

// The AI's text is shown as Markdown, never as HTML: no raw HTML, no images,
// and links only to http(s) pages, opened outside Rufi with no opener or
// referrer. Anything else shows as its text.
const WEB = /^https?:\/\//i;
const components: Components = {
  a: ({ href, children }) =>
    href !== undefined && WEB.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

/**
 * Markdown shown safely. Rufi's receipt shows no links at all: a web address
 * saved in a record is its text, not a link Rufi vouches for.
 */
function Marked({ text, links = true }: { text: string; links?: boolean }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={components}
      disallowedElements={links ? ["img"] : ["img", "a"]}
      unwrapDisallowed
      skipHtml
    >
      {text}
    </Markdown>
  );
}

function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="reply">
      {/* While it streams, half-written Markdown is closed so it reads right;
          a half-written link shows as its text. */}
      <Marked
        text={streaming ? remend(text, { linkMode: "text-only" }) : text}
      />
    </div>
  );
}

/** Ended turns that didn't complete, by the last entry they come after. */
function endings(state: Live): Record<string, string> {
  const last: Record<string, string> = {};
  for (const id of state.order) {
    const turnId = state.entries[id]?.turnId;
    if (turnId) last[turnId] = id;
  }
  const after: Record<string, string> = {};
  for (const turn of Object.values(state.turns)) {
    if (turn.status === "running" || turn.status === "completed") continue;
    // A reply with nothing in the transcript ends at the bottom.
    after[turn.id] = last[turn.id] ?? "";
  }
  return after;
}

export function TranscriptView({
  live,
  className,
  inner,
}: {
  live: StoreApi<Live>;
  /** The scrolling area's classes, and those of what it holds. */
  className?: string;
  inner?: string;
}) {
  const order = useStore(live, (state) => state.order);
  const status = useStore(live, (state) => state.status);
  const ends = useStore(live, useShallow(endings));
  const running = useStore(live, isRunning);
  const replying = useStore(live, (state) => {
    const last = state.entries[state.order.at(-1) ?? ""];
    return (
      isRunning(state) &&
      !(
        last?.kind === "reply" &&
        state.turns[last.turnId ?? ""]?.status === "running"
      )
    );
  });
  const endsAfter = (id: string) =>
    Object.entries(ends).flatMap(([turnId, after]) =>
      after === id ? [turnId] : [],
    );

  // Follows the reply as it streams, unless you scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const follow = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
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

  return (
    <div
      ref={scroller}
      className={className}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      <div className={inner}>
        {status === "missing" ? (
          <p className="text-muted">There is no conversation here.</p>
        ) : status === "open" && order.length === 0 ? (
          <FirstMessage />
        ) : (
          <div
            role="log"
            aria-label="Conversation"
            aria-busy={running}
            className="flex flex-col gap-3"
          >
            {order.map((id) => (
              <EntryView key={id} live={live} id={id} ends={endsAfter(id)} />
            ))}
            {endsAfter("").map((turnId) => (
              <Ending key={turnId} live={live} turnId={turnId} />
            ))}
            {replying && (
              <p className="flex items-center gap-1.5 text-muted">
                <LoaderCircle size={13} className="animate-spin" aria-hidden />
                Replying…
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Before your first message: what goes to OpenAI. */
export function FirstMessage() {
  return (
    <p className="text-muted">
      What you send, and the parts of your record the AI reads to answer, go to
      OpenAI through your ChatGPT plan.{" "}
      <Link
        to="/help/$page"
        params={{ page: "your-data-and-the-ai" }}
        className="text-accent-ink underline"
      >
        Your data and the AI
      </Link>
    </p>
  );
}

function EntryView({
  live,
  id,
  ends,
}: {
  live: StoreApi<Live>;
  id: string;
  ends: string[];
}) {
  const entry = useStore(live, (state) => state.entries[id]);
  const streaming = useStore(
    live,
    (state) => state.turns[entry?.turnId ?? ""]?.status === "running",
  );
  if (!entry) return null;
  return (
    <>
      {entry.kind === "message" || entry.kind === "steer" ? (
        <div className="max-w-[85%] self-end rounded-2xl bg-accent-soft px-3.5 py-2">
          {entry.kind === "steer" && (
            <p className="text-xs text-accent-ink">Steer</p>
          )}
          <p className="break-words whitespace-pre-wrap">{entry.text}</p>
        </div>
      ) : entry.kind === "receipt" ? (
        // Rufi's own receipt for a save, from what it saved: never the AI's
        // words. The core writes it as Markdown with every value escaped.
        <div className="flex items-start gap-1.5 rounded-lg border border-line bg-side px-3 py-2">
          <Check
            size={14}
            className="mt-1 shrink-0 text-accent-ink"
            aria-hidden
          />
          <div className="receipt min-w-0 break-words">
            <Marked text={entry.text} links={false} />
          </div>
        </div>
      ) : entry.kind === "activity" ? (
        <p className="flex min-w-0 items-center gap-1.5 text-muted">
          <ActivityIcon status={entry.status} />
          <span className="shrink-0">{entry.text}</span>
          {entry.detail !== null && (
            <span className="truncate text-xs">{entry.detail}</span>
          )}
        </p>
      ) : (
        <Reply text={entry.text} streaming={streaming} />
      )}
      {ends.map((turnId) => (
        <Ending key={turnId} live={live} turnId={turnId} />
      ))}
    </>
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

/** How a reply ended, when it didn't finish, in the core's words. */
function Ending({ live, turnId }: { live: StoreApi<Live>; turnId: string }) {
  const turn = useStore(live, (state) => state.turns[turnId]);
  if (!turn) return null;
  return (
    <p className="text-muted">
      {turn.endText ?? "This reply didn't finish."}
      {turn.endReason === "usage_limit" && turn.resetsAt !== null && (
        <> It resets {printedTime(turn.resetsAt)}.</>
      )}
    </p>
  );
}
