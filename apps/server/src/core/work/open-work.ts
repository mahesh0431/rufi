// Open work (docs/adr/0016): what Rufi helps the person finish, or keeps for
// them to come back to. Most of it is worked out from its own data each time
// it is read: documents to save, readings that failed, follow-ups due. What
// has no other home is stored here as an open item: a question the AI asked
// the person, or a task the AI accepted that spans replies.
// This module is the only way to open items: Overview's Needs you, the
// person's actions on it, the AI's two tools and the snapshot each turn
// carries all go through it. It owns the rules that must never go wrong:
// each person's items are their own, a change names the version it was made
// on, the same AI call is one change, and every change is written with its
// history row in one transaction. Then it tells its listeners.
// What a question means, when it is answered and what "not now" is, the AI
// decides; nothing here reads the person's words.
import type { Chip } from "@rufi/contracts";
import type {
  FollowUpNeed,
  OpenItem,
  OpenItemAction,
  WaitingDocument,
} from "@rufi/contracts/record";
import { Schema } from "effect";
import type { Kysely, Selectable } from "kysely";
import { v7 as uuid } from "uuid";
import { chipsOf, RefRefusal, refState } from "../chat/refs.ts";
import { dateProblem, localTime, shownDate } from "../record/dates.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

type Row = Selectable<Tables["open_items"]>;
type Db = Kysely<Tables>;

/** What Needs you works out from other data: it is never stored here. */
export interface Derived {
  documents: readonly WaitingDocument[];
  followUps: readonly FollowUpNeed[];
}

/** How long Later hides an item by default, in calendar days. */
const LATER_DAYS = 7;
/** The furthest Later can go, in days. */
const LATER_MAX_DAYS = 365;
/** Needs you shows items closed this many days back. */
const CLOSED_SHOWN_DAYS = 7;
/** get_open_work lists items closed this many days back. */
const CLOSED_LISTED_DAYS = 30;
/** Items in one page of get_open_work's list. */
const PAGE_ITEMS = 20;
/** Items the snapshot names; it counts the rest. */
const SNAPSHOT_LINES = 10;
/** The snapshot shows this much of an item's text. */
const SNAPSHOT_CHARS = 200;

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);
const Words = (max: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );
const Version = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "The item's version as you last read it.",
});
const Item = Id.annotate({ description: "The open item's id." });

/** What an item can be about: the person's data, as a chat's chips point at it. */
const About = Schema.Union([
  Schema.Struct({ type: Schema.Literal("document"), id: Id }),
  Schema.Struct({ type: Schema.Literal("draft_item"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("record"),
    kind: Id.annotate({ description: "The record's kind, as get_records." }),
    id: Id,
  }),
  Schema.Struct({ type: Schema.Literal("report"), id: Id }),
]);

/** One change to open work, as the AI asks for it. */
export const TrackInput = Schema.Union([
  Schema.Struct({
    change: Schema.Literal("add"),
    kind: Schema.Literals(["question", "task"]),
    text: Words(2_000).annotate({
      description:
        "Complete in itself: what is asked or to be done, with the names, values and dates it is about.",
    }),
    refs: Schema.optionalKey(
      Schema.Array(About).check(Schema.isMaxLength(20)).annotate({
        description: "The data it is about, with the ids your tools gave.",
      }),
    ),
  }),
  Schema.Struct({
    change: Schema.Literal("later"),
    item: Item,
    version: Version,
    until: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
        description:
          "The local day it shows again (YYYY-MM-DD); 7 days from today when left out.",
      }),
    ),
  }),
  Schema.Struct({
    change: Schema.Literal("bring_back"),
    item: Item,
    version: Version,
  }),
  Schema.Struct({
    change: Schema.Literal("close"),
    item: Item,
    version: Version,
    as: Schema.Literals(["done", "dropped"]),
    operation: Schema.optionalKey(
      Id.annotate({
        description:
          "The receipt id save_changes returned, when a save answered it.",
      }),
    ),
    reason: Schema.optionalKey(Words(500)),
  }).check(
    Schema.makeFilter(
      (input: { as: string; operation?: string; reason?: string }) =>
        input.as === "dropped"
          ? input.operation === undefined && input.reason !== undefined
            ? undefined
            : "Dropping takes a reason and no operation."
          : input.operation === undefined && input.reason === undefined
            ? "Closing as done takes the save's operation id, a reason, or both."
            : undefined,
    ),
  ),
  Schema.Struct({
    change: Schema.Literal("reopen"),
    item: Item,
    version: Version,
  }),
]);
export type TrackRequest = typeof TrackInput.Type;

