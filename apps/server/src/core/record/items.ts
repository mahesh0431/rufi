// Saving a document's draft items into the record (docs/adr/0005). The AI
// names each item, the version it read, how it goes in (a new result,
// another source for a result the person has, or a correction of one) and
// any fix the user gave in the chat; Rufi takes the values from the stored
// item, never retyped by the AI. Code checks whose it is, versions, the
// item's state and the date; the AI decides with the user what each item is.
import type { Ref } from "@rufi/contracts";
import { Schema } from "effect";
import type { Transaction } from "kysely";
import { v7 as uuidv7 } from "uuid";
import type { Entry } from "../documents/notebook.ts";
import type { Tables } from "../store/tables.ts";
import { dateProblem, isAfter, localTime, shownDate } from "./dates.ts";
import {
  columnsOf,
  kindNamed,
  literal,
  type Field,
  type Kind,
  type Row,
} from "./kinds.ts";
import { recordVersions } from "./read.ts";
import type { Planned, Source } from "./save.ts";

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

const result = kindNamed("result") as Kind;

/** The result fields a user's fix may give: what is printed, and the date. */
const FIXABLE = [
  "test",
  "value",
  "comparator",
  "number",
  "unit",
  "range",
  "flag",
  "context",
  "measured",
] as const;

const fixFields = Schema.Struct(
  Object.fromEntries(
    FIXABLE.map((name) => {
      const field = result.fields[name] as Field;
      return [
        name,
        Schema.optionalKey(
          field.required ? field.input : Schema.NullOr(field.input),
        ),
      ];
    }),
  ),
);

/** One draft item to save, as the AI gives it. */
export const ItemSave = Schema.Struct({
  item: Id.annotate({
    description: "The draft item's id, from get_documents.",
  }),
  version: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "The item's version as you read it with get_documents.",
  }),
  as: Schema.Literals(["new", "another_source", "correction"]).annotate({
    description:
      "new: a result the user doesn't have yet. another_source: the same result is already saved (from the user's message or another document): its values stay, and this document's page becomes another source. correction: the item corrects a saved result: a new result replaces it.",
  }),
  record: Schema.optionalKey(
    Schema.Struct({
      id: Id.annotate({
        description: "The saved result's id, from get_records.",
      }),
      version: Schema.NullOr(Id).annotate({
        description: "The saved result's version, as get_records gave it.",
      }),
    }).annotate({
      description:
        "For another_source and correction: the saved result it is another source for, or corrects.",
    }),
  ),
  fix: Schema.optionalKey(
    Schema.Struct({
      source: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(1_000),
      ).annotate({
        description:
          "The user's own words that give the fix, copied exactly from their message in this chat.",
      }),
      fields: fixFields.annotate({
        description:
          "Only the fields the user corrected; the rest come from the item as stored. measured needs the user's own words for the date.",
      }),
    }).annotate({
      description:
        "Only when the user said a value of this item is different from what was read (a misread digit, the right date): the fields they gave. Never for another_source.",
    }),
  ),
});
export type ItemSave = typeof ItemSave.Type;

/** An item saved before, at the version the AI named: its earlier save. */
export interface Earlier {
  item: string;
  as: string;
  record: string;
  save: string;
}

/** The fields of a draft item: a result as printed. */
type Fields = Omit<Entry["items"][number], "unsure">;
type Facts = NonNullable<Entry["facts"]>;

/** A page's report: the lab, report number and collection date it prints. */
interface ReportKey {
  issuer: string | null;
  number: string | null;
  collected: string | null;
  /** The date the page prints first, as printed, with its label. */
  date: { label: string; date: string; iso?: string } | undefined;
}

/**
 * Each page's report, in page order: what it prints, or, for a page that
 * prints no lab, number or date (a table that goes on), the page before's.
 */
function reportsOf(
  pages: readonly { position: number; entry: string | null }[],
): Map<number, ReportKey> {
  const keys = new Map<number, ReportKey>();
  let last: ReportKey | undefined;
  for (const page of pages) {
    const facts: Facts | undefined = page.entry
      ? (JSON.parse(page.entry) as Entry).facts
      : undefined;
    const date = facts?.dates?.[0];
    const own = {
      issuer: facts?.issuer ?? null,
      number: facts?.report_number ?? null,
      collected: date?.iso ?? null,
      date,
    };
    if (own.issuer !== null || own.number !== null || own.date !== undefined) {
      last = own;
    }
    keys.set(
      page.position,
      last ?? { issuer: null, number: null, collected: null, date: undefined },
    );
  }
  return keys;
}

