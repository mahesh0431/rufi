// Deleting a document (docs/adr/0015): a screen action, like adding one.
// Its original, its pages' images and text, the reader's work, its readings
// and its draft items go; its row and its pages' names and positions stay as
// a tombstone, so the history, the sources and the chat that point at it
// still read and say "document deleted". The record never changes here:
// while a saved record that isn't removed rests on one of its pages, the
// delete is refused, and the person fixes that in the chat (ADR 0005).
// The database part is one transaction with its Rufi event; the bytes go
// after the commit, under the file gate, and the next start removes what a
// crash left between the two.
import { createHash } from "node:crypto";
import type { DeletePreview } from "@rufi/contracts/documents";
import { sql, type Kysely, type Transaction } from "kysely";
import { shownDate } from "../record/dates.ts";
import { kindNamed, type Row } from "../record/kinds.ts";
import { errorCode, type Log } from "../../platform/logs.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { Refusal } from "../tools/registry.ts";
import type { FileGate } from "./gate.ts";
import { removeBytes, sweepBytes } from "./originals.ts";
import { documentName } from "./reading.ts";

type Db = Kysely<Tables> | Transaction<Tables>;

/** A delete refused because what its preview showed has changed; `preview` is now. */
export class StalePreview extends Error {
  readonly preview: DeletePreview;
  constructor(preview: DeletePreview) {
    super("Something changed since you opened this. Nothing was deleted.");
    this.preview = preview;
  }
}

/** What the delete writes its Rufi event with: the chat's own (server/chat.ts). */
export type WriteEvent = (
  personId: string,
  event: { kind: string; line: string; facts?: unknown },
  write: (trx: Transaction<Tables>, revision: number) => Promise<string[]>,
) => Promise<void>;

