// Device data (docs/adr/0023): what a person's devices measured, kept
// outside the record. A batch is stored first, as it came, in one
// transaction; the converter turns it into values later, one batch in one
// transaction. Batches convert in arrival order within a group (one
// person's batches from one system), so a deletion never comes before the
// value it deletes. A failure holds back its group only, and is tried again;
// an item that can't be converted is skipped with its reason, and its batch
// is kept until it is deleted.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { sql, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { errorCode } from "../../platform/logs.ts";
import {
  convertDeletion,
  convertValue,
  type ConvertedValue,
  type Skip,
} from "./convert.ts";

type Trx = Transaction<Tables>;

/** The biggest batch Rufi takes, counted on its bytes as sent. */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** The most values and deletions one batch holds together. */
export const MAX_ENTRIES = 5_000;
/** The longest sender's batch ID. */
const MAX_BATCH_ID = 200;

export const SYSTEMS = ["apple_health"] as const;
export type System = (typeof SYSTEMS)[number];

/** How long values are kept, for everyone in the data folder. */
const KEEPS = ["30d", "12m", "forever"] as const;
export type Keep = (typeof KEEPS)[number];
const KEEP_SETTING = "device.keep_values";
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS: Record<Keep, number | undefined> = {
  "30d": 30 * DAY_MS,
  "12m": 365 * DAY_MS,
  forever: undefined,
};
/** A done batch with nothing skipped goes this long after it was converted. */
const BATCH_KEEP_MS = 30 * DAY_MS;
/** Rows one clean-up transaction deletes at most, so receives aren't held up. */
const CHUNK = 5_000;
const BATCH_CHUNK = 100;

/** After a failed try, the next comes after these; then once an hour. */
const RETRY_MS = [30_000, 60_000, 120_000];
const RETRY_LAST_MS = 60 * 60 * 1000;

export type Problem =
  | "no_such_source"
  | "too_big"
  | "not_json"
  | "no_batch_id"
  | "lists_missing"
  | "too_many_entries"
  | "batch_id_reused";

export type Receipt =
  | { answer: "got_it" | "already_got"; batch: string }
  | { answer: "refused"; problems: Problem[] };

export type Step =
  | { done: string }
  | { failed: string; reason: string }
  | { idle: true; wake: string | undefined };

interface Counts {
  added: number;
  changed: number;
  already_had: number;
  removed: number;
  unknown_removal: number;
  skipped: number;
  older_than_kept: number;
}

export type AddSource =
  | {
      source: {
        id: string;
        name: string;
        system: System;
        person: { id: string; name: string };
      };
    }
  | { needsPerson: { id: string; name: string }[] };

export interface SourceSummary {
  id: string;
  name: string;
  system: System;
  person: { id: string; name: string };
  values: number;
  lastBatchAt: string | null;
  /** Batches received but not converted yet. */
  waiting: number;
  /** Items skipped in the batches still kept. */
  skipped: number;
  /** This source's batch that failed, holding back its group. */
  failed: { reason: string; tries: number; retryAt: string | null } | null;
  /** Another source's failed batch this source's batches wait behind. */
  waitsBehind: string | null;
}

/** Why a try failed, as fixed words and a code: never what it held. */
export function failureReason(error: unknown): string {
  const sqlite = (error as { errcode?: unknown } | null)?.errcode;
  const code = typeof sqlite === "number" ? sqlite & 0xff : undefined;
  if (code === 13 || errorCode(error) === "ENOSPC") return "disk_full";
  if (code === 10 || errorCode(error) === "EIO") return "io_error";
  return `error:${typeof sqlite === "number" ? String(sqlite) : errorCode(error)}`;
}

/**
 * A batch's bytes as JSON, read the same way at receive and at conversion:
 * UTF-8, a leading byte order mark dropped. The bytes are stored as they came.
 */
const readPage = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

const isKeep = (value: unknown): value is Keep => KEEPS.includes(value as Keep);

