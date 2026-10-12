// Open work in Needs you (docs/help/record.md): the questions Rufi asked,
// each with Answer (its chip in the chat box: the person still types the
// answer), Later (hidden for 7 days) and Drop; the AI's unfinished tasks
// behind one quiet line, each with Continue and Drop; what is on Later, with
// Bring back; and what closed this week, with Reopen. Each action names the
// version the page showed: a click on a row that changed in another window
// is refused, and the row shows as it is now.
import { OpenItem, type Overview } from "@rufi/contracts/record";
import { useMutation } from "@tanstack/react-query";
import { Schema } from "effect";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  MessageCircle,
  Play,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ApiError, read } from "./api.ts";
import { ASKS } from "./ask.tsx";
import { printedDay } from "./dates.ts";
import { messageOf } from "./live.ts";
import { askRufi } from "./panel.ts";
import { personPath, queries } from "./reads.ts";
import { Button, buttonLook, ICON } from "./ui.tsx";

type Needs = Overview["needsYou"];
type Change = "later" | "bring_back" | "drop" | "reopen";

const Answer = Schema.Struct({ item: OpenItem });
const Current = Schema.Struct({
  current: Schema.Struct({
    status: Schema.Literals(["open", "done", "dropped"]),
    showAgainAt: Schema.NullOr(Schema.String),
  }),
});

/** A chip's or a name's short form of an item's text. */
const short = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Where an item stands now, in words: after a refused click. */
function standing(item: Schema.Schema.Type<typeof Current>["current"]) {
  if (item.status !== "open") return `It is ${item.status} now.`;
  return item.showAgainAt !== null && Date.parse(item.showAgainAt) > Date.now()
    ? `It is on Later until ${printedDay(item.showAgainAt)} now.`
    : "It is open now.";
}

/** How an item closed: "Saved", "Done: compared", "Dropped: not wanted". */
function outcomeOf(item: OpenItem): string {
  if (item.status === "done" && item.saved) {
    return item.outcome === null ? "Saved" : `Saved: ${item.outcome}`;
  }
  const word = item.status === "done" ? "Done" : "Dropped";
  return item.outcome === null ? word : `${word}: ${item.outcome}`;
}

/** The person's actions on open items, and why the last one was refused. */
function useActions(personId: string) {
  const [refused, setRefused] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ item, change }: { item: OpenItem; change: Change }) =>
      read(
        Answer,
        "POST",
        `${personPath(personId)}/open-work/${encodeURIComponent(item.id)}`,
        { change, version: item.version },
      ),
    onMutate: () => {
      setRefused(null);
    },
    onError: (error, { item }) => {
      const current =
        error instanceof ApiError && error.status === 409
          ? Schema.decodeUnknownOption(Current)(error.body)
          : undefined;
      setRefused(
        current?._tag === "Some"
          ? `“${short(item.text)}” changed in another window. ${standing(current.value.current)}`
          : messageOf(error),
      );
    },
    onSettled: () =>
      queries.invalidateQueries({ queryKey: ["overview", personId] }),
  });
  return {
    refused,
    busy: act.isPending ? act.variables : undefined,
    run: (item: OpenItem, change: Change) => {
      act.mutate({ item, change });
    },
  };
}

type Actions = ReturnType<typeof useActions>;

/** An item's text: two lines, then More shows the rest. */
function ItemText({ text }: { text: string }) {
  const [whole, setWhole] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && !whole) {
      setClipped(element.scrollHeight > element.clientHeight + 1);
    }
  }, [text, whole]);
  return (
    <>
      <span ref={ref} className={whole ? "block" : "line-clamp-2"}>
        {text}
      </span>
      {(clipped || whole) && (
        <button
          type="button"
          aria-expanded={whole}
          className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink"
          onClick={() => {
            setWhole(!whole);
          }}
        >
          {whole ? "Less" : "More"}
          <ChevronDown
            size={14}
            className={whole ? "rotate-180" : ""}
            aria-hidden
          />
        </button>
      )}
    </>
  );
}

const ROW =
  "flex flex-wrap items-start gap-x-2.5 border-t border-line px-3 py-2 first:border-t-0";

/** One open item's row: its text, a quiet line under it, and its actions. */
function ItemRow({
  item,
  meta,
  actions,
  children,
}: {
  item: OpenItem;
  meta: string;
  actions: Actions;
  children: (busy: Change | undefined) => ReactNode;
}) {
  const busy =
    actions.busy?.item.id === item.id ? actions.busy.change : undefined;
  return (
    <li className={ROW}>
      <span className="min-w-0 flex-1 basis-60 py-1.5">
        <ItemText text={item.text} />
        <span className="block text-[12.5px] text-muted">{meta}</span>
      </span>
      <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
        {children(busy)}
      </span>
    </li>
  );
}

/** Puts the item's chip in the chat box: the person types their answer. */
function ToChat({
  personId,
  item,
  label,
  icon,
}: {
  personId: string;
  item: OpenItem;
  label: "Answer" | "Continue";
  icon: typeof MessageCircle;
}) {
  return (
    <Button
      look="quiet"
      icon={icon}
      aria-label={`${label}: ${short(item.text)}`}
      {...ASKS}
      onClick={() => {
        askRufi(personId, [
          {
            pointer: { type: "open_item", id: item.id },
            label: short(item.text, 120),
            detail: "",
          },
        ]);
      }}
    >
      {label}
    </Button>
  );
}

