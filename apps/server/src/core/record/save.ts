// A save to the record (docs/adr/0005): the AI's save_changes call, after
// the user said yes in the chat, or what the person entered in a form (the
// welcome, the profile page, Settings), which says where it came from in
// place of a message. It holds typed changes the AI made from the
// user's words, a document's draft items (items.ts), or both. Every one is
// checked first; then the save, each record's before and after, its sources,
// the items' outcome and nothing else are written in the caller's
// transaction, with the receipt built from what was written. There is no
// count limit: a big save is one transaction too. The same call again gives
// the same save; any problem saves nothing. A change rests on a message of
// the user's, found by where it is in the chat, never by its words.
import type { Ref } from "@rufi/contracts";
import { Schema } from "effect";
import { sql, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Tables } from "../store/tables.ts";
import { localTime, shownDate } from "./dates.ts";
import { ItemSave, planItems, type Earlier } from "./items.ts";
import { recordVersions } from "./read.ts";
import {
  columnsOf,
  KINDS,
  kindNamed,
  literal,
  Position,
  unitColumn,
  wordsColumn,
  visitWords,
  type Field,
  type Kind,
  type Row,
} from "./kinds.ts";

/** What the AI can do to a record with a typed change. */
const ACTIONS = [
  "add",
  "change",
  "remove",
  "restore",
  "link",
  "remove_source",
] as const;
type Asked = (typeof ACTIONS)[number];
/** What a save did to a record, as its history keeps it. */
type Action = "add" | "change" | "remove" | "restore" | "link" | "unlink";

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

/** What an action is doing, in a refusal's words. */
const DOING: Record<Asked, string> = {
  add: "adding",
  change: "changing",
  remove: "removing",
  restore: "restoring",
  link: "adding a source",
  remove_source: "taking off a source",
};

/** What an action did, in a refusal's words. */
const DONE = { add: "added", remove: "removed", restore: "restored" } as const;

/** A document page or a Visit a record rests on, as the AI names it. */
const From = Schema.Union([
  Schema.Struct({
    document: Id,
    page: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    visit: Schema.Union([
      Id,
      Schema.Struct({
        ref: Id.annotate({
          description:
            "The ref of a visit an earlier change of this save adds.",
        }),
      }),
    ]).annotate({
      description:
        "The visit's id from get_overview, or {ref} for one this save adds.",
    }),
  }),
]).annotate({ identifier: "From" });
type FromGiven = typeof From.Type;

/** One change of one kind, as the AI gives it. */
function changeOf(kind: Kind) {
  const fields = Object.fromEntries(
    Object.entries(kind.fields).map(([name, field]) => [
      name,
      Schema.optionalKey(
        field.required || field.notNull
          ? field.input
          : Schema.NullOr(field.input),
      ),
    ]),
  );
  return Schema.Struct({
    kind: Schema.Literal(kind.name),
    action: Schema.Literals(ACTIONS),
    id: Schema.optionalKey(
      Id.annotate({
        description: `The ${kind.noun}'s id, from get_overview; not when adding.`,
      }),
    ),
    ref: Schema.optionalKey(
      Id.annotate({
        description:
          'Adding only: a name for the new record within this save ("v1"), so a later change can cite it with from: [{visit: {ref: "v1"}}].',
      }),
    ),
    source: Schema.optionalKey(Position),
    from: Schema.optionalKey(
      Schema.Array(From).check(Schema.isMinLength(1)).annotate({
        description:
          "The user's document pages or visits the record rests on: with add or change, what its values came from; with link, sources to add while its values stay; with remove_source, sources to take off, as get_records lists them. A fact only from these needs no source message.",
      }),
    ),
    fields: Schema.optionalKey(
      Schema.Struct(fields).annotate({
        description:
          'Only the fields the user gave. Adding sets them; changing sets them and keeps the rest; null forgets one (a status or certainty takes "unknown" instead).',
      }),
    ),
  }).check(
    Schema.makeFilter(
      (change: {
        action: Asked;
        id?: string;
        ref?: string;
        fields?: object;
        from?: object;
      }) => {
        const issues: Schema.FilterIssue[] = [];
        const given = change.fields ?? {};
        const sourcing =
          change.action === "link" || change.action === "remove_source";
        if (sourcing && change.from === undefined) {
          issues.push({
            path: ["from"],
            issue:
              change.action === "link"
                ? "Give from: the document pages or visits to add as sources."
                : "Give from: the sources to take off.",
          });
        }
        if (
          (change.action === "remove" || change.action === "restore") &&
          change.from !== undefined
        ) {
          issues.push({
            path: ["from"],
            issue: `Leave from out: ${change.action === "remove" ? "removing" : "restoring"} takes no source.`,
          });
        }
        if (
          kind.single &&
          (change.action === "add" ||
            change.action === "remove" ||
            change.action === "restore")
        ) {
          issues.push({
            path: ["action"],
            issue: `The ${kind.noun} is never ${DONE[change.action]}: change its fields, and null clears one.`,
          });
          return issues;
        }
        if (change.ref !== undefined && change.action !== "add") {
          issues.push({
            path: ["ref"],
            issue: "Leave ref out: it names a record this save adds.",
          });
        }
        if (change.action === "add") {
          if (change.id !== undefined) {
            issues.push({
              path: ["id"],
              issue:
                "Leave id out when adding: Rufi gives the new record its id.",
            });
          }
          for (const [name, field] of Object.entries(kind.fields)) {
            const inherited =
              field.inheritsVia !== undefined && field.inheritsVia in given;
            if (field.required && !(name in given) && !inherited) {
              issues.push({
                path: ["fields", name],
                issue: `Give ${name} when adding a ${kind.noun}.`,
              });
            }
          }
          return issues;
        }
        if (change.id === undefined) {
          issues.push({
            path: ["id"],
            issue: `Give the id of the ${kind.noun} to ${change.action}.`,
          });
        }
        if (change.action === "change" && Object.keys(given).length === 0) {
          issues.push({
            path: ["fields"],
            issue: "Give the fields to change.",
          });
        }
        if (change.action !== "change" && change.fields !== undefined) {
          issues.push({
            path: ["fields"],
            issue: `Leave fields out: ${DOING[change.action]} changes no field.`,
          });
        }
        return issues;
      },
    ),
  );
}