/** What the AI reads: one item whole, or a list. */
export const ReadInput = Schema.Struct({
  item: Schema.optionalKey(
    Item.annotate({ description: "One item's id: it comes back whole." }),
  ),
  show: Schema.optionalKey(
    Schema.Literals(["open", "later", "closed"]).annotate({
      description:
        "open (the default): open and not on Later; later: on Later; closed: closed in the last 30 days.",
    }),
  ),
  next: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "The next value of the list before, to read on.",
    }),
  ),
}).check(
  Schema.makeFilter((input: { item?: string; show?: string; next?: string }) =>
    input.item !== undefined &&
    (input.show !== undefined || input.next !== undefined)
      ? "Give item alone, or show and next."
      : undefined,
  ),
);
export type ReadRequest = typeof ReadInput.Type;

/**
 * A change Rufi didn't make, in words the AI or the person can act on; with
 * the item as it is now when it is about the item's state.
 */
export class OpenWorkRefusal extends Error {
  readonly current: OpenItem | undefined;
  constructor(message: string, current?: OpenItem) {
    super(message);
    this.current = current;
  }
}

/** No such item for this person. */
export class NoSuchItem extends Error {}

/** Who asked, from Rufi, never from the model: the chat's person and the call. */
export interface Trusted {
  personId: string;
  chatId: string;
  /** The agent's id for the turn; Rufi finds its own turn by it. */
  agentTurnId: string;
  callId: string;
}

/** Why a Rufi event's turn can't make a change. */
const EVENT_TURN =
  "This turn was started by a Rufi event, not by the user. In it you can record a question or task, and close one only when its outcome is already saved, or when your own task is done. Answering, dropping, reopening or putting off the user's question waits for their own message.";