/** The instant before which values aren't kept, or none. */
function cutoffOf(keep: Keep, now: string): string | undefined {
  const ms = KEEP_MS[keep];
  return ms === undefined
    ? undefined
    : new Date(Date.parse(now) - ms).toISOString();
}

const sameContent = (row: Tables["device_values"], value: ConvertedValue) =>
  row.type === value.type &&
  row.value === value.value &&
  row.start_at === value.startAt &&
  row.end_at === value.endAt &&
  row.utc_offset === value.utcOffset &&
  row.time_zone === value.timeZone &&
  row.device === value.device &&
  row.context === value.context &&
  row.series === value.series;

type Head = {
  id: string;
  person_id: string;
  source_id: string;
  seq: number;
  status: string;
  retry_at: string | null;
  tries: number;
  system: string;
};

export function devices(store: Store, now: () => string) {
  const db = store.query;

  const keepOf = async (q: Trx | typeof db): Promise<Keep> => {
    const row = await q
      .selectFrom("settings")
      .select("value")
      .where("key", "=", KEEP_SETTING)
      .executeTakeFirst();
    return isKeep(row?.value) ? row.value : "forever";
  };

  /** Each group's lowest batch not done, in arrival order. */
  const heads = async (): Promise<Head[]> => {
    const result = await sql<Head>`
      SELECT id, person_id, source_id, seq, status, retry_at, tries, system FROM (
        SELECT b.id, b.person_id, b.source_id, b.seq, b.status, b.retry_at, b.tries, s.system,
               ROW_NUMBER() OVER (PARTITION BY b.person_id, s.system ORDER BY b.seq) AS n
        FROM device_batches b
        JOIN device_sources s ON s.person_id = b.person_id AND s.id = b.source_id
        WHERE b.status <> 'done'
      ) WHERE n = 1 ORDER BY seq`.execute(db);
    return result.rows;
  };

  async function convertBatch(trx: Trx, head: Head): Promise<void> {
    const at = now();
    const cutoff = cutoffOf(await keepOf(trx), at);
    const { body } = await trx
      .selectFrom("device_batches")
      .select("body")
      .where("person_id", "=", head.person_id)
      .where("id", "=", head.id)
      .executeTakeFirstOrThrow();
    // Receive checked the envelope: here it is only read, the same way.
    const page = readPage(gunzipSync(body)) as {
      values: unknown[];
      deleted: unknown[];
    };
    const counts: Counts = {
      added: 0,
      changed: 0,
      already_had: 0,
      removed: 0,
      unknown_removal: 0,
      skipped: 0,
      older_than_kept: 0,
    };
    const skipped: Skip[] = [];
    const find = (externalId: string) =>
      trx
        .selectFrom("device_values")
        .selectAll()
        .where("person_id", "=", head.person_id)
        .where("system", "=", head.system)
        .where("external_id", "=", externalId)
        .executeTakeFirst();

    for (const item of page.values) {
      const result = convertValue(head.system, item);
      if ("skip" in result) {
        counts.skipped++;
        skipped.push(result.skip);
        continue;
      }
      const value = result.value;
      if (cutoff !== undefined && value.startAt < cutoff) {
        counts.older_than_kept++;
        continue;
      }
      const content = {
        type: value.type,
        value: value.value,
        start_at: value.startAt,
        end_at: value.endAt,
        utc_offset: value.utcOffset,
        time_zone: value.timeZone,
        device: value.device,
        context: value.context,
        series: value.series,
      };
      const row = await find(value.externalId);
      if (row === undefined) {
        await trx
          .insertInto("device_values")
          .values({
            person_id: head.person_id,
            system: head.system,
            external_id: value.externalId,
            source_id: head.source_id,
            batch_id: head.id,
            ...content,
          })
          .execute();
        counts.added++;
      } else if (row.removed_at !== null || sameContent(row, value)) {
        // A removed value stays removed.
        counts.already_had++;
      } else {
        await trx
          .updateTable("device_values")
          // The value keeps the source that first sent it.
          .set({ ...content, batch_id: head.id })
          .where("person_id", "=", head.person_id)
          .where("system", "=", head.system)
          .where("external_id", "=", value.externalId)
          .execute();
        counts.changed++;
      }
    }

    // After the values, so a batch that adds and deletes a value removes it.
    for (const item of page.deleted) {
      const result = convertDeletion(item);
      if ("skip" in result) {
        counts.skipped++;
        skipped.push(result.skip);
        continue;
      }
      const row = await find(result.id);
      if (row === undefined) counts.unknown_removal++;
      else if (row.removed_at !== null) counts.already_had++;
      else {
        await trx
          .updateTable("device_values")
          .set({ removed_at: at, batch_id: head.id })
          .where("person_id", "=", head.person_id)
          .where("system", "=", head.system)
          .where("external_id", "=", result.id)
          .execute();
        counts.removed++;
      }
    }

    await trx
      .updateTable("device_batches")
      .set({
        status: "done",
        done_at: at,
        counts: JSON.stringify(counts),
        skipped: skipped.length === 0 ? null : JSON.stringify(skipped),
        retry_at: null,
        reason: null,
      })
      .where("person_id", "=", head.person_id)
      .where("id", "=", head.id)
      .execute();
  }

  return {
    /** A source bound to its person for good; the person may be left out only when there is one. */
    addSource: async (input: {
      name: string;
      system: System;
      personId?: string;
    }): Promise<AddSource> => {
      const people = await db
        .selectFrom("people")
        .select(["id", "display_name as name"])
        .orderBy("display_name")
        .execute();
      const person =
        input.personId === undefined
          ? people.length === 1
            ? people[0]
            : undefined
          : people.find((one) => one.id === input.personId);
      if (person === undefined) return { needsPerson: people };
      const id = uuid();
      await db
        .insertInto("device_sources")
        .values({
          id,
          person_id: person.id,
          system: input.system,
          name: input.name,
          created_at: now(),
        })
        .execute();
      return { source: { id, name: input.name, system: input.system, person } };
    },

    /**
     * Stores a batch as it came, waiting to be converted; or says it has it,
     * or refuses it with every problem and stores nothing. It doesn't look
     * inside the items.
     */
    receive: async (sourceId: string, bytes: Uint8Array): Promise<Receipt> => {
      const source = await db
        .selectFrom("device_sources")
        .select(["id", "person_id"])
        .where("id", "=", sourceId)
        .executeTakeFirst();
      if (source === undefined)
        return { answer: "refused", problems: ["no_such_source"] };
      if (bytes.byteLength > MAX_BATCH_BYTES)
        return { answer: "refused", problems: ["too_big"] };
      let page: unknown;
      try {
        page = readPage(bytes);
      } catch {
        return { answer: "refused", problems: ["not_json"] };
      }
      const envelope = (
        typeof page === "object" && page !== null && !Array.isArray(page)
          ? page
          : {}
      ) as Record<string, unknown>;
      const problems: Problem[] = [];
      const batchId = envelope.batch;
      if (
        typeof batchId !== "string" ||
        batchId.length === 0 ||
        batchId.length > MAX_BATCH_ID
      )
        problems.push("no_batch_id");
      const { values, deleted } = envelope;
      if (!Array.isArray(values) || !Array.isArray(deleted))
        problems.push("lists_missing");
      else if (values.length + deleted.length > MAX_ENTRIES)
        problems.push("too_many_entries");
      if (problems.length > 0) return { answer: "refused", problems };

      const sha = createHash("sha256").update(bytes).digest("hex");
      const body = gzipSync(bytes);
      return db.transaction().execute(async (trx): Promise<Receipt> => {
        const had = await trx
          .selectFrom("device_batches")
          .select(["id", "body_sha256"])
          .where("source_id", "=", source.id)
          .where("sender_batch_id", "=", batchId as string)
          .executeTakeFirst();
        if (had !== undefined) {
          return had.body_sha256 === sha
            ? { answer: "already_got", batch: had.id }
            : { answer: "refused", problems: ["batch_id_reused"] };
        }
        const at = now();
        const { last } = await trx
          .selectFrom("device_batches")
          .select((eb) => eb.fn.max<number | null>("seq").as("last"))
          .executeTakeFirstOrThrow();
        const id = uuid();
        await trx
          .insertInto("device_batches")
          .values({
            id,
            person_id: source.person_id,
            source_id: source.id,
            seq: (last ?? 0) + 1,
            sender_batch_id: batchId as string,
            received_at: at,
            body,
            body_sha256: sha,
            body_bytes: bytes.byteLength,
            status: "waiting",
            tries: 0,
          })
          .execute();
        await trx
          .updateTable("device_sources")
          .set({ last_batch_at: at })
          .where("id", "=", source.id)
          .execute();
        return { answer: "got_it", batch: id };
      });
    },

    /** At start: each failed group head is tried once at once (a start may follow a fix or freed space). */
    retryFailedNow: async () => {
      await db
        .updateTable("device_batches")
        .set({ retry_at: now() })
        .where("status", "=", "failed")
        .execute();
    },

    /**
     * Converts the next batch that is due, in one transaction. A failure
     * rolls it back and marks the batch failed with its reason; if even that
     * can't be written, the error is thrown and the batch stays as it was.
     */
    convertNext: async (): Promise<Step> => {
      const at = now();
      const all = await heads();
      const head = all.find(
        (one) => one.status === "waiting" || (one.retry_at ?? "") <= at,
      );
      if (head === undefined) {
        const wake = all
          .map((one) => one.retry_at)
          .filter((one) => one !== null)
          .sort()[0];
        return { idle: true, wake };
      }
      try {
        await db.transaction().execute((trx) => convertBatch(trx, head));
        return { done: head.id };
      } catch (error) {
        const reason = failureReason(error);
        const tries = head.tries + 1;
        const wait = RETRY_MS[tries - 1] ?? RETRY_LAST_MS;
        await db
          .updateTable("device_batches")
          .set({
            status: "failed",
            reason,
            tries,
            retry_at: new Date(Date.parse(now()) + wait).toISOString(),
          })
          .where("person_id", "=", head.person_id)
          .where("id", "=", head.id)
          .execute();
        return { failed: head.id, reason };
      }
    },

    keep: () => keepOf(db),

    /**
     * What keeping values for `keep` would delete now: exactly what the
     * clean-up deletes, every value measured before the cutoff, removed ones too.
     */
    preview: async (
      keep: Keep,
    ): Promise<{ values: number; before: string | null }> => {
      const before = cutoffOf(keep, now());
      if (before === undefined) return { values: 0, before: null };
      const { count } = await db
        .selectFrom("device_values")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("start_at", "<", before)
        .executeTakeFirstOrThrow();
      return { values: count, before };
    },

    /** Saves how long values are kept; a shorter time is cleaned at once by the caller. */
    setKeep: async (keep: Keep) => {
      await db
        .insertInto("settings")
        .values({ key: KEEP_SETTING, value: keep })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: keep }))
        .execute();
    },

    /**
     * Deletes values older than the kept time, and done batches 30 days
     * after they were converted unless they have skipped items, in chunks.
     * Each chunk works out its cutoff in its own transaction.
     */
    cleanUp: async (): Promise<{ values: number; batches: number }> => {
      let values = 0;
      let batches = 0;
      for (;;) {
        const gone = await db.transaction().execute(async (trx) => {
          const cutoff = cutoffOf(await keepOf(trx), now());
          if (cutoff === undefined) return 0;
          const result = await sql`
            DELETE FROM device_values WHERE (person_id, system, external_id) IN (
              SELECT person_id, system, external_id FROM device_values WHERE start_at < ${cutoff} LIMIT ${CHUNK}
            )`.execute(trx);
          return Number(result.numAffectedRows ?? 0);
        });
        values += gone;
        if (gone < CHUNK) break;
      }
      for (;;) {
        const gone = await db.transaction().execute(async (trx) => {
          const before = new Date(
            Date.parse(now()) - BATCH_KEEP_MS,
          ).toISOString();
          const old = await trx
            .selectFrom("device_batches")
            .select(["person_id", "id"])
            .where("status", "=", "done")
            .where("done_at", "<", before)
            .where("skipped", "is", null)
            .limit(BATCH_CHUNK)
            .execute();
          for (const batch of old) {
            // A value keeps its row; only its link to the batch goes.
            await trx
              .updateTable("device_values")
              .set({ batch_id: null })
              .where("person_id", "=", batch.person_id)
              .where("batch_id", "=", batch.id)
              .execute();
            await trx
              .deleteFrom("device_batches")
              .where("person_id", "=", batch.person_id)
              .where("id", "=", batch.id)
              .execute();
          }
          return old.length;
        });
        batches += gone;
        if (gone < BATCH_CHUNK) break;
      }
      return { values, batches };
    },

    /** Each source with what Settings shows of it. */
    sources: async (): Promise<SourceSummary[]> => {
      const sources = await db
        .selectFrom("device_sources as s")
        .innerJoin("people as p", "p.id", "s.person_id")
        .select([
          "s.id",
          "s.name",
          "s.system",
          "s.person_id",
          "p.display_name",
          "s.last_batch_at",
        ])
        .orderBy("p.display_name")
        .orderBy("s.created_at")
        .execute();
      const values = await db
        .selectFrom("device_values")
        .select(["source_id", (eb) => eb.fn.countAll<number>().as("count")])
        .where("removed_at", "is", null)
        .groupBy("source_id")
        .execute();
      const batches = await db
        .selectFrom("device_batches")
        .select([
          "source_id",
          "status",
          "skipped",
          "reason",
          "tries",
          "retry_at",
          "person_id",
          "seq",
        ])
        .where((eb) =>
          eb.or([eb("status", "<>", "done"), eb("skipped", "is not", null)]),
        )
        .orderBy("seq")
        .execute();
      const failedHeads = (await heads()).filter(
        (head) => head.status === "failed",
      );
      const names = new Map(sources.map((source) => [source.id, source.name]));
      return sources.map((source) => {
        const own = batches.filter((batch) => batch.source_id === source.id);
        const failed = failedHeads.find((head) => head.source_id === source.id);
        const blocking = failedHeads.find(
          (head) =>
            head.person_id === source.person_id &&
            head.system === source.system &&
            head.source_id !== source.id,
        );
        const skipped = own.reduce(
          (sum, batch) =>
            sum +
            (batch.skipped === null
              ? 0
              : (JSON.parse(batch.skipped) as unknown[]).length),
          0,
        );
        const failedRow =
          failed && own.find((batch) => batch.seq === failed.seq);
        return {
          id: source.id,
          name: source.name,
          system: source.system as System,
          person: { id: source.person_id, name: source.display_name },
          values: values.find((row) => row.source_id === source.id)?.count ?? 0,
          lastBatchAt: source.last_batch_at,
          waiting: own.filter((batch) => batch.status !== "done").length,
          skipped,
          failed: failedRow
            ? {
                reason: failedRow.reason ?? "error:other",
                tries: failedRow.tries,
                retryAt: failedRow.retry_at,
              }
            : null,
          waitsBehind:
            blocking !== undefined &&
            own.some((batch) => batch.status !== "done")
              ? (names.get(blocking.source_id) ?? null)
              : null,
        };
      });
    },
  };
}

export type Devices = ReturnType<typeof devices>;
