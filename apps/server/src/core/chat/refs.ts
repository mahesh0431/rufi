// References in the chat (docs/help/chat.md): a message's chips, each an
// exact pointer to the person's health data: a document, a draft item, a
// saved record or a report (its results). They are checked against the
// chat's person when added (the draft) and when sent, and named and
// versioned from what is stored, never from what the screen sent: a sent
// message keeps each one's version then.
// The AI gets them as a short list after the message and reads them with
// its tools.
import type { Chip, Pointer } from "@rufi/contracts";
import { sql, type Kysely } from "kysely";
import { DELETED_DOCUMENT } from "../documents/naming.ts";
import { shownDate } from "../record/dates.ts";
import { kindNamed, type Kind, type Row } from "../record/kinds.ts";
import { isCurrent, recordVersions } from "../record/read.ts";
import type { Tables } from "../store/tables.ts";

/** A reference that isn't the person's, in words for the person. */
export class RefRefusal extends Error {}

const KIND_WORDS: Record<string, string> = {
  lab_report: "Lab report",
  prescription: "Prescription",
  letter: "Letter",
  other: "Document",
};

const STATUS_WORDS: Record<string, string> = {
  pending: "not saved",
  saved: "saved",
  dismissed: "dismissed",
};

const join = (...parts: (string | null | undefined | false)[]) =>
  parts.filter((part) => typeof part === "string" && part !== "").join(" · ");

/** A document's name: its file, or "3 photos". */
function documentName(files: readonly string[]): string {
  const distinct = [...new Set(files)];
  if (distinct.length <= 1) return distinct[0] ?? "A document";
  return `${String(distinct.length)} photos`;
}

/**
 * The chips of `refs`, named and versioned from what is stored now, each
 * the person's; a pointer that isn't the person's is refused, or with
 * `drop` left out. The same one twice is kept once.
 */
export async function chipsOf(
  db: Kysely<Tables>,
  personId: string,
  refs: readonly Pointer[],
  drop = false,
): Promise<Chip[]> {
  const chips: Chip[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.type}:${ref.type === "record" ? `${ref.kind}:` : ""}${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const chip = await chipOf(db, personId, ref);
    if (!chip) {
      if (drop) continue;
      if (ref.type === "document" && (await deleted(db, personId, ref.id))) {
        throw new RefRefusal(
          "A document added to this message was deleted. Take it out of the message.",
        );
      }
      throw new RefRefusal(
        "Something added to this message isn't in this person's record. Take it out of the message and add it again.",
      );
    }
    chips.push(chip);
  }
  return chips;
}

/** Whether the person's document `id` was deleted. */
const deleted = async (db: Kysely<Tables>, personId: string, id: string) =>
  (await db
    .selectFrom("documents")
    .select("id")
    .where("person_id", "=", personId)
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .executeTakeFirst()) !== undefined;

