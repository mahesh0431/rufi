// Reading documents: the jobs that read them, one at a time, and what a
// reading writes when it starts and when it ends. A job targets some pages
// of its document (all of them first; a retry only the pages that failed).
// Its runs write the reader's page copies (copies.ts); only a run whose
// reader turn completed normally finishes the job, in one transaction with
// its end line: page states, the document's version, the job done, and the
// request that asks Rufi AI to sort the pages (sorting.ts), which makes the
// drafts. A failed job keeps its copies; Retry continues it. Nothing here
// writes the record or decides what a page means. Rufi reads each
// document as it is added. Pages an older reader saved as notebook entries
// keep them, and are shown as they are.
import type { Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { Refusal } from "../tools/registry.ts";
import type { Checks, Entry, Run } from "./notebook.ts";
import { documentName, ranges } from "./naming.ts";
import { pagesOf, sortLine, sortNote } from "./sorting.ts";

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

/** A reading's end, as the chat shows it and the AI is told. */
export interface Ending {
  /** The chat's line. */
  line: string;
  /** Rufi's note that asks Rufi AI to sort the pages, when there are pages to sort. */
  ask: string | undefined;
  facts: {
    document: string;
    action: "open" | "retry";
    results: number;
    unsure: number;
  };
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

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

export function readings(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  const listeners = new Map<string, Set<() => void>>();
  const watchers = new Set<() => void>();

  /** Tells the person's screens, and the reader, that their readings changed. */
  const changed = (personId: string) => {
    for (const listener of listeners.get(personId) ?? []) listener();
    for (const watcher of watchers) watcher();
  };

  /** Queues a reading of `targets` of the document. */
  const queueIn = async (
    trx: Trx,
    personId: string,
    documentId: string,
    targets: readonly number[],
  ) => {
    await trx
      .insertInto("jobs")
      .values({
        id: uuid(),
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
   * The facts of a reading for its end line and, when it has pages to
   * sort, Rufi's note that asks Rufi AI to sort them. A reading that
   * copied nothing but unreadable pages has nothing to sort.
   */
  const ending = async (
    run: Pick<Run, "jobId" | "personId" | "documentId" | "targets">,
    failure?: string,
  ): Promise<Ending> => {
    const pages = await db
      .selectFrom("document_pages")
      .select(["position", "file_name"])
      .where("person_id", "=", run.personId)
      .where("document_id", "=", run.documentId)
      .orderBy("position")
      .execute();
    const files = pages.map((p) => p.file_name);
    const name = documentName(files);
    const copied = await copiedBy(db, run);
    const facts = { document: run.documentId, results: 0, unsure: 0 };
    if (failure !== undefined) {
      return {
        line: `Couldn't finish reading ${name} · ${failure} · read ${String(copied.size)} of ${String(run.targets.length)}`,
        ask: undefined,
        facts: { ...facts, action: "retry" },
      };
    }
    const unreadable = run.targets.filter(
      (t) => copied.get(t)?.outcome === "unreadable",
    );
    const notLooked = run.targets.filter((t) => !copied.has(t));
    const sortable = copied.size - unreadable.length;
    if (sortable === 0) {
      return {
        line: [
          `Couldn't read ${name}`,
          ...(unreadable.length > 0
            ? [`${plural(unreadable.length, "page")} couldn't be read`]
            : []),
          ...(notLooked.length > 0
            ? [`${plural(notLooked.length, "page")} not looked at`]
            : []),
        ].join(" · "),
        ask: undefined,
        facts: { ...facts, action: "retry" },
      };
    }
    return {
      line: sortLine({
        files,
        targets: run.targets,
        pages: pages.length,
        unreadable: unreadable.length,
        notLooked: notLooked.length,
      }),
      ask: sortNote({
        name,
        documentId: run.documentId,
        copied: copied.size,
        unreadable,
        notLooked,
      }),
      facts: { ...facts, action: "open" },
    };
  };

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

  return {
    changed,

    /** Listens to every change: the reader looks for work. */
    watch: (watcher: () => void) => {
      watchers.add(watcher);
    },

    /** Listens to one person's readings; returns the way to stop. */
    subscribe: (personId: string, listener: () => void) => {
      let set = listeners.get(personId);
      if (!set) listeners.set(personId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    /** Queues a reading of every page, inside an add's transaction. */
    queueNew: async (trx: Trx, personId: string, documentId: string) => {
      await queueIn(
        trx,
        personId,
        documentId,
        await positions(trx, personId, documentId),
      );
    },

    /**
     * Reads again what failed: a failed reading continues where it stopped
     * (with a fresh deadline); a finished one reads its unreadable and
     * not-looked-at pages in a new job, which never touches the drafts
     * already made; one never read is read in full. Returns the pages it
     * will read.
     */
    retry: async (personId: string, documentId: string) => {
      const targets = await db.transaction().execute(async (trx) => {
        const exists = await trx
          .selectFrom("documents")
          .select("id")
          .where("person_id", "=", personId)
          .where("id", "=", documentId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (!exists)
          throw new Refusal("There is no such document for this person.");
        const job = await readingOf(trx, personId, documentId);
        if (!job) {
          // Never read (added before Rufi read each document as it came).
          const all = await positions(trx, personId, documentId);
          await queueIn(trx, personId, documentId, all);
          return all;
        }
        if (job.state === "queued" || job.state === "running") {
          throw new Refusal("This document is being read now.");
        }
        if (job.state === "failed" && job.documentId === documentId) {
          await trx
            .updateTable("jobs")
            .set({
              state: "queued",
              error: null,
              ended_at: null,
              retries: 0,
              retry_at: null,
            })
            .where("id", "=", job.id)
            .execute();
          return job.targets;
        }
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
        if (failed.length === 0) {
          throw new Refusal(
            "Every page of this document was read; nothing to read again.",
          );
        }
        await queueIn(trx, personId, documentId, failed);
        return failed;
      });
      changed(personId);
      return targets;
    },

    /** At start: readings Rufi stopped in the middle are queued again. */
    recover: async () => {
      const rows = await db
        .updateTable("jobs")
        .set({ state: "queued" })
        .where("state", "=", "running")
        .returning("person_id")
        .execute();
      return rows.length;
    },

    /**
     * The next reading to run, oldest first. An automatic retry waits
     * until its time; `wake` is the earliest such time.
     */
    next: async (): Promise<{
      job: Job | undefined;
      wake: string | undefined;
    }> => {
      const rows = await db
        .selectFrom("jobs")
        .selectAll()
        .where("state", "=", "queued")
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const at = now();
      const jobs = rows.map(jobOf);
      const job = jobs.find((j) => j.retryAt === null || j.retryAt <= at);
      const wake = jobs
        .map((j) => j.retryAt)
        .filter((w): w is string => w !== null && w > at)
        .sort((a, b) => a.localeCompare(b))[0];
      return { job, wake };
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

    /** The start line of a job's first real start. */
    startLine: async (job: Job) => {
      const pages = await db
        .selectFrom("document_pages")
        .select("file_name")
        .where("person_id", "=", job.personId)
        .where("document_id", "=", job.documentId)
        .orderBy("position")
        .execute();
      const name = documentName(pages.map((p) => p.file_name));
      return job.targets.length === pages.length
        ? `Reading ${name} · ${plural(pages.length, "page")}`
        : `Reading ${name} again · ${job.targets.length === 1 ? "page" : "pages"} ${ranges(job.targets)}`;
    },

    /**
     * Starts a run of a queued job: running, the next attempt. Returns the
     * run, bound to it. Inside the start line's transaction on a first start.
     */
    begin: (trx: Trx, job: Job) => begin(trx, job),

    /** Starts a run that has no start line (the job started before). */
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

    ending,

    /**
     * A reading's end that failed, inside its end line's transaction: the
     * job failed, its entries kept, no drafts.
     */
    fail: async (trx: Trx, run: Run, error: string) => {
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
    },

    /**
     * A reading's normal end, inside its end line's transaction, once per
     * job: each target's state (its copy's outcome, or not looked at), the
     * document's version raised, the job done. A reading with nothing to
     * sort (`sorts` false: only unreadable pages) is sorted as it ends.
     * Draft items come from Rufi AI's sort (sorting.ts), never from here.
     */
    finish: async (trx: Trx, run: Run, sorts: boolean) => {
      const at = now();
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
      const copied = await copiedBy(trx, run);
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
    },

    /** The person's readings that wait or run, for the strip above the box. */
    strip: async (personId: string) => {
      const jobs = await db
        .selectFrom("jobs")
        .selectAll()
        .where("person_id", "=", personId)
        .where("state", "in", ["queued", "running"])
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const list = [];
      for (const row of jobs) {
        const job = jobOf(row);
        const pages = await db
          .selectFrom("document_pages")
          .select(["position", "file_name", "entry_job_id"])
          .where("person_id", "=", personId)
          .where("document_id", "=", job.documentId)
          .orderBy("position")
          .execute();
        list.push({
          documentId: job.documentId,
          name: documentName(pages.map((p) => p.file_name)),
          state:
            job.state === "running"
              ? ("running" as const)
              : ("waiting" as const),
          again: job.state === "running" ? job.attempt > 1 : job.attempt > 0,
          saved: pages.filter(
            (p) =>
              p.entry_job_id === job.id && job.targets.includes(p.position),
          ).length,
          of: job.targets.length,
          runAt: job.state === "running" ? row.run_at : null,
        });
      }
      return list;
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
