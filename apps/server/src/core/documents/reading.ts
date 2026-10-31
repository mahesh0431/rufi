// Readings of documents: the jobs that read them. A reading agent that Rufi
// AI starts saves a whole reading at once (save-reading.ts); the older
// reader's jobs ran one at a time, their runs writing page copies
// (copies.ts). Either way a reading targets some pages of its document (all
// of them first; a read-again only the pages that couldn't be read), and
// finishes once: page states, the document's version, the job done. Rufi AI
// then sorts the pages (sorting.ts), which makes the drafts. An older job
// that didn't finish failed with its copies kept, and its pages are read
// again when its document is sent again. Nothing here writes the record or
// decides what a page means. Pages an older reader saved as notebook entries
// keep them, and are shown as they are.
import type { Chip } from "@rufi/contracts";
import type { Transaction } from "kysely";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import type { ReadingRun } from "./copies.ts";
import type { Checks, Entry } from "./notebook.ts";
import { documentName, ranges } from "./naming.ts";
import { pagesOf } from "./sorting.ts";

export interface Job {
  id: string;
  personId: string;
  documentId: string;
  state: "queued" | "running" | "done" | "failed";
  attempt: number;
  targets: number[];
  /** Automatic retries used since its start or the person's Retry. */
  retries: number;
  /** A queued automatic retry runs from then on. */
  retryAt: string | null;
  startedAt: string | null;
}

/** The AI use of an older reader's runs, summed, as the agent reported it. */
interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Calls to get_page and save_page. */
  looks: number;
  saves: number;
  compactions: number;
}

type Trx = Transaction<Tables>;

const jobOf = (row: Tables["jobs"]): Job => ({
  id: row.id,
  personId: row.person_id,
  documentId: row.document_id,
  state: row.state as Job["state"],
  attempt: row.attempt,
  targets: JSON.parse(row.targets) as number[],
  retries: row.retries,
  retryAt: row.retry_at,
  startedAt: row.started_at,
});

/** The copies a reading saved of its document's pages, by position. */
const copiedBy = async (
  trx: Trx | Store["query"],
  run: Pick<ReadingRun, "jobId" | "personId" | "documentId">,
) =>
  new Map(
    (
      await trx
        .selectFrom("page_copies as c")
        .innerJoin("document_pages as p", (join) =>
          join
            .onRef("p.person_id", "=", "c.person_id")
            .onRef("p.file_id", "=", "c.file_id")
            .onRef("p.page_in_file", "=", "c.page_in_file"),
        )
        .select(["p.position", "c.outcome", "c.why"])
        .where("c.person_id", "=", run.personId)
        .where("c.job_id", "=", run.jobId)
        .where("p.document_id", "=", run.documentId)
        .execute()
    ).map((c) => [c.position, c] as const),
  );

/**
 * In `trx`: a running reading's normal end, once per job: each target's
 * state (its copy's outcome, or not looked at), the document's version
 * raised, the job done. A reading with nothing to sort (only unreadable
 * pages) is sorted as it ends. Draft items come from Rufi AI's sort
 * (sorting.ts), never from here. The old reader's finish and save_reading
 * (save-reading.ts) both end a reading through it.
 */
export async function finishIn(
  trx: Trx,
  run: ReadingRun & { targets: readonly number[] },
  at: string,
) {
  const copied = await copiedBy(trx, run);
  const sorts = [...copied.values()].some(
    (copy) => copy.outcome !== "unreadable",
  );
  const ended = await trx
    .updateTable("jobs")
    .set({
      state: "done",
      ended_at: at,
      error: null,
      sorted_at: sorts ? null : at,
    })
    .where("id", "=", run.jobId)
    .where("state", "=", "running")
    .where("attempt", "=", run.attempt)
    .executeTakeFirst();
  if (ended.numUpdatedRows !== 1n) {
    throw new Error("The reading isn't running any more.");
  }
  for (const target of run.targets) {
    const copy = copied.get(target);
    await trx
      .updateTable("document_pages")
      .set({
        state: copy?.outcome ?? "not_looked_at",
        state_why: copy?.outcome === "unreadable" ? copy.why : null,
      })
      .where("person_id", "=", run.personId)
      .where("document_id", "=", run.documentId)
      .where("position", "=", target)
      .execute();
  }
  await trx
    .updateTable("documents")
    .set((eb) => ({ version: eb("version", "+", 1) }))
    .where("person_id", "=", run.personId)
    .where("id", "=", run.documentId)
    .execute();
}