const toItem = (row: Row): OpenItem => ({
  id: row.id,
  kind: row.kind as OpenItem["kind"],
  text: row.text,
  status: row.status as OpenItem["status"],
  outcome: row.outcome,
  saved: row.operation_id !== null,
  showAgainAt: row.show_again_at,
  version: row.version,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

/** The input in one form whatever its keys' order: the same call is the same text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** The start of the local day `days` after `at`'s, as an ISO time. */
function localDayStart(at: Date, days: number): string {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.toISOString();
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

const shownDay = (iso: string) => shownDate(localTime(iso).slice(0, 10));

export type OpenWork = ReturnType<typeof openWork>;

export function openWork(options: {
  /** Writes go here. */
  store: Store;
  /** Reads go here, Rufi's read-only connection, when there is one. */
  reader?: Store | undefined;
  /** What Needs you works out from other data, for a person. */
  derived: (personId: string) => Promise<Derived>;
  now?: () => string;
}) {
  const { store, derived } = options;
  const read = (options.reader ?? store).query;
  const clock = () =>
    new Date(options.now === undefined ? Date.now() : options.now());
  const listeners = new Map<string, Set<() => void>>();

  const changed = (personId: string) => {
    for (const listener of listeners.get(personId) ?? []) listener();
  };

  const onLater = (row: Row, at: string) =>
    row.status === "open" &&
    row.show_again_at !== null &&
    row.show_again_at > at;

  /** The person's items that are open, or closed since `since`; newest first. */
  const itemsOf = (db: Db, personId: string, since: string) =>
    db
      .selectFrom("open_items")
      .selectAll()
      .where("person_id", "=", personId)
      .where((eb) =>
        eb.or([eb("status", "=", "open"), eb("closed_at", ">=", since)]),
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();

  const daysBefore = (at: Date, days: number) =>
    new Date(at.getTime() - days * 86_400_000).toISOString();

  /** The person's open items in their groups, at `at`. */
  async function groups(db: Db, personId: string, closedDays: number) {
    const now = clock();
    const at = now.toISOString();
    const rows = await itemsOf(db, personId, daysBefore(now, closedDays));
    const open = rows.filter(
      (row) => row.status === "open" && !onLater(row, at),
    );
    return {
      questions: open.filter((row) => row.kind === "question"),
      tasks: open.filter((row) => row.kind === "task"),
      later: rows
        .filter((row) => onLater(row, at))
        .toSorted(
          (a, b) =>
            (a.show_again_at ?? "").localeCompare(b.show_again_at ?? "") ||
            a.id.localeCompare(b.id),
        ),
      closed: rows
        .filter((row) => row.status !== "open")
        .toSorted(
          (a, b) =>
            (b.closed_at ?? "").localeCompare(a.closed_at ?? "") ||
            b.id.localeCompare(a.id),
        ),
    };
  }

  /** The counts of the derived rows, by what they wait for. */
  function derivedCounts({ documents, followUps }: Derived) {
    const documentsIn = (state: WaitingDocument["state"]) =>
      documents.filter((d) => d.state === state).length;
    const followUpsIn = (state: FollowUpNeed["state"]) =>
      followUps.filter((f) => f.state === state).length;
    return {
      documents_to_save: documentsIn("to_save"),
      documents_with_unread_pages: documentsIn("unread_pages"),
      readings_failed: documentsIn("failed"),
      follow_ups_overdue: followUpsIn("overdue"),
      follow_ups_due: followUpsIn("due"),
      follow_ups_coming_up: followUpsIn("coming_up"),
    };
  }

  /** An item as the AI's list shows it. */
  const listed = (row: Row) => ({
    id: row.id,
    kind: row.kind,
    text: row.text,
    version: row.version,
    added: localTime(row.created_at),
    ...(row.show_again_at !== null && {
      show_again: localTime(row.show_again_at),
    }),
    ...(row.status !== "open" && {
      status: row.status,
      ...(row.outcome !== null && { outcome: row.outcome }),
      ...(row.operation_id !== null && { operation: row.operation_id }),
      closed: localTime(row.closed_at ?? row.updated_at),
    }),
  });

  /** One item whole, for the AI: what it is about now, where it came from, its history. */
  async function detail(personId: string, id: string) {
    const row = await read
      .selectFrom("open_items")
      .selectAll()
      .where("person_id", "=", personId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new OpenWorkRefusal(
        "There is no open item with that id for this person. List them with get_open_work.",
      );
    }
    const turn = await read
      .selectFrom("turns")
      .select(["started_at", "status"])
      .where("person_id", "=", personId)
      .where("id", "=", row.turn_id)
      .executeTakeFirstOrThrow();
    const refs = JSON.parse(row.refs) as Chip[];
    const about = [];
    for (const chip of refs) {
      about.push({
        ...chip.ref,
        label: chip.label,
        now: await refState(read, personId, chip.ref),
      });
    }
    const history = await read
      .selectFrom("open_item_changes")
      .select(["version", "change", "by", "at", "outcome", "operation_id"])
      .where("person_id", "=", personId)
      .where("item_id", "=", id)
      .orderBy("version")
      .execute();
    return {
      ...listed(row),
      status: row.status,
      about,
      asked_in: {
        reply_started: localTime(turn.started_at),
        reply_finished: turn.status === "completed",
      },
      history: history.map((change) => ({
        version: change.version,
        change: change.change,
        by: change.by === "ai" ? "you" : "the user",
        at: localTime(change.at),
        ...(change.outcome !== null && { outcome: change.outcome }),
        ...(change.operation_id !== null && {
          operation: change.operation_id,
        }),
      })),
    };
  }

  /** A page of the AI's list, with honest counts. */
  async function list(
    personId: string,
    show: "open" | "later" | "closed",
    next: string | undefined,
  ) {
    const [items, waiting] = await Promise.all([
      groups(read, personId, CLOSED_LISTED_DAYS),
      derived(personId),
    ]);
    const rows =
      show === "later"
        ? items.later
        : show === "closed"
          ? items.closed
          : [...items.questions, ...items.tasks].toSorted(
              (a, b) =>
                b.created_at.localeCompare(a.created_at) ||
                b.id.localeCompare(a.id),
            );
    let start = 0;
    if (next !== undefined) {
      start = rows.findIndex((row) => row.id === next) + 1;
      if (start === 0) {
        throw new OpenWorkRefusal(
          "That next value isn't from this list any more: read the list again from the start.",
        );
      }
    }
    const page = rows.slice(start, start + PAGE_ITEMS);
    const last = page.at(-1);
    return {
      show,
      items: page.map(listed),
      ...(start + PAGE_ITEMS < rows.length && last && { next: last.id }),
      counts: {
        questions: items.questions.length,
        tasks: items.tasks.length,
        on_later: items.later.length,
        closed_in_30_days: items.closed.length,
        ...derivedCounts(waiting),
      },
      ...(show === "open" && {
        also_waiting: {
          documents: waiting.documents.map((d) => ({
            id: d.id,
            name: d.name,
            state: d.state,
          })),
          follow_ups: waiting.followUps.map(({ state, followUp }) => ({
            id: followUp.id,
            title: followUp.title,
            state,
          })),
        },
      }),
    };
  }

  /** The item's history row and the item after one change, in `trx`. */
  async function write(
    trx: Db,
    row: Row,
    change: {
      change: "later" | "brought_back" | "done" | "dropped" | "reopened";
      status: Row["status"];
      showAgainAt: string | null;
      outcome: string | null;
      operationId: string | null;
      at: string;
      ai?: { chatId: string; callId: string; turnId: string; request: string };
    },
  ): Promise<Row> {
    const version = row.version + 1;
    const after = await trx
      .updateTable("open_items")
      .set({
        status: change.status,
        show_again_at: change.showAgainAt,
        outcome: change.outcome,
        operation_id: change.operationId,
        closed_at:
          change.status === "open"
            ? null
            : row.status === "open"
              ? change.at
              : row.closed_at,
        version,
        updated_at: change.at,
      })
      .where("person_id", "=", row.person_id)
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await history(trx, after, change.change, change.at, change.ai);
    return after;
  }

  const history = (
    trx: Db,
    row: Row,
    change: string,
    at: string,
    ai?: { chatId: string; callId: string; turnId: string; request: string },
  ) =>
    trx
      .insertInto("open_item_changes")
      .values({
        person_id: row.person_id,
        item_id: row.id,
        version: row.version,
        at,
        by: ai ? "ai" : "person",
        change,
        chat_id: ai?.chatId ?? null,
        call_id: ai?.callId ?? null,
        turn_id: ai?.turnId ?? null,
        request: ai?.request ?? null,
        status: row.status,
        show_again_at: row.show_again_at,
        outcome: row.outcome,
        operation_id: row.operation_id,
      })
      .execute();

  /** The person's item, or NoSuchItem. */
  async function itemIn(trx: Db, personId: string, id: string): Promise<Row> {
    const row = await trx
      .selectFrom("open_items")
      .selectAll()
      .where("person_id", "=", personId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new NoSuchItem("There is no such open item.");
    return row;
  }

  /** What a change does to an open item, or why it can't. */
  function next(
    row: Row,
    change:
      | { change: "later"; until?: string }
      | { change: "bring_back" }
      | {
          change: "close";
          as: "done" | "dropped";
          operation?: string;
          reason?: string;
        }
      | { change: "reopen" },
    at: Date,
  ) {
    const current = toItem(row);
    const iso = at.toISOString();
    const refuse = (why: string) => new OpenWorkRefusal(why, current);
    switch (change.change) {
      case "later": {
        if (row.status !== "open")
          throw refuse("It is closed: reopen it first.");
        let showAgainAt = localDayStart(at, LATER_DAYS);
        if (change.until !== undefined) {
          const problem = dateProblem(change.until);
          if (problem) throw new OpenWorkRefusal(problem);
          const [y, m, d] = change.until.split("-").map(Number);
          const day = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
          if (day.toISOString() <= iso) {
            throw new OpenWorkRefusal("until must be a day after today.");
          }
          if (day.toISOString() > localDayStart(at, LATER_MAX_DAYS)) {
            throw new OpenWorkRefusal(
              "until can be at most a year from today.",
            );
          }
          showAgainAt = day.toISOString();
        }
        return {
          change: "later" as const,
          status: "open",
          showAgainAt,
          outcome: null,
          operationId: null,
        };
      }
      case "bring_back":
        if (row.status !== "open" || row.show_again_at === null) {
          throw refuse("It isn't on Later.");
        }
        return {
          change: "brought_back" as const,
          status: "open",
          showAgainAt: null,
          outcome: null,
          operationId: null,
        };
      case "close":
        if (row.status !== "open") throw refuse(`It is already ${row.status}.`);
        return {
          change: change.as,
          status: change.as,
          showAgainAt: null,
          outcome: change.reason ?? null,
          operationId: change.operation ?? null,
        };
      case "reopen":
        if (row.status === "open") throw refuse("It is open already.");
        return {
          change: "reopened" as const,
          status: "open",
          showAgainAt: null,
          outcome: null,
          operationId: null,
        };
    }
  }

  const stale = (row: Row, version: number, who: "ai" | "person") =>
    row.version === version
      ? undefined
      : new OpenWorkRefusal(
          who === "ai"
            ? `It changed since you read it: it is version ${String(row.version)} now, ${row.status}. Read it again with get_open_work before you change it.`
            : "It changed in another window. It shows as it is now.",
          toItem(row),
        );

  return {
    /**
     * Needs you: the derived rows, and the open items in their groups.
     * Each part is read on its own: a change during the read shows at the
     * next one.
     */
    needsYou: async (personId: string) => {
      const [waiting, items] = await Promise.all([
        derived(personId),
        groups(read, personId, CLOSED_SHOWN_DAYS),
      ]);
      return {
        documents: [...waiting.documents],
        followUps: [...waiting.followUps],
        questions: items.questions.map(toItem),
        tasks: items.tasks.map(toItem),
        later: items.later.map(toItem),
        closed: items.closed.map(toItem),
      };
    },

    /** get_open_work: one item whole, or a page of a list. */
    read: (personId: string, input: ReadRequest) =>
      input.item === undefined
        ? list(personId, input.show ?? "open", input.next)
        : detail(personId, input.item),

    /**
     * What the AI is told before the words of each turn: what is open now,
     * in a few lines, and how much else waits.
     */
    snapshot: async (personId: string): Promise<string> => {
      const [items, waiting] = await Promise.all([
        groups(read, personId, 0),
        derived(personId),
      ]);
      const open = [...items.questions, ...items.tasks].toSorted(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      );
      const counts = [
        items.questions.length > 0 &&
          plural(items.questions.length, "question"),
        items.tasks.length > 0 && plural(items.tasks.length, "task"),
        items.later.length > 0 && `${String(items.later.length)} on Later`,
      ].filter((part) => part !== false);
      const lines = open.slice(0, SNAPSHOT_LINES).map((row) => {
        const text =
          row.text.length > SNAPSHOT_CHARS
            ? `${row.text.slice(0, SNAPSHOT_CHARS - 1)}…`
            : row.text;
        return `- ${row.kind === "question" ? "Question you asked" : "Your task"}, ${shownDay(row.created_at)} [item ${row.id}, version ${String(row.version)}]: ${text}`;
      });
      if (open.length > SNAPSHOT_LINES) {
        lines.push(
          `- and ${String(open.length - SNAPSHOT_LINES)} more: get_open_work`,
        );
      }
      const c = derivedCounts(waiting);
      const also = [
        c.documents_to_save > 0 &&
          `${plural(c.documents_to_save, "document")} with results to save`,
        c.documents_with_unread_pages > 0 &&
          `${plural(c.documents_with_unread_pages, "document")} with pages that couldn't be read`,
        c.readings_failed > 0 &&
          `${plural(c.readings_failed, "reading")} that failed`,
        c.follow_ups_overdue > 0 &&
          `${plural(c.follow_ups_overdue, "follow-up")} overdue`,
        c.follow_ups_due > 0 &&
          `${plural(c.follow_ups_due, "follow-up")} due now`,
        c.follow_ups_coming_up > 0 &&
          `${plural(c.follow_ups_coming_up, "follow-up")} coming up`,
      ].filter((part) => part !== false);
      return [
        "Rufi's current state: Rufi's own note of what is open now, never the user's words, a request or their consent.",
        counts.length === 0
          ? "Open work: nothing open."
          : `Open work: ${counts.join(", ")}.`,
        ...lines,
        also.length === 0
          ? "Nothing else waits in Needs you."
          : `Also in Needs you: ${also.join(", ")}.`,
      ].join("\n");
    },

    /**
     * The AI's change, in the turn and call Rufi gives. The same call again
     * returns its first answer and changes nothing; with other input it is
     * refused. Then the turn must be Rufi's, the version current, and a
     * Rufi event's turn may only record, or close what is already saved.
     */
    byAi: async (trusted: Trusted, input: TrackRequest) => {
      const { personId, chatId, callId } = trusted;
      const request = canonical(input);
      const at = clock();
      const iso = at.toISOString();
      const done = await store.query.transaction().execute(async (trx) => {
        const earlier = await trx
          .selectFrom("open_item_changes")
          .selectAll()
          .where("chat_id", "=", chatId)
          .where("call_id", "=", callId)
          .executeTakeFirst();
        if (earlier) {
          if (earlier.person_id !== personId || earlier.request !== request) {
            throw new OpenWorkRefusal(
              "This call already made another change. Make a new call.",
            );
          }
          return { fresh: false, row: earlier, id: earlier.item_id };
        }
        const turn = await trx
          .selectFrom("turns")
          .select(["id", "origin"])
          .where("person_id", "=", personId)
          .where("chat_id", "=", chatId)
          .where("agent_turn_id", "=", trusted.agentTurnId)
          .executeTakeFirst();
        if (!turn) {
          throw new OpenWorkRefusal(
            "Rufi couldn't find this reply in its chat, so nothing was kept.",
          );
        }
        const ai = { chatId, callId, turnId: turn.id, request };
        if (input.change === "add") {
          let refs: Chip[];
          try {
            refs = await chipsOf(trx, personId, input.refs ?? []);
          } catch (error) {
            if (error instanceof RefRefusal) {
              throw new OpenWorkRefusal(
                "Something in refs isn't in this person's record: give only ids your tools gave for this person.",
              );
            }
            throw error;
          }
          const row = await trx
            .insertInto("open_items")
            .values({
              id: uuid(),
              person_id: personId,
              chat_id: chatId,
              turn_id: turn.id,
              kind: input.kind,
              text: input.text,
              refs: JSON.stringify(refs),
              status: "open",
              outcome: null,
              operation_id: null,
              show_again_at: null,
              version: 1,
              created_at: iso,
              updated_at: iso,
              closed_at: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await history(trx, row, "added", iso, ai);
          return { fresh: true, row, id: row.id };
        }
        let row: Row;
        try {
          row = await itemIn(trx, personId, input.item);
        } catch (error) {
          if (error instanceof NoSuchItem) {
            throw new OpenWorkRefusal(
              "There is no open item with that id for this person. List them with get_open_work.",
            );
          }
          throw error;
        }
        const old = stale(row, input.version, "ai");
        if (old) throw old;
        if (
          turn.origin === "rufi" &&
          !(
            input.change === "close" &&
            input.as === "done" &&
            (row.kind === "task" || input.operation !== undefined)
          )
        ) {
          throw new OpenWorkRefusal(EVENT_TURN);
        }
        if (input.change === "close" && input.operation !== undefined) {
          const operation = await trx
            .selectFrom("operations")
            .select("id")
            .where("person_id", "=", personId)
            .where("id", "=", input.operation)
            .executeTakeFirst();
          if (!operation) {
            throw new OpenWorkRefusal(
              "That operation isn't one of this person's saves: give the id save_changes returned.",
            );
          }
        }
        const after = await write(trx, row, {
          ...next(row, input, at),
          at: iso,
          ai,
        });
        return { fresh: true, row: after, id: after.id };
      });
      if (done.fresh) changed(personId);
      const { row } = done;
      return {
        item: done.id,
        version: row.version,
        status: row.status,
        ...(row.show_again_at !== null && {
          show_again: localTime(row.show_again_at),
        }),
        ...(row.outcome !== null && { outcome: row.outcome }),
        ...(row.operation_id !== null && { operation: row.operation_id }),
        ...(!done.fresh && {
          note: "This call was made before; nothing changed again.",
        }),
      };
    },

    /**
     * The person's action on Needs you, on the version they saw: Later
     * (7 days), Bring back, Drop or Reopen. A stale one is refused with
     * the item as it is now.
     */
    byPerson: async (
      personId: string,
      id: string,
      action: OpenItemAction,
    ): Promise<OpenItem> => {
      const at = clock();
      const after = await store.query.transaction().execute(async (trx) => {
        const row = await itemIn(trx, personId, id);
        const old = stale(row, action.version, "person");
        if (old) throw old;
        const change =
          action.change === "drop"
            ? ({ change: "close", as: "dropped" } as const)
            : { change: action.change };
        return write(trx, row, {
          ...next(row, change, at),
          at: at.toISOString(),
        });
      });
      changed(personId);
      return toItem(after);
    },

    /** Hears of every change to the person's open work, after it is stored. */
    subscribe(personId: string, listener: () => void): () => void {
      const set = listeners.get(personId) ?? new Set();
      set.add(listener);
      listeners.set(personId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(personId);
      };
    },
  };
}