function Act({
  item,
  change,
  actions,
  busy,
}: {
  item: OpenItem;
  change: Change;
  actions: Actions;
  busy: Change | undefined;
}) {
  const { label, icon, working } = {
    later: { label: "Later", icon: Clock, working: "Hiding…" },
    bring_back: { label: "Bring back", icon: Undo2, working: "Bringing back…" },
    drop: { label: "Drop", icon: X, working: "Dropping…" },
    reopen: { label: "Reopen", icon: RotateCcw, working: "Reopening…" },
  }[change];
  return (
    <Button
      look="quiet"
      icon={icon}
      aria-label={`${label}: ${short(item.text)}`}
      busy={busy === change && working}
      disabled={busy !== undefined}
      onClick={() => {
        actions.run(item, change);
      }}
    >
      {label}
    </Button>
  );
}

/** A quiet line that opens a short list under it. */
function Disclosure({
  label,
  open,
  toggle,
}: {
  label: string;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      className={buttonLook({ look: "quiet" })}
      onClick={toggle}
    >
      {open ? (
        <ChevronDown size={ICON} aria-hidden />
      ) : (
        <ChevronRight size={ICON} aria-hidden />
      )}
      {label}
    </button>
  );
}

/** Whether Needs you has open work to show. */
export const hasOpenWork = (needs: Needs) =>
  needs.questions.length +
    needs.tasks.length +
    needs.later.length +
    needs.closed.length >
  0;

/**
 * Needs you's open work: Rufi asked (the open questions, newest first),
 * then `children` (what Needs you works out: documents, follow-ups), then
 * the quiet line of tasks, Later and Closed this week.
 */
export function OpenWork({
  personId,
  needs,
  children,
}: {
  personId: string;
  needs: Needs;
  children: ReactNode;
}) {
  const actions = useActions(personId);
  const [shown, setShown] = useState<"tasks" | "later" | "closed" | null>(null);
  const toggle = (which: NonNullable<typeof shown>) => () => {
    setShown(shown === which ? null : which);
  };
  const { questions, tasks, later, closed } = needs;
  const list = (
    items: readonly OpenItem[],
    meta: (item: OpenItem) => string,
    buttons: (item: OpenItem, busy: Change | undefined) => ReactNode,
    label: string,
  ) => (
    <ul
      aria-label={label}
      className="mb-2 rounded-xl border border-line bg-surface"
    >
      {items.map((item) => (
        <ItemRow key={item.id} item={item} meta={meta(item)} actions={actions}>
          {(busy) => buttons(item, busy)}
        </ItemRow>
      ))}
    </ul>
  );
  return (
    <>
      {actions.refused !== null && (
        <p role="status" className="mb-2 px-0.5 text-muted">
          {actions.refused}
        </p>
      )}
      {questions.length > 0 && (
        <>
          <h3 className="mb-1 px-0.5 text-[12.5px] font-semibold text-muted">
            Rufi asked
          </h3>
          {list(
            questions,
            (item) => printedDay(item.createdAt),
            (item, busy) => (
              <>
                <ToChat
                  personId={personId}
                  item={item}
                  label="Answer"
                  icon={MessageCircle}
                />
                <Act item={item} change="later" actions={actions} busy={busy} />
                <Act item={item} change="drop" actions={actions} busy={busy} />
              </>
            ),
            "Rufi asked",
          )}
        </>
      )}
      {children}
      {(tasks.length > 0 || later.length > 0 || closed.length > 0) && (
        <div className="mb-1 flex flex-wrap gap-1">
          {tasks.length > 0 && (
            <Disclosure
              label={`Rufi has ${String(tasks.length)} unfinished ${tasks.length === 1 ? "task" : "tasks"}`}
              open={shown === "tasks"}
              toggle={toggle("tasks")}
            />
          )}
          {later.length > 0 && (
            <Disclosure
              label={`Later (${String(later.length)})`}
              open={shown === "later"}
              toggle={toggle("later")}
            />
          )}
          {closed.length > 0 && (
            <Disclosure
              label={`Closed this week (${String(closed.length)})`}
              open={shown === "closed"}
              toggle={toggle("closed")}
            />
          )}
        </div>
      )}
      {shown === "tasks" &&
        tasks.length > 0 &&
        list(
          tasks,
          (item) => `Rufi's task · ${printedDay(item.createdAt)}`,
          (item, busy) => (
            <>
              <ToChat
                personId={personId}
                item={item}
                label="Continue"
                icon={Play}
              />
              <Act item={item} change="drop" actions={actions} busy={busy} />
            </>
          ),
          "Unfinished tasks",
        )}
      {shown === "later" &&
        later.length > 0 &&
        list(
          later,
          (item) => `Back on ${printedDay(item.showAgainAt ?? item.createdAt)}`,
          (item, busy) => (
            <Act
              item={item}
              change="bring_back"
              actions={actions}
              busy={busy}
            />
          ),
          "Later",
        )}
      {shown === "closed" &&
        closed.length > 0 &&
        list(
          closed,
          outcomeOf,
          (item, busy) => (
            <Act item={item} change="reopen" actions={actions} busy={busy} />
          ),
          "Closed this week",
        )}
    </>
  );
}
