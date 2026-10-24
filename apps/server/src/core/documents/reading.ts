// Reading documents: the jobs that read them, one at a time. A job is made
// or opened again when the reply of the message that sent its document
// starts (server/chat.ts), and runs in that reply, before the AI gets the
// message. It targets some pages of its document (all of them first; a
// read-again only the pages that couldn't be read). Its runs write the
// reader's page copies (copies.ts); only a run whose reader turn completed
// normally finishes the job: page states, the document's version, the job
// done. Rufi AI then sorts the pages in the same reply (sorting.ts), which
// makes the drafts. A job that doesn't finish fails with its copies kept:
// when its reply ends otherwise, or at the next start. It goes on when its
// document is sent again. Nothing here writes the record or decides what a
// page means. Pages an older reader saved as notebook entries keep them, and
// are shown as they are.
import { sql, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import type { Checks, Entry, Run } from "./notebook.ts";
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

/** The AI use of a reading's runs, summed, as the agent reported it. */
export interface Usage {
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

/**
 * The reading is gone: its document was deleted (core/documents/delete.ts).
 * Whatever of it still runs stops quietly, with nothing written.
 */
export class ReadingGone extends Error {}

/** Why a job's guarded update changed nothing: gone, or moved on. */
async function notRunning(trx: Trx, jobId: string, what: string) {
  const job = await trx
    .selectFrom("jobs")
    .select("id")
    .where("id", "=", jobId)
    .executeTakeFirst();
  return job
    ? new Error(what)
    : new ReadingGone("The reading's document was deleted.");
}

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

/** What a job does when its reply starts, for a document sent with it. */
type Plan =
  | { kind: "new"; targets: number[] }
  | { kind: "again"; job: Job }
  | undefined;

/** Why a reading Rufi stopped in the middle failed, for the person. */
export const CLOSED_WHILE_READING = "Rufi closed while reading";

export function readings(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  const listeners = new Map<string, Set<() => void>>();

  /** Tells the person's screens that their readings changed. */
  const changed = (personId: string) => {
    for (const listener of listeners.get(personId) ?? []) listener();
  };

  /** Queues a reading of `targets` of the document. */
  const queueIn = async (
    trx: Trx,
    personId: string,
    documentId: string,
    targets: readonly number[],
  ) => {
    const id = uuid();
    await trx
      .insertInto("jobs")
      .values({
        id,
        person_id: personId,
        kind: "document_read",
        document_id: documentId,
        state: "queued",
        attempt: 0,
        targets: JSON.stringify(targets),
        retries: 0,
        created_at: now(),
      })
      .execute();
    return id;
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

  /** This job's page copies of the document, by position. */
  const copiedBy = async (
    trx: Trx | Store["query"],
    run: Pick<Run, "jobId" | "personId" | "documentId">,
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
   * Starts a run of a queued job: running, the next attempt. Returns the
   * run, bound to it.
   */
  const begin = async (trx: Trx, job: Job): Promise<Run> => {
    const at = now();

    const started = await trx
      .updateTable("jobs")
      .set({
        state: "running",
        attempt: job.attempt + 1,
        run_at: at,
        started_at: job.startedAt ?? at,
        retry_at: null,
      })
      .where("id", "=", job.id)
      .where("state", "=", "queued")
      .where("attempt", "=", job.attempt)
      .executeTakeFirst();
    if (started.numUpdatedRows !== 1n) {
      throw await notRunning(
        trx,
        job.id,
        "The reading changed before it started.",
      );
    }
    return {
      jobId: job.id,
      attempt: job.attempt + 1,
      personId: job.personId,
      documentId: job.documentId,
      targets: job.targets,
      lookedAt: new Set(),
      closed: false,
    };
  };

  /** Keep failed-run entries for Retry, but never finish from them alone. */
  const markFailedEntries = (trx: Trx, run: Run) =>
    trx
      .updateTable("document_pages")
      .set({ entry_attempt: 0 })
      .where("person_id", "=", run.personId)
      .where("document_id", "=", run.documentId)
      .where("entry_job_id", "=", run.jobId)
      .where("entry_attempt", "=", run.attempt)
      .execute();

  /**
   * Queued or running jobs (of `ids`, or all) failed with `why`; the
   * entries of their current attempts kept for the next one, never to
   * finish from alone. Returns whose they were.
   */
  const failUnfinished = async (
    trx: Trx,
    why: string,
    ids?: readonly string[],
  ) => {
    const open = trx
      .selectFrom("jobs as j")
      .select("j.id")
      .where("j.state", "in", ["queued", "running"])
      .$if(ids !== undefined, (q) => q.where("j.id", "in", [...(ids ?? [])]));
    await trx
      .updateTable("document_pages")
      .set({ entry_attempt: 0 })
      .where("entry_job_id", "in", open)
      .where("entry_attempt", ">", 0)
      .where(
        sql<boolean>`entry_attempt = (SELECT attempt FROM jobs WHERE jobs.id = document_pages.entry_job_id)`,
      )
      .execute();
    return trx
      .updateTable("jobs")
      .set({ state: "failed", error: why, ended_at: now(), retry_at: null })
      .where("state", "in", ["queued", "running"])
      .$if(ids !== undefined, (q) => q.where("id", "in", [...(ids ?? [])]))
      .returning("person_id")
      .execute();
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
     * Whether the document needs reading when a message sends it: never
     * read, its reading failed, or `again` (Retry) and its reading couldn't
     * read some pages. Writes nothing.
     */
    needs: async (personId: string, documentId: string, again: boolean) =>
      (await planOf(db, personId, documentId, again)) !== undefined,

    /**
     * In the transaction that starts a reply: the job that reads the
     * document now, or undefined when it needs none. A document never read
     * gets a job for every page; a failed reading is queued again to go on
     * where it stopped; with `again`, a finished one gets a job for the
     * pages it couldn't read or didn't look at.
     */
    open: async (
      trx: Trx,
      personId: string,
      documentId: string,
      again: boolean,
    ): Promise<Job | undefined> => {
      const plan = await planOf(trx, personId, documentId, again);
      if (plan === undefined) return undefined;
      let id: string;
      if (plan.kind === "new") {
        id = await queueIn(trx, personId, documentId, plan.targets);
      } else {
        id = plan.job.id;
        await trx
          .updateTable("jobs")
          .set({
            state: "queued",
            error: null,
            ended_at: null,
            retries: 0,
            retry_at: null,
          })
          .where("id", "=", id)
          .execute();
      }
      return jobOf(
        await trx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow(),
      );
    },

    /**
     * In the transaction that ends a reply: its jobs that haven't finished
     * (not started, running, or waiting for a retry) fail with `why`, their
     * copies kept.
     */
    failOpen: async (trx: Trx, jobIds: readonly string[], why: string) => {
      if (jobIds.length === 0) return;
      await failUnfinished(trx, why, jobIds);
    },

    /**
     * At start: readings Rufi stopped in the middle fail, their copies
     * kept. Nothing reads by itself: the person sends the document again.
     */
    recover: async () => {
      const rows = await db
        .transaction()
        .execute((trx) => failUnfinished(trx, CLOSED_WHILE_READING));
      return rows.length;
    },

    /** The job as stored now. */
    job: async (jobId: string): Promise<Job | undefined> => {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirst();
      return row && jobOf(row);
    },

    /**
     * Whether every target has this job's copy from a run not recorded as
     * failed. A page an older reader saved in this job's notebook has no
     * copy: the reader that copies reads it again.
     */
    allSaved: async (job: Job) => {
      const rows = await db
        .selectFrom("document_pages as p")
        .innerJoin("page_copies as c", (join) =>
          join
            .onRef("c.person_id", "=", "p.person_id")
            .onRef("c.file_id", "=", "p.file_id")
            .onRef("c.page_in_file", "=", "p.page_in_file"),
        )
        .select("p.position")
        .where("p.person_id", "=", job.personId)
        .where("p.document_id", "=", job.documentId)
        .where("c.job_id", "=", job.id)
        .where("p.entry_job_id", "=", job.id)
        .where("p.entry_attempt", ">", 0)
        .execute();
      const saved = new Set(rows.map((r) => r.position));
      return job.targets.every((t) => saved.has(t));
    },

    /** Starts a run of a queued job: running, the next attempt. */
    startRun: (job: Job): Promise<Run> =>
      db.transaction().execute((trx) => begin(trx, job)),

    /**
     * What a run's reader is told: the document's pages and which of its
     * targets this reading has copied, and the display name of the run's
     * person.
     */
    about: async (run: Run) => {
      const person = await db
        .selectFrom("people")
        .select("display_name")
        .where("id", "=", run.personId)
        .executeTakeFirstOrThrow();
      const pages = await db
        .selectFrom("document_pages")
        .select(["position", "file_name"])
        .where("person_id", "=", run.personId)
        .where("document_id", "=", run.documentId)
        .orderBy("position")
        .execute();
      const copied = await copiedBy(db, run);
      return {
        person: person.display_name,
        pages: pages.length,
        files: pages.map((p) => p.file_name),
        targets: run.targets,
        saved: run.targets.filter((t) => copied.has(t)),
      };
    },

    /** Adds a run's AI use to the job, and the reader version it ran. */
    recordRun: async (run: Run, usage: Usage, reader: unknown) => {
      const row = await db
        .selectFrom("jobs")
        .select("usage")
        .where("id", "=", run.jobId)
        .executeTakeFirst();
      const before = row?.usage ? (JSON.parse(row.usage) as Usage) : undefined;
      const sum = { ...usage };
      if (before) {
        for (const key of Object.keys(sum) as (keyof Usage)[]) {
          sum[key] += before[key];
        }
      }
      await db
        .updateTable("jobs")
        .set({ usage: JSON.stringify(sum), reader: JSON.stringify(reader) })
        .where("id", "=", run.jobId)
        .execute();
    },

    /**
     * A run that failed for a passing reason goes back to the queue, as an
     * automatic retry from `at` on.
     */
    retryAt: async (run: Run, at: string) => {
      await db.transaction().execute(async (trx) => {
        await markFailedEntries(trx, run);
        await trx
          .updateTable("jobs")
          .set((eb) => ({
            state: "queued",
            retries: eb("retries", "+", 1),
            retry_at: at,
          }))
          .where("id", "=", run.jobId)
          .where("state", "=", "running")
          .where("attempt", "=", run.attempt)
          .execute();
      });
      changed(run.personId);
    },

    /** A reading's end that failed: the job failed, its copies kept. */
    fail: async (run: Run, error: string) => {
      await db.transaction().execute(async (trx) => {
        await markFailedEntries(trx, run);
        const ended = await trx
          .updateTable("jobs")
          .set({ state: "failed", error, ended_at: now() })
          .where("id", "=", run.jobId)
          .where("state", "=", "running")
          .where("attempt", "=", run.attempt)
          .executeTakeFirst();
        if (ended.numUpdatedRows !== 1n) {
          throw await notRunning(
            trx,
            run.jobId,
            "The reading isn't running any more.",
          );
        }
      });
      changed(run.personId);
    },

    /**
     * A reading's normal end, once per job: each target's state (its
     * copy's outcome, or not looked at), the document's version raised, the
     * job done. A reading with nothing to sort (only unreadable pages) is
     * sorted as it ends. Draft items come from Rufi AI's sort (sorting.ts),
     * never from here.
     */
    finish: async (run: Run) => {
      await db.transaction().execute(async (trx) => {
        const at = now();
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
          throw await notRunning(
            trx,
            run.jobId,
            "The reading isn't running any more.",
          );
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
      });
      changed(run.personId);
    },

    /**
     * The document's name and how far the job's reading got: its targets
     * copied so far, of how many.
     */
    progress: async (
      job: Pick<Job, "id" | "personId" | "documentId" | "targets">,
    ) => {
      const pages = await db
        .selectFrom("document_pages")
        .select("file_name")
        .where("person_id", "=", job.personId)
        .where("document_id", "=", job.documentId)
        .orderBy("position")
        .execute();
      const copied = await copiedBy(db, {
        jobId: job.id,
        personId: job.personId,
        documentId: job.documentId,
      });
      return {
        name: documentName(pages.map((p) => p.file_name)),
        saved: job.targets.filter((t) => copied.has(t)).length,
        of: job.targets.length,
        unreadable: job.targets.filter(
          (t) => copied.get(t)?.outcome === "unreadable",
        ).length,
      };
    },

    /**
     * Rufi's note for the AI on what its reply just copied: each finished
     * job's document, its pages copied and the pages that couldn't be read
     * or weren't looked at, from the stored page states, and what to do.
     * Undefined when none finished.
     */
    note: async (jobIds: readonly string[]): Promise<string | undefined> => {
      const lines: string[] = [];
      for (const id of jobIds) {
        const row = await db
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", id)
          .where("state", "=", "done")
          .executeTakeFirst();
        if (!row) continue;
        const job = jobOf(row);
        const pages = await db
          .selectFrom("document_pages")
          .select(["position", "file_name", "state"])
          .where("person_id", "=", job.personId)
          .where("document_id", "=", job.documentId)
          .orderBy("position")
          .execute();
        const targets = pages.filter((p) => job.targets.includes(p.position));
        const unreadable = targets
          .filter((p) => p.state === "unreadable")
          .map((p) => p.position);
        const notLooked = targets
          .filter((p) => p.state === "not_looked_at")
          .map((p) => p.position);
        const copied = targets.length - notLooked.length;
        lines.push(
          [
            `Rufi's reader copied ${documentName(pages.map((p) => p.file_name))} (document ${job.documentId}): ${job.targets.length === pages.length ? "" : `pages ${ranges(job.targets)}, `}${String(copied)} ${copied === 1 ? "page" : "pages"} copied.`,
            ...(unreadable.length > 0
              ? [`It couldn't read pages ${ranges(unreadable)}.`]
              : []),
            ...(notLooked.length > 0
              ? [`It didn't look at pages ${ranges(notLooked)}.`]
              : []),
          ].join(" "),
        );
      }
      if (lines.length === 0) return undefined;
      return [
        ...lines,
        "Not sorted yet: sort it as the sorting-documents skill says, then answer the user's message.",
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
