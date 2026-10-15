// A document's draft items as the document page shows them, and the person's
// fixes. A fix changes the item's fields only: the reader's fields stay as
// they came (original), the item's version rises, and so does the
// document's. It names the version it was made on, so a fix from a tab that
// holds an older version is refused with the item as it is now. Saved and
// dismissed items can't be fixed. Nothing here writes the record.
import type {
  DocumentItems,
  DraftItem,
  Fixable,
  FixItem,
} from "@rufi/contracts/documents";
import type { Store } from "../store/database.ts";
import { Refusal } from "../tools/registry.ts";
import type { Checks } from "./notebook.ts";

/** A fix made on an older version: the item as it is now. */
export class StaleFix extends Error {
  readonly current: DraftItem;
  constructor(current: DraftItem) {
    super("This result changed in another tab. Your fix wasn't saved.");
    this.current = current;
  }
}

type Fields = DraftItem["fields"];

/** The fields every lab result has: a fix can't empty them. */
const REQUIRED: readonly Fixable[] = ["test_name", "value_text"];

/**
 * A plain printed number ("5.8", "-2", "<5", ">= 10") as its comparator and
 * number; anything else ("4,6", "Negative", "1,200") has none.
 */
function plainNumber(
  value: string,
): Pick<Fields, "comparator" | "value_number"> {
  const found = /^(<=|>=|<|>)?\s*(-?\d+(?:\.\d+)?)$/.exec(value);
  if (!found?.[2]) return {};
  return {
    ...(found[1] && { comparator: found[1] }),
    value_number: Number(found[2]),
  };
}

const itemOf = (row: {
  id: string;
  version: number;
  page: number;
  status: string;
  fields: string;
  original: string;
  unsure: string;
}): DraftItem => {
  const { unsure: _reader, ...original } = JSON.parse(
    row.original,
  ) as Fields & {
    unsure?: string;
  };
  return {
    id: row.id,
    version: row.version,
    page: row.page,
    status: row.status as DraftItem["status"],
    fields: JSON.parse(row.fields) as Fields,
    original,
    unsure: JSON.parse(row.unsure) as string[],
  };
};

export function draftItems(
  store: Store,
  /** Tells the person's screens that their documents changed. */
  changed: (personId: string) => void,
) {
  const db = store.query;
  const columns = [
    "id",
    "version",
    "page",
    "status",
    "fields",
    "original",
    "unsure",
  ] as const;

  return {
    /** The person's document's pages and draft items; undefined when it isn't theirs. */
    view: async (
      personId: string,
      documentId: string,
    ): Promise<DocumentItems | undefined> => {
      const pages = await db
        .selectFrom("document_pages as p")
        .innerJoin("documents as d", (join) =>
          join
            .onRef("d.person_id", "=", "p.person_id")
            .onRef("d.id", "=", "p.document_id"),
        )
        .select(["p.position", "p.state", "p.state_why", "p.entry_checks"])
        .where("p.person_id", "=", personId)
        .where("p.document_id", "=", documentId)
        .where("d.deleted_at", "is", null)
        .orderBy("p.position")
        .execute();
      if (pages.length === 0) return undefined;
      const items = await db
        .selectFrom("draft_items")
        .select(columns)
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .orderBy("page")
        .orderBy("seq")
        .orderBy("created_at")
        .execute();
      return {
        pages: pages.map((p) => ({
          position: p.position,
          state: p.state as DocumentItems["pages"][number]["state"],
          why: p.state_why,
          // Only a page whose reading ended says what its checks found
          // (an older Rufi's; new entries have none).
          incomplete:
            p.state !== null && p.entry_checks
              ? ((JSON.parse(p.entry_checks) as Checks).incomplete ?? null)
              : null,
        })),
        items: items.map(itemOf),
      };
    },

    /**
     * The person's fix of one item, made on `version`: the changed fields,
     * an empty optional field left out. Refused when the item isn't pending
     * (Refusal) or its version is newer (StaleFix); undefined when there is
     * no such item of theirs.
     */
    fix: async (
      personId: string,
      documentId: string,
      itemId: string,
      fix: FixItem,
    ): Promise<DraftItem | undefined> => {
      const done = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("draft_items")
          .select(columns)
          .where("person_id", "=", personId)
          .where("document_id", "=", documentId)
          .where("id", "=", itemId)
          .executeTakeFirst();
        if (!row) return undefined;
        const item = itemOf(row);
        if (item.status !== "pending") {
          throw new Refusal(
            `This result is already ${item.status === "saved" ? "saved" : "dismissed"}, so it can't be fixed here.`,
          );
        }
        if (item.version !== fix.version) throw new StaleFix(item);
        const given = new Map(
          Object.entries(fix.fields).map(([field, value]) => [
            field as Fixable,
            value.trim(),
          ]),
        );
        if (REQUIRED.some((field) => given.get(field) === "")) {
          throw new Refusal("A result needs its test name and value.");
        }
        if (
          [...given].every(
            ([field, value]) => (item.fields[field] ?? "") === value,
          )
        ) {
          return { item, changed: false };
        }
        // The number goes with the printed value: made again from a plain
        // number, left out otherwise. The reader's stays in its original.
        const value = given.get("value_text");
        const renumber =
          value !== undefined && value !== item.fields.value_text;
        const fields = {
          ...Object.fromEntries(
            Object.entries(item.fields).filter(
              ([field]) =>
                !given.has(field as Fixable) &&
                !(
                  renumber &&
                  (field === "comparator" || field === "value_number")
                ),
            ),
          ),
          ...Object.fromEntries([...given].filter(([, text]) => text !== "")),
          ...(renumber && plainNumber(value)),
        } as Fields;
        await trx
          .updateTable("draft_items")
          .set({ fields: JSON.stringify(fields), version: item.version + 1 })
          .where("person_id", "=", personId)
          .where("id", "=", itemId)
          .where("version", "=", item.version)
          .execute();
        await trx
          .updateTable("documents")
          .set((eb) => ({ version: eb("version", "+", 1) }))
          .where("person_id", "=", personId)
          .where("id", "=", documentId)
          .execute();
        return {
          item: {
            ...item,
            fields,
            version: item.version + 1,
          },
          changed: true,
        };
      });
      if (done?.changed) changed(personId);
      return done?.item;
    },
  };
}

export type DraftItems = ReturnType<typeof draftItems>;