/** What a document sent with a message needs read: new pages, or the rest of a reading that stopped. */
type Plan =
  | { kind: "new"; targets: number[] }
  /** An older reader's reading that stopped. */
  | { kind: "again"; job: Job }
  | undefined;

/** Why a reading Rufi stopped in the middle failed, for the person. */
export const CLOSED_WHILE_READING = "Rufi closed while reading";

export function readings(store: Store) {
  const db = store.query;
  const listeners = new Map<string, Set<() => void>>();

  /** Tells the person's screens that their readings changed. */
  const changed = (personId: string) => {
    for (const listener of listeners.get(personId) ?? []) listener();
  };

  const positions = async (
    trx: Trx | Store["query"],
    personId: string,
    documentId: string,
  ) =>
    (
      await trx
        .selectFrom("document_pages")
        .select("position")
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .orderBy("position")
        .execute()
    ).map((p) => p.position);

  /**
   * The latest reading of any of the document's pages: a reading of its
   * add (a split document's pages were read with the add) or of the
   * document itself, whose targets include one of its pages.
   */
  const readingOf = async (
    trx: Trx | Store["query"],
    personId: string,
    documentId: string,
  ): Promise<Job | undefined> => {
    const document = await trx
      .selectFrom("documents")
      .select(["id", "from_document"])
      .where("person_id", "=", personId)
      .where("id", "=", documentId)
      .executeTakeFirst();
    if (!document) return undefined;
    const add = document.from_document ?? document.id;
    const mine = new Set(await positions(trx, personId, documentId));
    const rows = await trx
      .selectFrom("jobs as j")
      .innerJoin("documents as d", (join) =>
        join
          .onRef("d.person_id", "=", "j.person_id")
          .onRef("d.id", "=", "j.document_id"),
      )
      .selectAll("j")
      .where("j.person_id", "=", personId)
      .where((eb) =>
        eb.or([eb("d.id", "=", add), eb("d.from_document", "=", add)]),
      )
      .orderBy("j.created_at", "desc")
      .orderBy("j.id", "desc")
      .execute();
    return rows.map(jobOf).find((job) => job.targets.some((t) => mine.has(t)));
  };

  /** What the document's reading needs when a message sends it. */
  const planOf = async (
    trx: Trx | Store["query"],
    personId: string,
    documentId: string,
    again: boolean,
  ): Promise<Plan> => {
    const live = await trx
      .selectFrom("documents")
      .select("id")
      .where("person_id", "=", personId)
      .where("id", "=", documentId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) return undefined;
    const job = await readingOf(trx, personId, documentId);
    if (!job) {
      return {
        kind: "new",
        targets: await positions(trx, personId, documentId),
      };
    }
    if (job.state === "queued" || job.state === "running") return undefined;
    if (job.state === "failed" && job.documentId === documentId) {
      return { kind: "again", job };
    }
    if (!again && job.state !== "failed") return undefined;
    const failed = (
      await trx
        .selectFrom("document_pages")
        .select("position")
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .where("state", "in", ["unreadable", "not_looked_at"])
        .orderBy("position")
        .execute()
    ).map((p) => p.position);
    return failed.length === 0 ? undefined : { kind: "new", targets: failed };
  };

  return {
    changed,

    /** Listens to one person's readings; returns the way to stop. */
    subscribe: (personId: string, listener: () => void) => {
      let set = listeners.get(personId);
      if (!set) listeners.set(personId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    /**
     * Rufi's note for the AI on the documents among a message's chips that
     * aren't read: each one's pages to read (every page of one never read,
     * those of an older reading that stopped, and with Retry the pages that
     * couldn't be read or weren't looked at). Undefined when all are read.
     * Writes nothing.
     */
    toRead: async (
      personId: string,
      chips: readonly Chip[],
    ): Promise<string | undefined> => {
      const lines: string[] = [];
      for (const { ref } of chips) {
        if (ref.type !== "document") continue;
        const again = ref.readAgain === true;
        const plan = await planOf(db, personId, ref.id, again);
        if (plan === undefined) continue;
        const pages = await db
          .selectFrom("document_pages")
          .select(["position", "file_name"])
          .where("person_id", "=", personId)
          .where("document_id", "=", ref.id)
          .orderBy("position")
          .execute();
        const name = documentName(pages.map((p) => p.file_name));
        const of = `of ${String(pages.length)}`;
        if (plan.kind === "again") {
          lines.push(
            `- ${name} (document ${ref.id}): pages ${ranges(plan.job.targets)} ${of}, whose reading stopped before it finished`,
          );
        } else if (plan.targets.length === pages.length) {
          lines.push(
            `- ${name} (document ${ref.id}): ${pages.length === 1 ? "its page" : `all ${String(pages.length)} pages`}`,
          );
        } else {
          lines.push(
            `- ${name} (document ${ref.id}): pages ${ranges(plan.targets)} ${of} again, which couldn't be read or weren't looked at`,
          );
        }
      }
      if (lines.length === 0) return undefined;
      return [
        "Files the user sent that aren't read yet: these pages are read before they are sorted (the sorting-documents skill).",
        ...lines,
      ].join("\n");
    },

    /**
     * Each of the person's documents' reading, for the Documents page and
     * get_documents: not read yet, reading, done or failed, with counts.
     * Worked out from the document's own pages, so a document split from
     * an add has the add's reading of its pages.
     */
    statuses: async (personId: string) => {
      const jobs = (
        await db
          .selectFrom("jobs")
          .selectAll()
          .where("person_id", "=", personId)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .execute()
      ).map((row) => ({ job: jobOf(row), error: row.error }));
      // A deleted add's reading still read its live split documents' pages.
      const all = await db
        .selectFrom("documents")
        .select(["id", "from_document", "deleted_at"])
        .where("person_id", "=", personId)
        .execute();
      const addOf = new Map(all.map((d) => [d.id, d.from_document ?? d.id]));
      const documents = all.filter((d) => d.deleted_at === null);
      const pages = await db
        .selectFrom("document_pages")
        .select(["document_id", "position", "entry_job_id", "state"])
        .where("person_id", "=", personId)
        .execute();
      const copies = await db
        .selectFrom("page_copies as c")
        .innerJoin("document_pages as p", (join) =>
          join
            .onRef("p.person_id", "=", "c.person_id")
            .onRef("p.file_id", "=", "c.file_id")
            .onRef("p.page_in_file", "=", "c.page_in_file"),
        )
        .select(["c.job_id", "p.document_id", "p.position"])
        .where("c.person_id", "=", personId)
        .execute();
      const drafts = await db
        .selectFrom("draft_items")
        .select(["document_id", "status", "unsure", "fields"])
        .where("person_id", "=", personId)
        .execute();
      const statuses = new Map<
        string,
        {
          status: "reading" | "done" | "failed";
          saved: number;
          of: number;
          results: number;
          hasPending: boolean;
          toCheck: number;
          itemsSaved: number;
          itemsSetAside: number;
          canRetry: boolean;
          error: string | null;
        }
      >();
      for (const document of documents) {
        const add = addOf.get(document.id);
        const mine = pages.filter((p) => p.document_id === document.id);
        const here = new Set(mine.map((p) => p.position));
        const found = jobs.find(
          ({ job }) =>
            addOf.get(job.documentId) === add &&
            job.targets.some((t) => here.has(t)),
        );
        if (!found) continue;
        const { job, error } = found;
        const targets = job.targets.filter((t) => here.has(t));
        const copied = new Set(
          copies
            .filter((c) => c.job_id === job.id && c.document_id === document.id)
            .map((c) => c.position),
        );
        const pending = drafts.filter(
          (d) => d.document_id === document.id && d.status === "pending",
        );
        // Current values only in the result count: an older reader's earlier
        // column isn't counted.
        const current = pending.filter(
          (d) =>
            (JSON.parse(d.fields) as { column?: string }).column !== "earlier",
        );
        const done = (status: "saved" | "dismissed") =>
          drafts.filter(
            (d) => d.document_id === document.id && d.status === status,
          ).length;
        statuses.set(document.id, {
          status:
            job.state === "queued" || job.state === "running"
              ? "reading"
              : job.state,
          saved: mine.filter(
            (p) =>
              targets.includes(p.position) &&
              (copied.has(p.position) || p.entry_job_id === job.id),
          ).length,
          of: targets.length,
          results: current.length,
          hasPending: pending.length > 0,
          toCheck: current.filter((d) => d.unsure !== "[]").length,
          itemsSaved: done("saved"),
          itemsSetAside: done("dismissed"),
          canRetry:
            job.state === "failed" ||
            (job.state === "done" &&
              mine.some(
                (p) => p.state === "unreadable" || p.state === "not_looked_at",
              )),
          error,
        });
      }
      return statuses;
    },

    /** One document's reading as Open shows it: each page's entry, the note, the AI use. */
    view: async (personId: string, documentId: string) => {
      const document = await db
        .selectFrom("documents")
        .select(["id", "reader_note"])
        .where("person_id", "=", personId)
        .where("id", "=", documentId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!document) return undefined;
      const job = await readingOf(db, personId, documentId);
      const row =
        job &&
        (await db
          .selectFrom("jobs")
          .select(["usage", "reader", "run_at", "error"])
          .where("id", "=", job.id)
          .executeTakeFirstOrThrow());
      const pages = await db
        .selectFrom("document_pages")
        .select([
          "position",
          "file_name",
          "entry",
          "entry_job_id",
          "entry_checks",
          "state",
          "state_why",
        ])
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .orderBy("position")
        .execute();
      const reader = row?.reader
        ? (JSON.parse(row.reader) as { model?: string; effort?: string })
        : undefined;
      const copies = new Map(
        (await pagesOf(db, personId, [documentId])).map((p) => [
          p.position,
          p.copy,
        ]),
      );
      // While it reads, the copies it saved so far.
      const sofar = new Map(
        job && (job.state === "queued" || job.state === "running")
          ? (
              await db
                .selectFrom("page_copies as c")
                .innerJoin("document_pages as p", (join) =>
                  join
                    .onRef("p.person_id", "=", "c.person_id")
                    .onRef("p.file_id", "=", "c.file_id")
                    .onRef("p.page_in_file", "=", "c.page_in_file"),
                )
                .select(["p.position", "c.copy"])
                .where("c.person_id", "=", personId)
                .where("p.document_id", "=", documentId)
                .where("c.job_id", "=", job.id)
                .execute()
            ).map((c) => [c.position, c.copy])
          : [],
      );
      const targets =
        job?.targets.filter((t) => pages.some((p) => p.position === t)) ?? [];
      return {
        name: documentName(pages.map((p) => p.file_name)),
        status:
          job === undefined
            ? ("not_read" as const)
            : job.state === "queued" || job.state === "running"
              ? ("reading" as const)
              : job.state,
        saved: job
          ? pages.filter(
              (p) => p.entry_job_id === job.id && targets.includes(p.position),
            ).length
          : 0,
        of: job ? targets.length : pages.length,
        runAt: job?.state === "running" ? (row?.run_at ?? null) : null,
        error: row?.error ?? null,
        note: document.reader_note,
        pages: pages.map((p) => ({
          position: p.position,
          state: p.state,
          why: p.state_why,
          entry: p.entry ? (JSON.parse(p.entry) as Entry) : null,
          copy: sofar.get(p.position) ?? copies.get(p.position)?.text ?? null,
          checks: p.entry_checks
            ? (JSON.parse(p.entry_checks) as Checks)
            : null,
        })),
        usage: row?.usage ? (JSON.parse(row.usage) as Usage) : null,
        model: reader?.model ?? null,
        effort: reader?.effort ?? null,
      };
    },
  };
}

export type Readings = ReturnType<typeof readings>;