/** save_changes' input: typed changes, draft items, or both; no count limit. */
export const SaveInput = Schema.Struct({
  changes: Schema.optionalKey(
    Schema.Array(Schema.Union(KINDS.map(changeOf))).check(
      Schema.isMinLength(1),
    ),
  ),
  items: Schema.optionalKey(
    Schema.Array(ItemSave).check(Schema.isMinLength(1)).annotate({
      description:
        "Draft items of the user's documents to save, as get_documents gave them.",
    }),
  ),
}).check(
  Schema.makeFilter((input: { changes?: unknown; items?: unknown }) =>
    input.changes === undefined && input.items === undefined
      ? "Give changes, items, or both."
      : undefined,
  ),
);
export type SaveRequest = typeof SaveInput.Type;

/** A problem with one part of the input, in words the AI can act on. */
export interface Problem {
  path: string;
  got: string;
  fix: string;
}

/** A save Rufi refused; nothing of it was written. */
export class SaveRefused extends Error {
  readonly problems: Problem[];
  constructor(message: string, problems: Problem[] = []) {
    super(message);
    this.problems = problems;
  }
}

export interface Saved {
  /** The save's id; its receipt is the transcript entry with the same id. */
  id: string;
  /** The receipt as Markdown, from what was written. */
  receipt: string;
  /** False when nothing new was written: the call was saved before, or every item was. */
  fresh: boolean;
  changes: { kind: string; action: Action; id: string }[];
  /** Items saved before at the version named, with their earlier save. */
  earlier: Earlier[];
}

/** Where the person entered a form's save. */
export type FormOrigin = "welcome" | "profile" | "settings";

/** Where a save is made: in a chat, by the AI's call, or in a form. */
type Where = {
  personId: string;
  /** The agent's id for the call, or the form's id for one sending. */
  callId: string;
  now: string;
  /** The references of the user's messages in this turn: still as they were. */
  refs?: readonly Ref[];
} & (
  | {
      chatId: string;
      /** Rufi's id for the turn the call is in, when it has one. */
      turnId?: string | undefined;
      form?: undefined;
    }
  | { form: FormOrigin; chatId?: undefined; turnId?: undefined }
);

/** A message of the user's a change rests on. */
export interface Source {
  id: string;
  /** When it was sent, in the Mac's local time. */
  local: string;
}

/** The user's message at a position, or this turn's: a Source, or why there is none. */
export type MessageAt = (
  position: number | undefined,
) => Promise<Source | string>;

/** A page of a document a record rests on. */
interface Page {
  document: string;
  page: number;
  /** Its file's name. */
  name: string;
}

/**
 * A document page or a Visit a typed change names in from: a Visit by its
 * id, or by the ref of the change in this save that adds it until that is
 * written.
 */
type Cite =
  | ({ type: "document_page" } & Page)
  | { type: "visit"; id?: string | undefined; ref?: string };