interface Context {
  personId: string;
  /** Now, as an ISO time. */
  now: string;
  /** The user's message with these words, if any. */
  messageWith: (words: string) => Source | undefined;
  /** Whether a message has these words. */
  says: (source: Source, words: string) => boolean;
  /** The references of the user's messages in this turn. */
  refs: readonly Ref[];
  problem: (path: string, got: unknown, fix: string) => void;
  /** Records the save already changes, "kind:id", and where. */
  touched: Map<string, string>;
}

/**
 * Checks each item and plans its write; problems go to `problem`. Items
 * saved before at the named version aren't planned: they come back as
 * `earlier`.
 */
export async function planItems(
  trx: Transaction<Tables>,
  context: Context,
  items: readonly ItemSave[],
): Promise<{ planned: Planned[]; earlier: Earlier[] }> {
  const { personId, problem } = context;
  const planned: Planned[] = [];
  const earlier: Earlier[] = [];
  const rows = await trx
    .selectFrom("draft_items")
    .selectAll()
    .where("person_id", "=", personId)
    .where(
      "id",
      "in",
      items.map((i) => i.item),
    )
    .execute();
  const documentIds = [...new Set(rows.map((r) => r.document_id))];
  const documents = new Map(
    (documentIds.length === 0
      ? []
      : await trx
          .selectFrom("documents")
          .select(["id", "version"])
          .where("person_id", "=", personId)
          .where("id", "in", documentIds)
          .execute()
    ).map((d) => [d.id, d.version]),
  );
  const pages =
    documentIds.length === 0
      ? []
      : await trx
          .selectFrom("document_pages")
          .select(["document_id", "position", "entry", "file_name"])
          .where("person_id", "=", personId)
          .where("document_id", "in", documentIds)
          .orderBy("document_id")
          .orderBy("position")
          .execute();
  const reports = new Map(
    documentIds.map((id) => [
      id,
      reportsOf(pages.filter((p) => p.document_id === id)),
    ]),
  );
  const named = (document: string, page: number) =>
    pages.find((p) => p.document_id === document && p.position === page)
      ?.file_name ?? "a document";

  const targets = items.flatMap((i) =>
    i.record ? [{ kind: "result", id: i.record.id }] : [],
  );
  const versions = await recordVersions(trx, personId, targets);
  const seen = new Map<string, number>();
  const asked = (type: Ref["type"], id: string) =>
    context.refs.filter((ref) => ref.type === type && ref.id === id);

  for (const [index, save] of items.entries()) {
    const at = `items.${String(index)}`;
    const row = rows.find((r) => r.id === save.item);
    if (!row) {
      problem(
        `${at}.item`,
        save.item,
        "No draft item with this id is this person's. Read the document with get_documents for its items.",
      );
      continue;
    }
    const twice = seen.get(row.id);
    if (twice !== undefined) {
      problem(
        `${at}.item`,
        save.item,
        `items.${String(twice)} already saves this item: name each item once.`,
      );
      continue;
    }
    seen.set(row.id, index);
    if (row.status === "dismissed") {
      problem(
        `${at}.item`,
        save.item,
        "This item was dismissed, so it is never saved. Say so to the user.",
      );
      continue;
    }
    if (save.version !== row.version) {
      problem(
        `${at}.version`,
        save.version,
        `This item changed since you read it: it is at version ${String(row.version)} now. Read it again with get_documents, tell the user what changed and ask again.`,
      );
      continue;
    }
    if (row.status === "saved") {
      earlier.push({
        item: row.id,
        as: row.saved_as ?? "new",
        record: row.record_id ?? "",
        save: row.operation_id ?? "",
      });
      continue;
    }
    // What the user pointed at in this turn's message must still be so.
    const document = documents.get(row.document_id) ?? 0;
    if (
      asked("document", row.document_id).some((r) => r.version !== document)
    ) {
      problem(
        `${at}.item`,
        save.item,
        "The document changed since the user's message (a reading or a fix): read it again with get_documents, tell the user what changed and ask again.",
      );
      continue;
    }
    if (asked("draft_item", row.id).some((r) => r.version !== row.version)) {
      problem(
        `${at}.version`,
        save.version,
        "This item changed since the user pointed at it: read it again, tell the user what changed and ask again.",
      );
      continue;
    }

    const fields = JSON.parse(row.fields) as Fields;
    const page = {
      document: row.document_id,
      page: row.page,
      name: named(row.document_id, row.page),
    };
    const report = reports.get(row.document_id)?.get(row.page);

    let before: Row | undefined;
    if (save.as === "new") {
      if (save.record !== undefined) {
        problem(
          `${at}.record`,
          save.record,
          "A new result names no saved one: leave record out, or save it as another_source or a correction.",
        );
        continue;
      }
    } else {
      if (save.record === undefined) {
        problem(
          `${at}.record`,
          undefined,
          `Name the saved result this item is ${save.as === "correction" ? "a correction of" : "another source for"}, with its id and version from get_records.`,
        );
        continue;
      }
      const target = save.record;
      before = await trx
        .selectFrom("results")
        .selectAll()
        .where("person_id", "=", personId)
        .where("id", "=", target.id)
        .executeTakeFirst();
      const current = versions.get(`result:${target.id}`) ?? null;
      const pointed = context.refs.filter(
        (r) => r.type === "record" && r.id === target.id,
      );
      const wrong = !before
        ? "No result with this id is in this person's record."
        : before["removed"] === 1
          ? "That result is removed."
          : target.version !== current
            ? `That result changed since you read it: its version is ${current === null ? "null" : `"${current}"`} now. Read it again with get_records, tell the user what changed and ask again.`
            : pointed.some((r) => r.version !== current)
              ? "That result changed since the user pointed at it: read it again, tell the user what changed and ask again."
              : undefined;
      if (wrong) {
        problem(`${at}.record`, target, wrong);
        continue;
      }
      const key = `result:${target.id}`;
      const other = context.touched.get(key);
      if (other !== undefined) {
        problem(
          `${at}.record`,
          target,
          `${other} already changes this result: make it one change.`,
        );
        continue;
      }
      context.touched.set(key, at);
      if (save.as === "another_source") {
        if (save.fix !== undefined) {
          problem(
            `${at}.fix`,
            save.fix,
            "Another source keeps the saved result's values. If the user corrected a value, save the item as a correction instead.",
          );
          continue;
        }
        planned.push({
          kind: result,
          action: "link",
          id: target.id,
          source: undefined,
          page,
          columns: {},
          before,
          item: { id: row.id, as: save.as },
        });
        continue;
      }
    }

    // A new result, or one that replaces the corrected one: the item's
    // values, then the user's fix.
    let source: Source | undefined;
    const columns: Row = {
      test_name: fields.test_name,
      value_text: fields.value_text,
      comparator: fields.comparator ?? null,
      value_number: fields.value_number ?? null,
      unit: fields.unit ?? null,
      reference_range: fields.reference_range ?? null,
      flag_text: fields.flag_text ?? null,
      context_text: fields.context_text ?? null,
    };
    // Its date: its own, else (in the current column) its report's first
    // printed date: the collection date when one is printed.
    const date =
      fields.date ?? (fields.column === "earlier" ? undefined : report?.date);
    if (date?.iso !== undefined && dateProblem(date.iso) === undefined) {
      columns["measured_at"] = date.iso;
      columns["measured_words"] = `${date.label} ${date.date}`;
    }
    if (save.fix !== undefined) {
      source = context.messageWith(save.fix.source);
      if (!source) {
        problem(
          `${at}.fix.source`,
          save.fix.source,
          "No message of the user's in this chat has these words. Copy the user's own words exactly from the message that gives the fix.",
        );
        continue;
      }
      for (const [name, value] of Object.entries(save.fix.fields)) {
        const field = result.fields[name] as Field;
        const said =
          field.type === "date" ? (value as { words: string } | null) : null;
        if (said && !context.says(source, said.words)) {
          problem(
            `${at}.fix.fields.${name}.words`,
            said.words,
            "These words aren't in the fix's source message. Give the user's own words for the date.",
          );
        }
        Object.assign(columns, columnsOf(field, value));
      }
    }
    const measured = columns["measured_at"];
    if (typeof measured !== "string") {
      problem(
        `${at}.item`,
        save.item,
        `This item has no date Rufi can store (${date ? `"${date.label} ${date.date}": the order of day and month isn't certain` : "none is printed for it"}). Ask the user when the sample was taken, and give it in fix.fields.measured with their words.`,
      );
      continue;
    }
    const anchor = source?.local ?? localTime(context.now);
    if (isAfter(measured, anchor)) {
      problem(
        `${at}.item`,
        save.item,
        `Its date ${shownDate(measured)} is later than now: ask the user for the right date.`,
      );
      continue;
    }
    if (save.as === "correction" && save.record) {
      columns["replaces_id"] = save.record.id;
    }
    planned.push({
      kind: result,
      action: "add",
      id: undefined,
      source,
      page,
      columns,
      before: undefined,
      item: { id: row.id, as: save.as },
      report: {
        document: row.document_id,
        issuer: report?.issuer ?? null,
        number: report?.number ?? null,
        collected: report?.collected ?? null,
      },
    });
  }
  return { planned, earlier };
}

