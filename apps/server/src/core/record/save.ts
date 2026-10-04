// A save to the record (docs/adr/0005): the AI's save_changes call, after
// the user said yes in the chat. Every change is checked first; then the
// save, each record's before and after, and nothing else, are written in the
// caller's transaction, with the receipt line built from what was written.
// The same call again gives the same save; any problem saves nothing.
import { Schema } from "effect";
import { sql, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Tables } from "../store/tables.ts";
import { isAfter, localTime, shownDate } from "./dates.ts";
import {
  KINDS,
  kindNamed,
  wordsColumn,
  type Field,
  type Kind,
  type Row,
} from "./kinds.ts";

/** Changes in one save at most; the tool's description says the same number. */
export const CHANGES_MAX = 20;

const ACTIONS = ["add", "change", "remove", "restore"] as const;
type Action = (typeof ACTIONS)[number];

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

/** One change of one kind, as the AI gives it. */
function changeOf(kind: Kind) {
  const fields = Object.fromEntries(
    Object.entries(kind.fields).map(([name, field]) => [
      name,
      Schema.optionalKey(
        field.required ? field.input : Schema.NullOr(field.input),
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
    source: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1_000),
    ).annotate({
      description:
        "The user's own words this change rests on, copied exactly from one of their messages in this conversation (a sentence or part of one).",
    }),
    fields: Schema.optionalKey(
      Schema.Struct(fields).annotate({
        description:
          "Only the fields the user gave. Adding sets them; changing sets them and keeps the rest; null forgets one.",
      }),
    ),
  }).check(
    Schema.makeFilter(
      (change: { action: Action; id?: string; fields?: object }) => {
        const issues: Schema.FilterIssue[] = [];
        const given = change.fields ?? {};
        if (change.action === "add") {
          if (change.id !== undefined) {
            issues.push({
              path: ["id"],
              issue:
                "Leave id out when adding: Rufi gives the new record its id.",
            });
          }
          for (const [name, field] of Object.entries(kind.fields)) {
            if (field.required && !(name in given)) {
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
            issue: `Leave fields out: ${change.action === "remove" ? "removing" : "restoring"} changes no field.`,
          });
        }
        return issues;
      },
    ),
  );
}

/** save_changes' input. */
export const Changes = Schema.Struct({
  changes: Schema.Array(Schema.Union(KINDS.map(changeOf))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CHANGES_MAX),
  ),
});
export type Change = (typeof Changes.Type)["changes"][number];

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
  /** The receipt line, from what was written. */
  receipt: string;
  /** False when this call was saved before: nothing new was written. */
  fresh: boolean;
  changes: { kind: string; action: Action; id: string }[];
}

interface Where {
  personId: string;
  conversationId: string;
  /** The agent's id for the call. */
  callId: string;
  now: string;
}

/** A message of the user's a change rests on. */
interface Source {
  id: string;
  text: string;
  /** When it was sent, in the Mac's local time. */
  local: string;
}