const describe = (value: unknown) => {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/**
 * Checks `changes` and writes them in `trx`, or throws SaveRefused with
 * every problem. Run it in the transaction that adds the receipt.
 */
export async function saveChanges(
  trx: Transaction<Tables>,
  where: Where,
  input: SaveRequest,
): Promise<Saved> {
  const changes = input.changes ?? [];
  const request = JSON.stringify(input);
  const earlier = await trx
    .selectFrom("operations")
    .select(["id", "request"])
    .where("person_id", "=", where.personId)
    .where("call_id", "=", where.callId)
    .executeTakeFirst();
  if (earlier) {
    if (earlier.request !== request) {
      throw new SaveRefused(
        "This call was already used for another save, so nothing was saved. Make a new call.",
      );
    }
    return replay(trx, where.personId, earlier);
  }

  const messageAt: MessageAt =
    where.form === undefined
      ? messagesOf(trx, where.personId, where.chatId, where.turnId)
      : () => Promise.resolve("A form's save rests on what was entered.");

  const problems: Problem[] = [];
  const problem = (path: string, got: unknown, fix: string) =>
    problems.push({ path, got: describe(got), fix });
  const planned: Planned[] = [];
  /** Records the save changes, "kind:id", and the change that does. */
  const touched = new Map<string, string>();
  const pointed = (where.refs ?? []).filter((ref) => ref.type === "record");

  /** The refs of the records this save adds, so far: a later change may cite one. */
  const named = new Map<string, Kind>();

  /** The pages and Visits a change names in from, checked as this person's; undefined when one is wrong. */
  const citesOf = async (
    at: string,
    from: readonly FromGiven[],
  ): Promise<Cite[] | undefined> => {
    const cites: Cite[] = [];
    let wrong = false;
    for (const [n, given] of from.entries()) {
      const path = `${at}.from.${String(n)}`;
      if ("document" in given) {
        const page = await trx
          .selectFrom("document_pages as p")
          .innerJoin("documents as d", (join) =>
            join
              .onRef("d.person_id", "=", "p.person_id")
              .onRef("d.id", "=", "p.document_id"),
          )
          .select(["p.file_name", "d.deleted_at"])
          .where("p.person_id", "=", where.personId)
          .where("p.document_id", "=", given.document)
          .where("p.position", "=", given.page)
          .executeTakeFirst();
        const fix = !page
          ? "No page of this person's documents is at this document and page: read them with get_documents."
          : page.deleted_at !== null
            ? "This document was deleted, so its page can't be a source."
            : undefined;
        if (fix || !page) {
          problem(path, given, fix ?? "");
          wrong = true;
          continue;
        }
        cites.push({ type: "document_page", ...given, name: page.file_name });
        continue;
      }
      if (typeof given.visit !== "string") {
        const kind = named.get(given.visit.ref);
        if (kind?.name !== "visit") {
          problem(
            path,
            given,
            kind
              ? `${given.visit.ref} is a ${kind.noun} this save adds, not a visit.`
              : `No earlier change of this save adds a record with ref ${given.visit.ref}: add the visit first, with that ref.`,
          );
          wrong = true;
          continue;
        }
        cites.push({ type: "visit", ref: given.visit.ref });
        continue;
      }
      const visit = await recordOf(
        trx,
        kindNamed("visit") as Kind,
        where.personId,
        given.visit,
      );
      if (!visit || visit["removed"] === 1) {
        problem(
          path,
          given,
          visit
            ? "This visit is removed: restore it first."
            : "No visit with this id is in this person's record.",
        );
        wrong = true;
        continue;
      }
      cites.push({ type: "visit", id: given.visit });
    }
    return wrong ? undefined : cites;
  };

  for (const [index, change] of changes.entries()) {
    const at = `changes.${String(index)}`;
    const kind = kindNamed(change.kind) as Kind;
    const given = (change.fields ?? {}) as Record<string, unknown>;
    if (change.ref !== undefined) {
      if (named.has(change.ref)) {
        problem(
          `${at}.ref`,
          change.ref,
          "Another change of this save has this ref: give each added record its own.",
        );
      }
    }
    // A fact only from a page or a visit rests on no message: the user's
    // yes isn't a source. A form's rests on what was entered in it.
    const fromAlone =
      change.from !== undefined &&
      change.source === undefined &&
      change.action !== "remove_source";
    const source =
      fromAlone || where.form !== undefined
        ? undefined
        : await messageAt(change.source);
    if (typeof source === "string") {
      problem(`${at}.source`, change.source, source);
      continue;
    }

    let before: Row | undefined;
    if (change.action !== "add") {
      const id = change.id ?? "";
      const key = `${kind.name}:${id}`;
      const other = touched.get(key);
      if (other !== undefined) {
        problem(
          `${at}.id`,
          id,
          `${other} already changes this ${kind.noun}: make it one change.`,
        );
        continue;
      }
      touched.set(key, at);
      before = await recordOf(trx, kind, where.personId, id);
      const wrong = before
        ? stateProblem(kind, change.action, before, given)
        : `No ${kind.noun} with this id is in this person's record.`;
      if (wrong) {
        problem(`${at}.id`, id, wrong);
        continue;
      }
      const asked = pointed.filter((r) => r.kind === kind.name && r.id === id);
      if (asked.length > 0) {
        const version = (
          await recordVersions(trx, where.personId, [{ kind: kind.name, id }])
        ).get(key);
        if (asked.some((r) => r.version !== version)) {
          problem(
            `${at}.id`,
            id,
            `This ${kind.noun} changed since the user pointed at it: read it again, tell the user what changed and ask again.`,
          );
          continue;
        }
      }
    }

    if (change.action === "remove_source") {
      for (const [n, from] of (change.from ?? []).entries()) {
        const path = `${at}.from.${String(n)}`;
        const linked = await currentSource(
          trx,
          where.personId,
          kind,
          change.id ?? "",
          from,
        );
        if (!linked) {
          problem(
            path,
            from,
            `This isn't one of the ${kind.noun}'s sources: read its sources with get_records.`,
          );
          continue;
        }
        planned.push({
          kind,
          action: "unlink",
          id: change.id,
          source,
          cites: [linked],
          columns: {},
          before,
        });
      }
      continue;
    }

    const cites =
      change.from === undefined ? [] : await citesOf(at, change.from);
    // Named only after its own sources: a ref names an earlier change.
    if (change.ref !== undefined) named.set(change.ref, kind);
    if (!cites) continue;

    if (change.action === "link") {
      for (const cite of cites) {
        planned.push({
          kind,
          action: "link",
          id: change.id,
          source,
          cites: [cite],
          columns: {},
          before,
        });
      }
      continue;
    }

    const columns: Row =
      change.action === "remove" || change.action === "restore"
        ? { removed: change.action === "remove" ? 1 : 0 }
        : {};
    for (const [name, value] of Object.entries(given)) {
      const field = kind.fields[name] as Field;
      const path = `${at}.fields.${name}`;
      if (field.type === "link" && value !== null) {
        const link = value as { kind: string; id: string };
        const linked = kindNamed(link.kind) as Kind;
        if (!(await recordOf(trx, linked, where.personId, link.id))) {
          problem(
            path,
            value,
            `No ${linked.noun} with this id is in this person's record.`,
          );
        }
      }
      if (kind.name === "result" && name === "replaces") {
        const wrong =
          change.action === "add"
            ? await replacedProblem(trx, where.personId, String(value))
            : "replaces is only for adding an amended result.";
        if (wrong) problem(path, value, wrong);
      }
      Object.assign(columns, columnsOf(field, value));
    }

    if (change.action === "add") {
      // An amended result keeps the category of the one it replaces,
      // unless the change gives one.
      for (const [name, field] of Object.entries(kind.fields)) {
        if (field.inheritsVia === undefined || name in given) continue;
        const from = given[field.inheritsVia];
        const earlier =
          typeof from === "string"
            ? await recordOf(trx, kind, where.personId, from)
            : undefined;
        if (earlier) columns[field.column] = earlier[field.column];
      }
      for (const [name, field] of Object.entries(kind.fields)) {
        const value = columns[field.column];
        if (field.required && (value === undefined || value === null)) {
          problem(
            `${at}.fields.${name}`,
            undefined,
            `Give ${name} when adding a ${kind.noun}.`,
          );
        }
      }
    }
    if (change.action === "add" && kind.asserted) {
      columns.asserted = (source?.local ?? localTime(where.now)).slice(0, 10);
    }
    planned.push({
      kind,
      action: change.action,
      id: change.id,
      source,
      cites,
      ...(change.ref !== undefined && { ref: change.ref }),
      columns,
      before,
    });
  }
  const items =
    input.items === undefined
      ? { planned: [], earlier: [] }
      : await planItems(
          trx,
          {
            personId: where.personId,
            messageAt,
            refs: where.refs ?? [],
            problem,
            touched,
          },
          input.items,
        );
  planned.push(...items.planned);
  if (problems.length > 0) {
    throw new SaveRefused(
      "Nothing was saved. Fix these and save again.",
      problems,
    );
  }
  // Every item was saved before: nothing new to write.
  if (planned.length === 0) {
    return {
      id: "",
      receipt: "",
      fresh: false,
      changes: [],
      earlier: items.earlier,
    };
  }

  const id = uuid();
  await trx
    .insertInto("operations")
    .values({
      id,
      // Next in the order of saves; the save's transaction holds the write lock.
      seq: sql<number>`(SELECT COALESCE(MAX(seq), 0) + 1 FROM operations)`,
      person_id: where.personId,
      origin: where.form ?? "chat",
      chat_id: where.chatId ?? null,
      call_id: where.callId,
      request,
      created_at: where.now,
    })
    .execute();
  const written: Written[] = [];
  /** The ids of the records this save added, by their ref. */
  const added = new Map<string, string>();
  let seq = 0;
  for (const planning of planned) {
    const change: Planned = {
      ...planning,
      cites: planning.cites?.map((cite) =>
        cite.type === "visit" && cite.ref !== undefined
          ? { ...cite, id: added.get(cite.ref) }
          : cite,
      ),
    };
    const done = await write(trx, where, id, change);
    if (change.ref !== undefined) {
      added.set(change.ref, String(done.after["id"]));
    }
    written.push(done);
    if (done.item) {
      await trx
        .updateTable("draft_items")
        .set({
          status: "saved",
          saved_as: done.item.as,
          record_kind: change.kind.name,
          record_id: String(done.after["id"]),
          operation_id: id,
        })
        .where("person_id", "=", where.personId)
        .where("id", "=", done.item.id)
        .execute();
    }
    // A link that was there already changed nothing: no history.
    if (done.already) continue;
    await trx
      .insertInto("record_changes")
      .values({
        operation_id: id,
        seq: ++seq,
        person_id: where.personId,
        kind: change.kind.name,
        record_id: String(done.after["id"]),
        action: change.action,
        before: change.before ? JSON.stringify(change.before) : null,
        after: JSON.stringify(done.after),
        source_entry_id: change.source?.id ?? null,
      })
      .execute();
  }
  await checkAmendments(trx, where.personId, written);
  if (
    planned.some(
      (c) => c.kind.name === "allergy" || c.kind.name === "none_known",
    )
  ) {
    await checkAllergies(trx, where.personId);
  }
  const receipt = receiptText(
    written,
    await linksOf(trx, where.personId, written),
  );
  // A chat's receipt goes in its transcript; a form's stays with the save.
  if (where.form !== undefined) {
    await trx
      .updateTable("operations")
      .set({ receipt })
      .where("person_id", "=", where.personId)
      .where("id", "=", id)
      .execute();
  }
  return {
    id,
    receipt,
    fresh: true,
    changes: written.map((w) => ({
      kind: w.kind.name,
      action: w.action,
      id: String(w.after["id"]),
    })),
    earlier: items.earlier,
  };
}

/**
 * The user's messages a save can rest on, by position in this chat or, with
 * none, the newest of theirs in this turn, as stored now. Only a message or
 * a steer of this person's chat: a position never reaches another chat.
 */
function messagesOf(
  trx: Transaction<Tables>,
  personId: string,
  chatId: string,
  turnId: string | undefined,
): MessageAt {
  const found = new Map<number | undefined, Promise<Source | string>>();
  const entries = trx
    .selectFrom("transcript_entries")
    .select(["id", "kind", "created_at"])
    .where("person_id", "=", personId)
    .where("chat_id", "=", chatId);
  const look = async (position: number | undefined) => {
    if (position === undefined) {
      const newest =
        turnId === undefined
          ? undefined
          : await entries
              .where("turn_id", "=", turnId)
              .where("kind", "in", ["message", "steer"])
              .orderBy("seq", "desc")
              .executeTakeFirst();
      return newest
        ? { id: newest.id, local: localTime(newest.created_at) }
        : "This turn has no message of the user's. Give source: the position of the user's message this rests on, as read_chat shows it.";
    }
    const entry = await entries.where("seq", "=", position).executeTakeFirst();
    if (!entry) {
      return `Nothing in this chat is at position ${String(position)}. Give the position of the user's message as read_chat shows it, or leave source out for their message in this turn.`;
    }
    if (entry.kind !== "message" && entry.kind !== "steer") {
      return `Position ${String(position)} is ${ENTRY_KINDS[entry.kind] ?? `a ${entry.kind}`}, not a message of the user's. Give the position of their message as read_chat shows it, or leave source out for their message in this turn.`;
    }
    return { id: entry.id, local: localTime(entry.created_at) };
  };
  return (position) => {
    let answer = found.get(position);
    if (!answer) {
      answer = look(position);
      found.set(position, answer);
    }
    return answer;
  };
}

/** What an entry that isn't the user's message is, for the AI. */
const ENTRY_KINDS: Record<string, string> = {
  reply: "your reply",
  activity: "one of your activities",
  reasoning: "your reasoning",
  receipt: "Rufi's receipt for a save",
  event: "a Rufi event",
  brief: "Rufi's line for a visit brief",
};

/** One change to write, checked. */
export interface Planned {
  kind: Kind;
  action: Action;
  id: string | undefined;
  /** The user's message it rests on, when there is one. */
  source: Source | undefined;
  /** The document page it rests on, when there is one: a draft item's. */
  page?: Page;
  /** The pages and Visits the change named in from. */
  cites?: Cite[] | undefined;
  /** The name an added record has in this save. */
  ref?: string;
  columns: Row;
  before: Row | undefined;
  /** The draft item it saves. */
  item?: { id: string; as: "new" | "another_source" | "correction" };
  /** The report a result from a document belongs to. */
  report?: {
    document: string;
    issuer: string | null;
    number: string | null;
    collected: string | null;
  };
}

interface Written {
  kind: Kind;
  action: Action;
  before: Row | null;
  after: Row;
  source: Source | undefined;
  page: Page | undefined;
  cites: Cite[];
  item: Planned["item"];
  /** A link that was there already. */
  already?: true;
}

/** A record of the person's, removed or not. */
async function recordOf(
  trx: Transaction<Tables>,
  kind: Kind,
  personId: string,
  id: string,
): Promise<Row | undefined> {
  const { rows } =
    await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND id = ${id}`.execute(
      trx,
    );
  return rows[0];
}

/**
 * What a change may set on a result read from a report: its category. What
 * it prints and its date change only by amendment.
 */
const UNPRINTED: readonly string[] = ["category"];

/** Why the record can't take this action now. */
function stateProblem(
  kind: Kind,
  action: Asked,
  row: Row,
  given: Record<string, unknown>,
): string | undefined {
  if (
    kind.name === "result" &&
    row["report_id"] !== null &&
    action === "change" &&
    Object.keys(given).some((name) => !UNPRINTED.includes(name))
  ) {
    return "This result was read from a document, so what it prints and its date change only by amendment: add a new result with replaces set to this id. Only its category changes in place, in a change of its own.";
  }
  const removed = row["removed"] === 1;
  if (action === "change" && removed) {
    return `This ${kind.noun} is removed: restore it first.`;
  }
  if (action === "remove" && removed)
    return `This ${kind.noun} is already removed.`;
  if (action === "restore" && !removed)
    return `This ${kind.noun} isn't removed.`;
  if (action === "remove_source" && removed) {
    return `This ${kind.noun} is removed: restore it first.`;
  }
  return undefined;
}

/** Checks the final state, so removing and replacing can be in either order. */
async function checkAmendments(
  trx: Transaction<Tables>,
  personId: string,
  written: readonly Written[],
): Promise<void> {
  const parents = [
    ...new Set(
      written.flatMap(({ kind, after }) =>
        kind.name === "result" && typeof after["replaces_id"] === "string"
          ? [after["replaces_id"]]
          : [],
      ),
    ),
  ];
  if (parents.length === 0) return;
  const conflicts = await trx
    .selectFrom("results")
    .select("replaces_id")
    .where("person_id", "=", personId)
    .where("replaces_id", "in", parents)
    .where("removed", "=", 0)
    .groupBy("replaces_id")
    .having((eb) => eb.fn.countAll(), ">", 1)
    .orderBy("replaces_id")
    .execute();
  if (conflicts.length > 0) {
    throw new SaveRefused(
      "Nothing was saved.",
      conflicts.map(({ replaces_id }) => ({
        path: "changes",
        got: String(replaces_id),
        fix: "This save would leave more than one current amendment of this result. Ask the user which value is right, then save only that amendment; remove any other current amendment in the same save.",
      })),
    );
  }
}

/** Why a result can't be amended by a new one. */
async function replacedProblem(
  trx: Transaction<Tables>,
  personId: string,
  id: string,
): Promise<string | undefined> {
  const kind = kindNamed("result") as Kind;
  const row = await recordOf(trx, kind, personId, id);
  if (!row) return "No result with this id is in this person's record.";
  if (row["removed"] === 1) return "That result is removed.";
  return undefined;
}

/**
 * Writes one planned change with its sources, by save `operation`;
 * returns what was written.
 */
async function write(
  trx: Transaction<Tables>,
  where: Where,
  operation: string,
  change: Planned,
): Promise<Written> {
  const table = sql.table(change.kind.table);
  const columns: Row = { ...change.columns };
  let id = change.id ?? "";
  // A draft item's page, then the pages and Visits the change named.
  const cites: Cite[] = [
    ...(change.page
      ? [{ type: "document_page" as const, ...change.page }]
      : []),
    ...(change.cites ?? []),
  ];
  // The user's message, or what was entered in a form: this save's own.
  const message =
    where.form === undefined
      ? change.source && {
          type: "message" as const,
          entry_id: change.source.id,
          document_id: null,
          page: null,
          visit_id: null,
        }
      : {
          type: "form" as const,
          entry_id: null,
          document_id: null,
          page: null,
          visit_id: null,
        };
  /** Adds a source the record doesn't have now; false when it has it. */
  const addSource = async (
    source: NonNullable<typeof message> | Cite,
  ): Promise<boolean> => {
    const values =
      source.type === "message" || source.type === "form"
        ? source
        : {
            type: source.type,
            entry_id: null,
            document_id:
              source.type === "document_page" ? source.document : null,
            page: source.type === "document_page" ? source.page : null,
            visit_id: source.type === "visit" ? (source.id ?? "") : null,
          };
    // Each form's save is a source of its own.
    if (
      values.type !== "form" &&
      (await currentRow(trx, where.personId, change.kind, id, values))
    ) {
      return false;
    }
    await trx
      .insertInto("record_sources")
      .values({
        person_id: where.personId,
        kind: change.kind.name,
        record_id: id,
        ...values,
        operation_id: operation,
        removed_by: null,
      })
      .execute();
    return true;
  };
  let already = false;
  switch (change.action) {
    case "add": {
      id = uuid();
      Object.assign(columns, { id, person_id: where.personId });
      if (change.kind.name === "result") columns["entered_at"] = where.now;
      if (change.report) {
        columns["report_id"] = await reportFor(
          trx,
          where.personId,
          change.report,
        );
      }
      const names = Object.keys(columns);
      await sql`INSERT INTO ${table} (${sql.join(names.map((name) => sql.ref(name)))}) VALUES (${sql.join(names.map((name) => columns[name]))})`.execute(
        trx,
      );
      break;
    }
    case "link":
      already = !(await addSource(cites[0] as Cite));
      break;
    case "unlink": {
      const cite = cites[0] as Cite;
      let off = trx
        .updateTable("record_sources")
        .set({ removed_by: operation })
        .where("person_id", "=", where.personId)
        .where("kind", "=", change.kind.name)
        .where("record_id", "=", id)
        .where("removed_by", "is", null);
      off =
        cite.type === "visit"
          ? off.where("visit_id", "=", cite.id ?? "")
          : off
              .where("document_id", "=", cite.document)
              .where("page", "=", cite.page);
      await off.execute();
      break;
    }
    case "change":
    case "remove":
    case "restore": {
      const sets = Object.entries(columns).map(
        ([name, value]) => sql`${sql.ref(name)} = ${value}`,
      );
      await sql`UPDATE ${table} SET ${sql.join(sets)} WHERE person_id = ${where.personId} AND id = ${id}`.execute(
        trx,
      );
    }
  }
  // What the values now rest on: the user's message, the pages and Visits.
  if (change.action === "add" || change.action === "change") {
    if (message) await addSource(message);
    for (const cite of cites) await addSource(cite);
  }
  return {
    kind: change.kind,
    action: change.action,
    before: change.before ?? null,
    after: (await recordOf(trx, change.kind, where.personId, id)) as Row,
    source: change.source,
    page: change.page,
    cites: change.cites ?? [],
    item: change.item,
    ...(already && { already: true as const }),
  };
}

/** A source row of the record's that isn't taken off, matching `source`. */
function currentRow(
  trx: Transaction<Tables>,
  personId: string,
  kind: Kind,
  id: string,
  source: {
    type: "message" | "document_page" | "visit";
    entry_id: string | null;
    document_id: string | null;
    page: number | null;
    visit_id: string | null;
  },
) {
  let query = trx
    .selectFrom("record_sources")
    .select("record_id")
    .where("person_id", "=", personId)
    .where("kind", "=", kind.name)
    .where("record_id", "=", id)
    .where("type", "=", source.type)
    .where("removed_by", "is", null);
  query =
    source.type === "message"
      ? query.where("entry_id", "=", source.entry_id)
      : source.type === "visit"
        ? query.where("visit_id", "=", source.visit_id)
        : query
            .where("document_id", "=", source.document_id)
            .where("page", "=", source.page);
  return query.executeTakeFirst();
}

/**
 * The page or Visit `from` names, when it is one of the record's sources
 * now: what remove_source takes off.
 */
async function currentSource(
  trx: Transaction<Tables>,
  personId: string,
  kind: Kind,
  id: string,
  from: FromGiven,
): Promise<Cite | undefined> {
  if ("document" in from) {
    const linked = await trx
      .selectFrom("record_sources as s")
      .innerJoin("document_pages as p", (join) =>
        join
          .onRef("p.person_id", "=", "s.person_id")
          .onRef("p.document_id", "=", "s.document_id")
          .onRef("p.position", "=", "s.page"),
      )
      .select("p.file_name")
      .where("s.person_id", "=", personId)
      .where("s.kind", "=", kind.name)
      .where("s.record_id", "=", id)
      .where("s.document_id", "=", from.document)
      .where("s.page", "=", from.page)
      .where("s.removed_by", "is", null)
      .executeTakeFirst();
    return linked && { type: "document_page", ...from, name: linked.file_name };
  }
  if (typeof from.visit !== "string") return undefined;
  const linked = await currentRow(trx, personId, kind, id, {
    type: "visit",
    entry_id: null,
    document_id: null,
    page: null,
    visit_id: from.visit,
  });
  return linked && { type: "visit", id: from.visit };
}

/** The report a result goes in: its document's, reused within it. */
async function reportFor(
  trx: Transaction<Tables>,
  personId: string,
  key: NonNullable<Planned["report"]>,
): Promise<string> {
  const found = await trx
    .selectFrom("reports")
    .select("id")
    .where("person_id", "=", personId)
    .where("document_id", "=", key.document)
    .where("issuer", "is", key.issuer)
    .where("report_number", "is", key.number)
    .where("collected", "is", key.collected)
    .executeTakeFirst();
  if (found) return found.id;
  const id = uuid();
  await trx
    .insertInto("reports")
    .values({
      id,
      person_id: personId,
      document_id: key.document,
      issuer: key.issuer,
      report_number: key.number,
      collected: key.collected,
    })
    .execute();
  return id;
}

/**
 * "No known allergies" is never current beside an allergy that may be
 * active, whichever of them the save changed. A save of other kinds isn't
 * held up by them.
 */
async function checkAllergies(trx: Transaction<Tables>, personId: string) {
  const statements = await trx
    .selectFrom("none_known")
    .select("id")
    .where("person_id", "=", personId)
    .where("category", "=", "allergies")
    .where("removed", "=", 0)
    .execute();
  if (statements.length === 0) return;
  const allergies = await trx
    .selectFrom("allergies")
    .select(["id", "substance"])
    .where("person_id", "=", personId)
    .where("removed", "=", 0)
    .where("status", "!=", "inactive")
    .execute();
  if (allergies.length === 0) return;
  throw new SaveRefused("Nothing was saved.", [
    {
      path: "changes",
      got: describe({
        none_known: statements.map((s) => s.id),
        allergies: allergies.map((a) => `${a.id} ${a.substance}`),
      }),
      fix: "'No known allergies' can't be current beside an allergy that isn't inactive. In the same save, remove the statement, or remove the allergy or make it inactive, as the user said.",
    },
  ]);
}

/** The same save again, from what it wrote then. */
async function replay(
  trx: Transaction<Tables>,
  personId: string,
  operation: { id: string },
): Promise<Saved> {
  const { id } = operation;
  const rows = await trx
    .selectFrom("record_changes")
    .select(["kind", "record_id", "action"])
    .where("person_id", "=", personId)
    .where("operation_id", "=", id)
    .orderBy("seq")
    .execute();
  const { receipt } = await trx
    .selectFrom("operations as o")
    .leftJoin("transcript_entries as e", (join) =>
      join.onRef("e.person_id", "=", "o.person_id").onRef("e.id", "=", "o.id"),
    )
    .select(sql<string>`coalesce(o.receipt, e.text)`.as("receipt"))
    .where("o.person_id", "=", personId)
    .where("o.id", "=", id)
    .executeTakeFirstOrThrow();
  return {
    id,
    receipt,
    fresh: false,
    changes: rows.map((row) => ({
      kind: row.kind,
      action: row.action as Action,
      id: row.record_id,
    })),
    earlier: [],
  };
}

/** Longest value a receipt shows, in characters. */
const VALUE_MAX = 80;

/** The records links point at, as a receipt names them: "symptom Headache". */
type Links = Map<string, string>;

const linkKey = (kind: unknown, id: unknown) => `${String(kind)}:${String(id)}`;

/** The labels of every record the rows link to. */
async function linksOf(
  trx: Transaction<Tables>,
  personId: string,
  written: readonly Written[],
): Promise<Links> {
  const links: Links = new Map();
  const visit = kindNamed("visit") as Kind;
  for (const { cites, after, kind } of written) {
    const ids = cites.flatMap((cite) =>
      cite.type === "visit" && cite.id !== undefined ? [cite.id] : [],
    );
    if (kind.name === "visit") ids.push(String(after["id"]));
    for (const id of ids) {
      const row = await recordOf(trx, visit, personId, id);
      if (row) links.set(linkKey("visit", id), visitWords(row));
    }
  }
  for (const { before, after } of written) {
    // An amended result names the one it replaces by its label.
    const replaced = after["replaces_id"];
    if (typeof replaced === "string") {
      const result = kindNamed("result") as Kind;
      const old = await recordOf(trx, result, personId, replaced);
      if (old) links.set(linkKey("replaces", replaced), result.label(old));
    }
    for (const row of [before, after]) {
      const kind = row && kindNamed(String(row["linked_kind"]));
      if (!row || !kind) continue;
      const linked = await recordOf(
        trx,
        kind,
        personId,
        String(row["linked_id"]),
      );
      if (linked) {
        links.set(
          linkKey(row["linked_kind"], row["linked_id"]),
          `${kind.noun} ${kind.label(linked)}`,
        );
      }
    }
  }
  return links;
}

/** A field's stored columns, to tell whether a change changed it. */
const storedOf = (field: Field, row: Row) =>
  JSON.stringify(
    field.type === "link"
      ? [row["linked_kind"], row["linked_id"]]
      : field.type === "date" || field.type === "due"
        ? [row[field.column], row[wordsColumn(field)]]
        : field.type === "amount"
          ? [row[field.column], row[unitColumn(field)]]
          : [row[field.column]],
  );

/** A field of a stored record, in full, as a receipt says it; undefined when unknown. */
function shownField(field: Field, row: Row, links: Links): string | undefined {
  const value = row[field.column];
  if (value === null || value === undefined) return undefined;
  switch (field.type) {
    case "boolean":
      return value === 1 ? "yes" : "no";
    case "due":
    case "date": {
      if (value === "next_visit") return "at the next visit";
      const words = row[wordsColumn(field)];
      return `${shownDate(value as string)}${typeof words === "string" ? ` ("${words}")` : ""}`;
    }
    case "link":
      return (
        links.get(linkKey(row["linked_kind"], value)) ??
        `${kindNamed(String(row["linked_kind"]))?.noun ?? "record"} ${value as string}`
      );
    case "amount":
      return `${String(Number(value))} ${String(row[unitColumn(field)])}`;
    case "value":
      if (field.column === "replaces_id") {
        return links.get(linkKey("replaces", value)) ?? (value as string);
      }
      return typeof value === "number" ? String(value) : (value as string);
  }
}

const cut = (text: string) =>
  text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;

/**
 * An old and a new value, short enough for a receipt and still different:
 * long ones start shortly before where they differ.
 */
function apart(then: string, now: string): [string, string] {
  if (then.length <= VALUE_MAX && now.length <= VALUE_MAX) return [then, now];
  let same = 0;
  while (same < then.length && then[same] === now[same]) same++;
  // Up to 30 characters before the first difference, from a word's start
  // when one begins there; never past the difference.
  let from = Math.max(0, same - 30);
  const space = then.indexOf(" ", from);
  if (from > 0 && space !== -1 && space < same) from = space + 1;
  const tail = (text: string) =>
    from > 0 ? `…${cut(text.slice(from))}` : cut(text);
  return [tail(then), tail(now)];
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The receipt for a save, from the records as written: a "Saved" heading,
 * then one line per change in Markdown, with the record's name in bold and
 * each value in italics. Every value is literal text. A save of draft items
 * starts with a summary ("Saved 42 results from …") and each line says
 * the page it came from; the screens fold a long list under the summary.
 */
function receiptText(written: readonly Written[], links: Links): string {
  const value = (text: string) =>
    text === "not given" ? text : `*${literal(text)}*`;
  const documents = [
    ...new Map(
      written.flatMap((w) => (w.page ? [[w.page.document, w.page.name]] : [])),
    ).values(),
  ];
  /** A page or a Visit, as a receipt names it. */
  const cited = (cite: Cite) =>
    cite.type === "visit"
      ? `visit ${links.get(linkKey("visit", cite.id)) ?? String(cite.id)}`
      : `${cite.name}, page ${String(cite.page)}`;
  /** Where a line's record came from: the page, and the user's message. */
  const from = ({ page, source, item, cites }: Written) => {
    if (cites.length > 0) {
      return ` · from ${cites.map((cite) => literal(cited(cite))).join(", ")}${source ? ", and your message" : ""}`;
    }
    if (!page || !item) return "";
    const where =
      documents.length === 1
        ? `page ${String(page.page)}`
        : `${page.name}, page ${String(page.page)}`;
    return ` · ${literal(where)}${source ? ", and your message" : ""}`;
  };
  const lines = written.map((w) => {
    const { kind, action, before, after } = w;
    // A statement's or the profile's label says what it is: "no known
    // allergies (as of …)", "your profile".
    const name =
      kind.name === "none_known" || kind.single
        ? `**${literal(kind.label(after))}**`
        : `${kind.noun} **${literal(kind.label(after))}**`;
    if (action === "link" || action === "unlink") {
      const cite = w.cites[0];
      const page = value(
        cite
          ? cited(cite)
          : `${w.page?.name ?? "a document"}, page ${String(w.page?.page ?? "")}`,
      );
      if (w.already) return `- The ${name} already had ${page} as a source`;
      return action === "link"
        ? `- Added a source to ${name}: ${page} (its values stay as they are)`
        : `- Took a source off ${name}: ${page} (its values stay as they are)`;
    }
    const verb = {
      add: "Added",
      change: "Changed",
      remove: "Removed",
      restore: "Put back",
    }[action];
    if (action === "remove" || action === "restore") return `- ${verb} ${name}`;
    const details: string[] = [];
    for (const [key, field] of Object.entries(kind.fields)) {
      if (action === "add") {
        const now = shownField(field, after, links);
        if (now === undefined || now === "unknown") continue;
        if (kind.inLabel.includes(key)) continue;
        details.push(
          field.shown === "status"
            ? literal(cut(now))
            : `${field.shown} ${value(cut(now))}`,
        );
        continue;
      }
      if (before && storedOf(field, before) === storedOf(field, after)) {
        continue;
      }
      let then = (before && shownField(field, before, links)) ?? "not given";
      let now = shownField(field, after, links) ?? "not given";
      // Two linked records of the same name are told apart by their ids.
      if (then === now && field.type === "link") {
        then = `${then} (${String(before?.["linked_id"])})`;
        now = `${now} (${String(after["linked_id"])})`;
      }
      [then, now] = apart(then, now);
      details.push(`${field.shown} ${value(then)} → ${value(now)}`);
    }
    // An added record's fields are a list; a change's are separate changes.
    const said =
      details.length > 0
        ? `: ${details.join(action === "add" ? ", " : "; ")}`
        : "";
    return `- ${verb} ${name}${said}${from(w)}`;
  });
  const items = written.filter((w) => w.item);
  if (items.length === 0) return `**Saved**\n\n${lines.join("\n")}`;
  const count = (as: string) => items.filter((w) => w.item?.as === as).length;
  const others = written.length - items.length;
  const parts = [
    count("new") > 0 && `${String(count("new"))} new`,
    count("another_source") > 0 &&
      plural(count("another_source"), "more source", "more sources"),
    count("correction") > 0 && plural(count("correction"), "correction"),
    others > 0 && plural(others, "other change"),
  ].filter((part) => part !== false);
  const what =
    documents.length === 1
      ? literal(documents[0] ?? "")
      : `${String(documents.length)} documents`;
  return `**Saved ${plural(items.length, "result")}** from ${what} · ${parts.join(" · ")}\n\n${lines.join("\n")}`;
}