/** dismiss_items' input. */
export const DismissInput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      item: Id.annotate({
        description: "The draft item's id, from get_documents.",
      }),
      version: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: "The item's version as you read it.",
      }),
    }),
  ).check(Schema.isMinLength(1)),
});
export type DismissInput = typeof DismissInput.Type;

export interface Dismissed {
  /** The receipt's id; empty when nothing new was dismissed. */
  id: string;
  receipt: string;
  fresh: boolean;
  dismissed: string[];
  /** Items dismissed before. */
  already: string[];
}

/** A dismissal Rufi refused; nothing of it was written. */
export class DismissRefused extends Error {
  readonly problems: { path: string; got: string; fix: string }[];
  constructor(problems: DismissRefused["problems"]) {
    super("Nothing was dismissed. Fix these and try again.");
    this.problems = problems;
  }
}

/**
 * Dismisses draft items the user doesn't want saved: each final, its
 * version raised, with a receipt line; all or nothing. The document's
 * version stays: a dismissed item is refused by its own state, and "save
 * the rest" in the same turn still matches the message. One already
 * dismissed is left as it is. A saved item can't be: its record is removed
 * with save_changes instead.
 */
export async function dismissItems(
  trx: Transaction<Tables>,
  where: { personId: string; callId: string; refs: readonly Ref[] },
  input: DismissInput,
): Promise<Dismissed> {
  const problems: DismissRefused["problems"] = [];
  const rows = await trx
    .selectFrom("draft_items as d")
    .innerJoin("document_pages as p", (join) =>
      join
        .onRef("p.person_id", "=", "d.person_id")
        .onRef("p.document_id", "=", "d.document_id")
        .onRef("p.position", "=", "d.page"),
    )
    .innerJoin("documents as doc", (join) =>
      join
        .onRef("doc.person_id", "=", "d.person_id")
        .onRef("doc.id", "=", "d.document_id"),
    )
    .select([
      "d.id",
      "d.document_id",
      "d.page",
      "d.version",
      "d.status",
      "d.fields",
      "p.file_name",
      "doc.version as document_version",
    ])
    .where("d.person_id", "=", where.personId)
    .where(
      "d.id",
      "in",
      input.items.map((i) => i.item),
    )
    .execute();
  const now: typeof rows = [];
  const already: string[] = [];
  for (const [index, asked] of input.items.entries()) {
    const at = `items.${String(index)}`;
    const row = rows.find((r) => r.id === asked.item);
    const problem = (fix: string) =>
      problems.push({ path: at, got: JSON.stringify(asked), fix });
    if (!row) {
      problem(
        "No draft item with this id is this person's. Read the document with get_documents for its items.",
      );
      continue;
    }
    if (row.status === "dismissed") {
      already.push(row.id);
      continue;
    }
    if (now.includes(row)) {
      problem("This item is named twice: name each item once.");
      continue;
    }
    if (row.status === "saved") {
      problem(
        "This item is saved in the record. To take it out, remove its record with save_changes, after the user says yes.",
      );
      continue;
    }
    const pointed = where.refs.filter(
      (r) =>
        (r.type === "draft_item" &&
          r.id === row.id &&
          r.version !== row.version) ||
        (r.type === "document" &&
          r.id === row.document_id &&
          r.version !== row.document_version),
    );
    if (asked.version !== row.version || pointed.length > 0) {
      problem(
        `This item changed since ${pointed.length > 0 ? "the user pointed at it" : "you read it"}: it is at version ${String(row.version)} now. Read it again, tell the user what changed and ask again.`,
      );
      continue;
    }
    now.push(row);
  }
  if (problems.length > 0) throw new DismissRefused(problems);
  if (now.length === 0) {
    return { id: "", receipt: "", fresh: false, dismissed: [], already };
  }
  for (const row of now) {
    await trx
      .updateTable("draft_items")
      .set((eb) => ({
        status: "dismissed",
        version: eb("version", "+", 1),
        dismissed_by: where.callId,
      }))
      .where("person_id", "=", where.personId)
      .where("id", "=", row.id)
      .execute();
  }
  const names = [...new Set(now.map((r) => r.file_name))];
  const lines = now.map((row) => {
    const fields = JSON.parse(row.fields) as Fields;
    const label = [fields.test_name, fields.value_text, fields.unit]
      .filter((part) => part !== undefined)
      .join(" ");
    const where =
      names.length === 1
        ? `page ${String(row.page)}`
        : `${row.file_name}, page ${String(row.page)}`;
    return `- **${literal(label)}** · ${literal(where)}`;
  });
  const from =
    names.length === 1
      ? literal(names[0] ?? "")
      : `${String(names.length)} documents`;
  return {
    id: uuidv7(),
    receipt: `**Dismissed** ${now.length === 1 ? "1 item" : `${String(now.length)} items`} from ${from}: not saved\n\n${lines.join("\n")}`,
    fresh: true,
    dismissed: now.map((r) => r.id),
    already,
  };
}