/** Text compared as the words it shows: case, spacing and quote marks aside. */
const plain = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** A quote without the marks around it. */
const quoted = (text: string) =>
  plain(text).replace(/^["'\s.,;:!?…-]+|["'\s.,;:!?…-]+$/gu, "");

const describe = (value: unknown) => {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/**
 * Checks `changes` and writes them in `trx`, or throws SaveRefused with
 * every problem. Run it in the transaction that adds the receipt line.
 */
export async function saveChanges(
  trx: Transaction<Tables>,
  where: Where,
  changes: readonly Change[],
): Promise<Saved> {
  const request = JSON.stringify(changes);
  const earlier = await trx
    .selectFrom("operations")
    .select(["id", "request"])
    .where("conversation_id", "=", where.conversationId)
    .where("call_id", "=", where.callId)
    .executeTakeFirst();
  if (earlier) {
    if (earlier.request !== request) {
      throw new SaveRefused(
        "This call was already used for another save, so nothing was saved. Make a new call.",
      );
    }
    return replay(trx, where.personId, earlier.id);
  }

  const messages = await trx
    .selectFrom("transcript_entries")
    .select(["id", "text", "created_at"])
    .where("person_id", "=", where.personId)
    .where("conversation_id", "=", where.conversationId)
    .where("kind", "in", ["message", "steer"])
    .orderBy("seq", "desc")
    .execute();
  const sourceOf = (words: string): Source | undefined => {
    const wanted = quoted(words);
    if (wanted === "") return undefined;
    const found = messages.find((m) => plain(m.text).includes(wanted));
    return (
      found && {
        id: found.id,
        text: found.text,
        local: localTime(found.created_at),
      }
    );
  };

  const problems: Problem[] = [];
  const problem = (path: string, got: unknown, fix: string) =>
    problems.push({ path, got: describe(got), fix });
  const planned: Planned[] = [];
  const touched = new Map<string, number>();

  for (const [index, change] of changes.entries()) {
    const at = `changes.${String(index)}`;
    const kind = kindNamed(change.kind) as Kind;
    const given = (change.fields ?? {}) as Record<string, unknown>;
    const source = sourceOf(change.source);
    if (!source) {
      problem(
        `${at}.source`,
        change.source,
        "No message of the user's in this conversation has these words. Copy the user's own words exactly from the message this change rests on.",
      );
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
          `changes.${String(other)} already changes this ${kind.noun}: make it one change.`,
        );
        continue;
      }
      touched.set(key, index);
      before = await recordOf(trx, kind, where.personId, id);
      const wrong = before
        ? stateProblem(kind, change.action, before)
        : `No ${kind.noun} with this id is in this person's record.`;
      if (wrong) {
        problem(`${at}.id`, id, wrong);
        continue;
      }
    }

    const columns: Row =
      change.action === "remove" || change.action === "restore"
        ? { removed: change.action === "remove" ? 1 : 0 }
        : {};
    for (const [name, value] of Object.entries(given)) {
      const field = kind.fields[name] as Field;
      const path = `${at}.fields.${name}`;
      const said = dateSaid(field, value);
      if (said && !plain(source.text).includes(plain(said.words))) {
        problem(
          `${path}.words`,
          said.words,
          "These words aren't in the source message. Give the user's own words for the date from the message you quote in source, or leave the date out if they didn't say one.",
        );
      }
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
      Object.assign(columns, stored(field, value));
    }

    if (change.action === "add" && kind.asserted) {
      columns.asserted = source.local.slice(0, 10);
    }
    const after: Row = { ...before, ...columns };
    for (const [name, field] of Object.entries(kind.fields)) {
      const date = after[field.column];
      const past =
        typeof field.past === "function" ? field.past(after) : field.past;
      if (past && typeof date === "string" && isAfter(date, source.local)) {
        problem(
          `${at}.fields.${name}.date`,
          date,
          `${shownDate(date)} is after the user said it (${shownDate(source.local)}). Count relative dates from when the message was sent.`,
        );
      }
    }
    planned.push({
      kind,
      action: change.action,
      id: change.id,
      source,
      columns,
      before,
    });
  }
  if (problems.length > 0) {
    throw new SaveRefused(
      "Nothing was saved. Fix these and save again.",
      problems,
    );
  }

  const id = uuid();
  await trx
    .insertInto("operations")
    .values({
      id,
      person_id: where.personId,
      conversation_id: where.conversationId,
      call_id: where.callId,
      request,
      created_at: where.now,
    })
    .execute();
  const written: Written[] = [];
  for (const [index, change] of planned.entries()) {
    const after = await write(trx, where, change);
    written.push({
      kind: change.kind,
      action: change.action,
      before: change.before ?? null,
      after,
    });
    await trx
      .insertInto("record_changes")
      .values({
        operation_id: id,
        seq: index + 1,
        person_id: where.personId,
        kind: change.kind.name,
        record_id: String(after["id"]),
        action: change.action,
        before: change.before ? JSON.stringify(change.before) : null,
        after: JSON.stringify(after),
        source_entry_id: change.source.id,
      })
      .execute();
  }
  if (
    planned.some(
      (c) => c.kind.name === "allergy" || c.kind.name === "none_known",
    )
  ) {
    await checkAllergies(trx, where.personId);
  }
  return {
    id,
    receipt: receiptLine(written),
    fresh: true,
    changes: written.map((w) => ({
      kind: w.kind.name,
      action: w.action,
      id: String(w.after["id"]),
    })),
  };
}

interface Planned {
  kind: Kind;
  action: Action;
  id: string | undefined;
  source: Source;
  columns: Row;
  before: Row | undefined;
}

interface Written {
  kind: Kind;
  action: Action;
  before: Row | null;
  after: Row;
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

/** Why the record can't take this action now. */
function stateProblem(
  kind: Kind,
  action: Action,
  row: Row,
): string | undefined {
  if (kind.name === "result" && row["report_id"] !== null) {
    return "This result was read from a document, so it changes only by amendment: add a new result with replaces set to this id.";
  }
  const removed = row["removed"] === 1;
  if (action === "change" && removed) {
    return `This ${kind.noun} is removed: restore it first.`;
  }
  if (action === "remove" && removed)
    return `This ${kind.noun} is already removed.`;
  if (action === "restore" && !removed)
    return `This ${kind.noun} isn't removed.`;
  return undefined;
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
  const newer = await trx
    .selectFrom("results")
    .select("id")
    .where("person_id", "=", personId)
    .where("replaces_id", "=", id)
    .executeTakeFirst();
  return newer
    ? "That result was already amended: amend the newest version."
    : undefined;
}

/** The date the user said, when the value is one. */
function dateSaid(field: Field, value: unknown): { words: string } | undefined {
  if (field.type !== "date" && field.type !== "due") return undefined;
  return typeof value === "object" && value !== null
    ? (value as { words: string })
    : undefined;
}

/** A field's value as its columns. */
function stored(field: Field, value: unknown): Row {
  switch (field.type) {
    case "value":
      return { [field.column]: value };
    case "boolean":
      return { [field.column]: value === null ? null : value ? 1 : 0 };
    case "due":
    case "date": {
      // A due date is a date, or the next visit.
      if (value === "next_visit") {
        return { [field.column]: value, [wordsColumn(field)]: null };
      }
      const said = value as { date: string; words: string } | null;
      return {
        [field.column]: said?.date ?? null,
        [wordsColumn(field)]: said?.words ?? null,
      };
    }
    case "link": {
      const link = value as { kind: string; id: string } | null;
      return { linked_kind: link?.kind ?? null, linked_id: link?.id ?? null };
    }
  }
}

/** Writes one planned change; returns the record as stored now. */
async function write(
  trx: Transaction<Tables>,
  where: Where,
  change: Planned,
): Promise<Row> {
  const table = sql.table(change.kind.table);
  const columns: Row = { ...change.columns, source_entry_id: change.source.id };
  let id = change.id ?? "";
  if (change.action === "add") {
    id = uuid();
    Object.assign(columns, { id, person_id: where.personId });
    if (change.kind.name === "result") columns["entered_at"] = where.now;
    const names = Object.keys(columns);
    await sql`INSERT INTO ${table} (${sql.join(names.map((name) => sql.ref(name)))}) VALUES (${sql.join(names.map((name) => columns[name]))})`.execute(
      trx,
    );
  } else {
    const sets = Object.entries(columns).map(
      ([name, value]) => sql`${sql.ref(name)} = ${value}`,
    );
    await sql`UPDATE ${table} SET ${sql.join(sets)} WHERE person_id = ${where.personId} AND id = ${id}`.execute(
      trx,
    );
  }
  return (await recordOf(trx, change.kind, where.personId, id)) as Row;
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
  id: string,
): Promise<Saved> {
  const rows = await trx
    .selectFrom("record_changes")
    .select(["kind", "record_id", "action"])
    .where("person_id", "=", personId)
    .where("operation_id", "=", id)
    .orderBy("seq")
    .execute();
  const receipt = await trx
    .selectFrom("transcript_entries")
    .select("text")
    .where("person_id", "=", personId)
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return {
    id,
    receipt: receipt.text,
    fresh: false,
    changes: rows.map((row) => ({
      kind: row.kind,
      action: row.action as Action,
      id: row.record_id,
    })),
  };
}

/** Longest value a receipt shows, in characters. */
const VALUE_MAX = 80;

/** A field of a stored record, as a receipt shows it; undefined when unknown. */
function shownField(field: Field, row: Row): string | undefined {
  const value = row[field.column];
  if (value === null || value === undefined) return undefined;
  let text: string;
  switch (field.type) {
    case "boolean":
      text = value === 1 ? "yes" : "no";
      break;
    case "due":
    case "date": {
      if (value === "next_visit") {
        text = "at the next visit";
        break;
      }
      const words = row[wordsColumn(field)];
      text = `${shownDate(value as string)}${typeof words === "string" ? ` ("${words}")` : ""}`;
      break;
    }
    case "link":
      text = `a ${kindNamed(String(row["linked_kind"]))?.noun ?? "record"}`;
      break;
    case "value":
      text = typeof value === "number" ? String(value) : (value as string);
  }
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/** One line for a save, from the records as written. */
function receiptLine(written: readonly Written[]): string {
  const parts = written.map(({ kind, action, before, after }) => {
    // A statement's label says what it is: "no known allergies (as of …)".
    const name =
      kind.name === "none_known"
        ? kind.label(after)
        : `${kind.noun} ${kind.label(after)}`;
    if (action === "remove") return `removed ${name}`;
    if (action === "restore") return `restored ${name}`;
    const details: string[] = [];
    for (const [key, field] of Object.entries(kind.fields)) {
      const now = shownField(field, after);
      if (action === "add") {
        if (now === undefined || now === "unknown") continue;
        if (kind.inLabel.includes(key)) continue;
        details.push(field.shown === "status" ? now : `${field.shown}: ${now}`);
        continue;
      }
      const then = before ? shownField(field, before) : undefined;
      if (now === then) continue;
      details.push(
        `${field.shown}: ${then ?? "not given"} → ${now ?? "not given"}`,
      );
    }
    const said = details.length > 0 ? ` (${details.join(", ")})` : "";
    return `${action === "add" ? "added" : "changed"} ${name}${said}`;
  });
  return `Saved: ${parts.join("; ")}.`;
}