/** The person's live document `documentId`, or undefined. */
const liveDocument = (db: Db, personId: string, documentId: string) =>
  db
    .selectFrom("documents")
    .select(["id", "version"])
    .where("person_id", "=", personId)
    .where("id", "=", documentId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

/**
 * The saved records, of any kind, that aren't removed and rest on a page of
 * the document by a source no save took off: current or replaced, both.
 */
async function blockingOf(db: Db, personId: string, documentId: string) {
  const sources = await db
    .selectFrom("record_sources")
    .select(["kind", "record_id"])
    .distinct()
    .where("person_id", "=", personId)
    .where("type", "=", "document_page")
    .where("document_id", "=", documentId)
    .where("removed_by", "is", null)
    .orderBy("kind")
    .orderBy("record_id")
    .execute();
  const blocking: DeletePreview["blocking"][number][] = [];
  for (const { kind: name, record_id: id } of sources) {
    const kind = kindNamed(name);
    if (!kind) continue;
    const { rows } =
      await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND id = ${id}`.execute(
        db,
      );
    const row = rows[0];
    if (!row || row["removed"] !== 0) continue;
    const column = kind.fields[kind.dated]?.column ?? kind.dated;
    const date = row[column];
    const replaced =
      kind.name === "result" &&
      (await db
        .selectFrom("results")
        .select("id")
        .where("person_id", "=", personId)
        .where("replaces_id", "=", id)
        .where("removed", "=", 0)
        .executeTakeFirst()) !== undefined;
    blocking.push({
      kind: kind.name,
      id,
      label: kind.label(row),
      date:
        typeof date === "string" && date !== "next_visit"
          ? shownDate(date.slice(0, 10))
          : null,
      replaced,
    });
  }
  return blocking;
}

/** What deleting the document would do now; undefined when it isn't there. */
async function previewIn(
  db: Db,
  personId: string,
  documentId: string,
): Promise<DeletePreview | undefined> {
  const document = await liveDocument(db, personId, documentId);
  if (!document) return undefined;
  const pages = await db
    .selectFrom("document_pages")
    .select(["file_id", "file_name"])
    .where("person_id", "=", personId)
    .where("document_id", "=", documentId)
    .orderBy("position")
    .execute();
  const files: { id: string | null; name: string; pages: number }[] = [];
  for (const page of pages) {
    const last = files.at(-1);
    if (last?.id === page.file_id) last.pages++;
    else files.push({ id: page.file_id, name: page.file_name, pages: 1 });
  }
  const { readings } = await db
    .selectFrom("jobs")
    .select((eb) => eb.fn.countAll<number>().as("readings"))
    .where("person_id", "=", personId)
    .where("document_id", "=", documentId)
    .where("state", "in", ["queued", "running"])
    .executeTakeFirstOrThrow();
  const { unsaved } = await db
    .selectFrom("draft_items")
    .select((eb) => eb.fn.countAll<number>().as("unsaved"))
    .where("person_id", "=", personId)
    .where("document_id", "=", documentId)
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  const blocking = await blockingOf(db, personId, documentId);
  const shown = {
    name: documentName(pages.map((p) => p.file_name)),
    files: files.map(({ name, pages }) => ({ name, pages })),
    readings,
    unsaved,
    blocking,
  };
  // What the person agrees to: not a reading's progress, which moves on
  // while they look.
  const version = createHash("sha256")
    .update(JSON.stringify([document.version, shown]))
    .digest("hex")
    .slice(0, 16);
  return { ...shown, version };
}

/**
 * Marks the chips of the document and of its draft items as deleted, in
 * the messages sent and the ones waiting, and takes the way to the
 * document off its reading lines. Returns the transcript entries changed.
 */
async function markDeleted(
  trx: Transaction<Tables>,
  personId: string,
  documentId: string,
  itemIds: readonly string[],
  revision: number,
  at: string,
): Promise<string[]> {
  const ids = JSON.stringify([documentId, ...itemIds]);
  type Chip = { ref: { type: string; id: string }; deleted?: true };
  const mark = (refs: string) => {
    const chips = JSON.parse(refs) as Chip[];
    return JSON.stringify(
      chips.map((chip) =>
        (chip.ref.type === "document" && chip.ref.id === documentId) ||
        (chip.ref.type === "draft_item" && itemIds.includes(chip.ref.id))
          ? { ...chip, deleted: true }
          : chip,
      ),
    );
  };
  const pointing = sql<boolean>`EXISTS (SELECT 1 FROM json_each(refs) WHERE json_extract(value, '$.ref.id') IN (SELECT value FROM json_each(${ids})))`;
  const sent = await trx
    .selectFrom("transcript_entries")
    .select(["id", "refs"])
    .where("person_id", "=", personId)
    .where("refs", "is not", null)
    .where(pointing)
    .execute();
  for (const { id, refs } of sent) {
    await trx
      .updateTable("transcript_entries")
      .set({ refs: mark(refs ?? "[]"), revision, updated_at: at })
      .where("id", "=", id)
      .execute();
  }
  const waiting = await trx
    .selectFrom("chat_queue")
    .select(["id", "refs"])
    .where("person_id", "=", personId)
    .where(pointing)
    .execute();
  for (const { id, refs } of waiting) {
    await trx
      .updateTable("chat_queue")
      .set({ refs: mark(refs), updated_at: at })
      .where("id", "=", id)
      .execute();
  }
  const events = await trx
    .selectFrom("transcript_entries")
    .select(["id", "details"])
    .where("person_id", "=", personId)
    .where("kind", "=", "event")
    .where(
      sql<boolean>`json_extract(details, '$.facts.document') = ${documentId}`,
    )
    .execute();
  for (const { id, details } of events) {
    const parsed = JSON.parse(details ?? "{}") as { facts?: object };
    await trx
      .updateTable("transcript_entries")
      .set({
        details: JSON.stringify({
          ...parsed,
          facts: { ...parsed.facts, deleted: true },
        }),
        revision,
        updated_at: at,
      })
      .where("id", "=", id)
      .execute();
  }
  return [...sent, ...events].map((e) => e.id);
}

export function deletions(deps: {
  store: Store;
  home: string;
  gate: FileGate;
  /** Writes the delete's Rufi event, with the delete, in one transaction. */
  event: WriteEvent;
  /** Stops the reader's run when it reads this document. */
  stopReading: (documentId: string) => void;
  /** Tells the person's screens their documents changed. */
  changed: (personId: string) => void;
  log: Log;
  now?: () => string;
}) {
  const db = deps.store.query;
  const now = deps.now ?? (() => new Date().toISOString());

  /** Removes the bytes of files no live page uses, under the gate. */
  const removeUnused = (ids: readonly string[]) =>
    deps.gate.run(async () => {
      for (const id of ids) {
        // A page added meanwhile (the same file again) keeps it.
        const live = await db
          .selectFrom("files")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (!live) await removeBytes(deps.home, id);
      }
    });

  return {
    preview: async (personId: string, documentId: string) =>
      previewIn(db, personId, documentId),

    /**
     * Deletes the document, when the preview `version` is still what is
     * true and nothing saved rests on it; otherwise StalePreview, with
     * nothing changed. Refusal when there is no such document.
     */
    remove: async (personId: string, documentId: string, version: string) => {
      const before = await previewIn(db, personId, documentId);
      if (!before) throw new Refusal("There is no such document.");
      let files: string[] = [];
      await deps.event(
        personId,
        {
          kind: "document_deleted",
          line: `Deleted ${before.name}`,
          facts: { deleted: documentId },
        },
        async (trx, revision) => {
          const found = await previewIn(trx, personId, documentId);
          if (!found) throw new Refusal("There is no such document.");
          if (found.version !== version || found.blocking.length > 0) {
            throw new StalePreview(found);
          }
          const at = now();
          const items = (
            await trx
              .selectFrom("draft_items")
              .select("id")
              .where("person_id", "=", personId)
              .where("document_id", "=", documentId)
              .execute()
          ).map((i) => i.id);
          const changed = await markDeleted(
            trx,
            personId,
            documentId,
            items,
            revision,
            at,
          );
          files = [
            ...new Set(
              (
                await trx
                  .selectFrom("document_pages")
                  .select("file_id")
                  .where("person_id", "=", personId)
                  .where("document_id", "=", documentId)
                  .execute()
              ).flatMap((p) => (p.file_id === null ? [] : [p.file_id])),
            ),
          ];
          await trx
            .deleteFrom("draft_items")
            .where("person_id", "=", personId)
            .where("document_id", "=", documentId)
            .execute();
          await trx
            .updateTable("document_pages")
            .set({
              file_id: null,
              entry: null,
              entry_job_id: null,
              entry_attempt: null,
              entry_at: null,
              entry_checks: null,
              state: null,
              state_why: null,
            })
            .where("person_id", "=", personId)
            .where("document_id", "=", documentId)
            .execute();
          await trx
            .deleteFrom("jobs")
            .where("person_id", "=", personId)
            .where("document_id", "=", documentId)
            .execute();
          await trx
            .updateTable("documents")
            .set({ deleted_at: at, kind: null, date: null, reader_note: null })
            .where("person_id", "=", personId)
            .where("id", "=", documentId)
            .execute();
          // A file no live page of anyone uses any more.
          if (files.length > 0) {
            await trx
              .deleteFrom("files")
              .where("id", "in", files)
              .where(
                sql<boolean>`NOT EXISTS (SELECT 1 FROM document_pages p WHERE p.file_id = files.id)`,
              )
              .execute();
          }
          return changed;
        },
      );
      deps.stopReading(documentId);
      deps.changed(personId);
      // The document is deleted; bytes left behind go at the next start.
      await removeUnused(files).catch((error: unknown) => {
        deps.log("documents.cleanup_failed", { error: errorCode(error) });
      });
    },
  };
}

/**
 * At start, before anything else uses the files: removes the originals and
 * caches no file row names (a delete Rufi stopped after its commit).
 */
export async function sweepFiles(store: Store, home: string) {
  const live = await store.query.selectFrom("files").select("id").execute();
  return sweepBytes(home, new Set(live.map((f) => f.id)));
}

export type Deletions = ReturnType<typeof deletions>;