async function chipOf(
  db: Kysely<Tables>,
  personId: string,
  ref: Pointer,
): Promise<Chip | undefined> {
  const files = async (documentId: string) =>
    (
      await db
        .selectFrom("document_pages")
        .select("file_name")
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .orderBy("position")
        .execute()
    ).map((p) => p.file_name);
  switch (ref.type) {
    case "document": {
      const document = await db
        .selectFrom("documents")
        .select(["id", "kind", "date", "version"])
        .where("person_id", "=", personId)
        .where("id", "=", ref.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!document) return undefined;
      return {
        ref: { ...ref, version: document.version },
        label: documentName(await files(document.id)),
        detail: join(
          document.kind === null
            ? "Document"
            : (KIND_WORDS[document.kind] ?? "Document"),
          document.date !== null && shownDate(document.date),
        ),
      };
    }
    case "draft_item": {
      const item = await db
        .selectFrom("draft_items")
        .select(["document_id", "page", "status", "fields", "version"])
        .where("person_id", "=", personId)
        .where("id", "=", ref.id)
        .executeTakeFirst();
      if (!item) return undefined;
      const fields = JSON.parse(item.fields) as Record<string, unknown>;
      const text = (name: string) =>
        typeof fields[name] === "string" ? fields[name] : undefined;
      return {
        ref: { ...ref, version: item.version },
        label: [text("test_name"), text("value_text"), text("unit")]
          .filter((part) => part !== undefined)
          .join(" "),
        detail: join(
          `Draft item, ${STATUS_WORDS[item.status] ?? item.status}`,
          `${documentName(await files(item.document_id))}, page ${String(item.page)}`,
        ),
      };
    }
    case "record": {
      const kind: Kind | undefined = kindNamed(ref.kind);
      if (!kind) return undefined;
      const { rows } =
        await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND id = ${ref.id}`.execute(
          db,
        );
      const row = rows[0];
      if (!row) return undefined;
      const column = kind.fields[kind.dated]?.column ?? kind.dated;
      const date = row[column];
      const versions = await recordVersions(db, personId, [
        { kind: kind.name, id: ref.id },
      ]);
      return {
        ref: {
          ...ref,
          version: versions.get(`${kind.name}:${ref.id}`) ?? null,
        },
        label: join(
          kind.label(row),
          typeof date === "string" &&
            date !== "next_visit" &&
            shownDate(date.slice(0, 10)),
        ),
        detail: join(
          `${nounOf(kind, row)} in your health record`,
          row["removed"] === 1 && "removed",
        ),
      };
    }
    case "report": {
      const report = await db
        .selectFrom("reports")
        .select(["issuer", "collected"])
        .where("person_id", "=", personId)
        .where("id", "=", ref.id)
        .executeTakeFirst();
      if (!report) return undefined;
      const result = kindNamed("result") as Kind;
      const current = await db
        .selectFrom("results as r")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("r.person_id", "=", personId)
        .where("r.report_id", "=", ref.id)
        .where(isCurrent(result, "r"))
        .executeTakeFirstOrThrow();
      // The last save that changed any of its results (also one taken out),
      // or a result that replaces one of them: a replacement can be typed or
      // belong to another report, and still decides what is current here.
      const last = await db
        .selectFrom("record_changes as c")
        .innerJoin("operations as o", (on) =>
          on
            .onRef("o.person_id", "=", "c.person_id")
            .onRef("o.id", "=", "c.operation_id"),
        )
        .innerJoin("results as r", (on) =>
          on
            .onRef("r.person_id", "=", "c.person_id")
            .onRef("r.id", "=", "c.record_id"),
        )
        .leftJoin("results as predecessor", (on) =>
          on
            .onRef("predecessor.person_id", "=", "r.person_id")
            .onRef("predecessor.id", "=", "r.replaces_id"),
        )
        .select("c.operation_id")
        .where("c.person_id", "=", personId)
        .where("c.kind", "=", "result")
        .where((eb) =>
          eb.or([
            eb("r.report_id", "=", ref.id),
            eb("predecessor.report_id", "=", ref.id),
          ]),
        )
        .orderBy("o.seq", "desc")
        .limit(1)
        .executeTakeFirst();
      const count = current.n;
      return {
        ref: { ...ref, version: last?.operation_id ?? null },
        label: join(
          report.issuer ?? "Report",
          report.collected !== null && shownDate(report.collected),
          `${String(count)} ${count === 1 ? "result" : "results"}`,
        ),
        detail: "Report in your health record",
      };
    }
  }
}

/** What a record is called on its chip: a result by its category. */
function nounOf(kind: Kind, row: Row): string {
  if (kind.name === "result") {
    return row["category"] === "measurement" ? "Measurement" : "Lab result";
  }
  return `${kind.noun.charAt(0).toUpperCase()}${kind.noun.slice(1)}`;
}

/**
 * The references as the AI gets them after the message: what each is, its
 * id and version, and its name, so it reads exactly those with its tools.
 */
export function refsForAi(chips: readonly Chip[]): string | undefined {
  if (chips.length === 0) return undefined;
  const lines = chips.map(({ ref, label, deleted }) => {
    if (deleted) {
      return `- ${ref.type === "document" ? "document" : "draft item"} ${ref.id}: ${label} (its document was deleted. ${DELETED_DOCUMENT})`;
    }
    switch (ref.type) {
      case "document":
        return `- document ${ref.id}, version ${String(ref.version)}: ${label}`;
      case "draft_item":
        return `- draft item ${ref.id}, version ${String(ref.version)}: ${label}`;
      case "record":
        return `- ${kindNamed(ref.kind)?.noun ?? ref.kind} ${ref.id} (kind ${ref.kind}), version ${ref.version === null ? "null" : ref.version}: ${label}`;
      case "report":
        return `- report ${ref.id}, version ${ref.version === null ? "null" : ref.version}: ${label}`;
    }
  });
  return `References the user added to this message (Rufi's, exact: read them with your tools):\n${lines.join("\n")}`;
}
