// Reading documents: the jobs that read them, one at a time, and what a
// reading writes when it starts and when it ends. A job targets some pages
// of its document (all of them first; a retry only the pages that failed).
// Its runs write the notebook (notebook.ts); only a run whose reader turn
// completed normally finishes the job, in one transaction with its end
// line: page states, the draft items from this job's entries, the
// document's kind, date and version, and the job done. A failed job keeps
// its entries and makes no drafts; Retry continues it. Nothing here writes
// the record. Rufi reads documents only after the person's yes.
import type { Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { Refusal } from "../tools/registry.ts";
import type { Checks, Entry, Run } from "./notebook.ts";

/** The setting that holds the person's yes: "yes" or "no"; none: not asked yet. */
const CONSENT = "read_documents";

export type Consent = "yes" | "no" | null;

/** No yes yet: nothing is sent to the AI. */
export class NeedsYes extends Error {
  constructor() {
    super(
      "Rufi needs your yes before it sends a document's pages to the AI to read them.",
    );
  }
}

export interface Job {
  id: string;
  personId: string;
  documentId: string;
  state: "queued" | "running" | "done" | "failed";
  attempt: number;
  targets: number[];
  waiting: "sign_in" | "usage_limit" | null;
  waitUntil: string | null;
  retried: boolean;
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
  /** Rufi's note for the AI, only when something needs the person. */
  ask: string | undefined;
  facts: {
    document: string;
    action: "open" | "retry";
    results: number;
    unsure: number;
  };
}

type Trx = Transaction<Tables>;

const jobOf = (row: Tables["jobs"]): Job => ({
  id: row.id,
  personId: row.person_id,
  documentId: row.document_id,
  state: row.state as Job["state"],
  attempt: row.attempt,
  targets: JSON.parse(row.targets) as number[],
  waiting: row.waiting as Job["waiting"],
  waitUntil: row.wait_until,
  retried: row.retried === 1,
  startedAt: row.started_at,
});

/** A document's name for a person: its file, or "3 photos". */
function documentName(files: readonly string[]): string {
  const distinct = [...new Set(files)];
  if (distinct.length <= 1) return distinct[0] ?? "A document";
  return `${String(distinct.length)} photos`;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** "12 Aug", "Aug 2025", "2024": a precision date in the line's words. */
function shortDate(iso: string, today: string): string {
  const [year = "", month, day] = iso.split("-");
  const name = month === undefined ? undefined : MONTHS[Number(month) - 1];
  if (name === undefined) return year;
  const thisYear = today.slice(0, 4) === year;
  if (day === undefined) return `${name} ${year}`;
  return `${String(Number(day))} ${name}${thisYear ? "" : ` ${year}`}`;
}

const KIND_WORDS = {
  lab_report: "Lab report",
  prescription: "Prescription",
  letter: "Letter",
  other: "Document",
} as const;

/** The value every page that states one agrees on; undefined otherwise. */
function agreed<T>(values: readonly (T | undefined)[]): T | undefined {
  const stated = values.filter((v) => v !== undefined);
  const [first] = stated;
  return stated.every((v) => v === first) ? first : undefined;
}

/** Whether a printed name could be the person's: the words of one hold the other's. */
function sameName(printed: string, person: string): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length > 1),
    );
  const a = words(printed);
  const b = words(person);
  if (a.size === 0) return true;
  return [...a].every((w) => b.has(w)) || [...b].every((w) => a.has(w));
}

/** A page's first printed date: the collection date when there is one. */
const firstDate = (entry: Entry) => entry.facts?.dates?.[0];

/** Pages as "1–4, 6". */
export function ranges(positions: readonly number[]): string {
  const parts: [number, number][] = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    if (last && last[1] === p - 1) last[1] = p;
    else parts.push([p, p]);
  }
  return parts
    .map(([a, b]) => (a === b ? String(a) : `${String(a)}–${String(b)}`))
    .join(", ");
}

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

  const consent = async (): Promise<Consent> => {
    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", CONSENT)
      .executeTakeFirst();
    return row?.value === "yes" || row?.value === "no" ? row.value : null;
  };

  const saveConsent = (trx: Trx, value: "yes" | "no") =>
    trx
      .insertInto("settings")
      .values({ key: CONSENT, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();

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
        retried: 0,
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

  /** The document's latest job, if it has one. */
  const latestJob = async (
    trx: Trx | Store["query"],
    personId: string,
    documentId: string,
  ) => {
    const row = await trx
      .selectFrom("jobs")
      .selectAll()
      .where("person_id", "=", personId)
      .where("document_id", "=", documentId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row && jobOf(row);
  };

  /** The facts of a reading for its end line and its note for the AI. */
  const ending = async (
    run: Pick<Run, "jobId" | "personId" | "documentId" | "targets">,
    failure?: string,
  ): Promise<Ending> => {
    const pages = await db
      .selectFrom("document_pages")
      .select([
        "position",
        "file_name",
        "entry",
        "entry_job_id",
        "entry_checks",
        "state",
      ])
      .where("person_id", "=", run.personId)
      .where("document_id", "=", run.documentId)
      .orderBy("position")
      .execute();
    const name = documentName(pages.map((p) => p.file_name));
    const targets = new Set(run.targets);
    const mine = pages.filter(
      (p) => targets.has(p.position) && p.entry_job_id === run.jobId && p.entry,
    );
    const facts = (results: number, unsure: number) => ({
      document: run.documentId,
      results,
      unsure,
    });
    if (failure !== undefined) {
      return {
        line: `Couldn't finish reading ${name} · ${failure} · saved ${String(mine.length)} of ${String(targets.size)}`,
        ask: undefined,
        facts: { ...facts(0, 0), action: "retry" },
      };
    }
    const entries = mine.map((p) => ({
      position: p.position,
      entry: JSON.parse(p.entry ?? "{}") as Entry,
      checks: JSON.parse(p.entry_checks ?? '{"items":[]}') as Checks,
    }));
    // The whole document's pages for its kind and dates: those read before
    // (a retry reads only some) and this job's.
    const all = pages
      .filter((p) => p.entry && (p.state !== null || targets.has(p.position)))
      .map((p) => JSON.parse(p.entry ?? "{}") as Entry);
    const results = entries.reduce(
      (n, e) => n + (e.entry.outcome === "read" ? e.entry.items.length : 0),
      0,
    );
    const unsureItems = entries.flatMap(({ position, entry, checks }) =>
      entry.outcome !== "read"
        ? []
        : entry.items.flatMap((item, index) => {
            const flagged = checks.items.find((c) => c.item === index + 1);
            const why = [item.unsure, flagged?.why].filter(
              (w) => w !== undefined,
            );
            return why.length === 0
              ? []
              : [
                  `page ${String(position)}: ${item.test_name} "${item.value_text}" (${why.join("; ")})`,
                ];
          }),
    );
    const unreadable = entries.filter((e) => e.entry.outcome === "unreadable");
    const notLooked = run.targets.filter(
      (t) => !entries.some((e) => e.position === t),
    );
    const incomplete = entries.filter((e) => e.checks.incomplete);
    const issues = entries.flatMap(({ position, entry }) =>
      (entry.issues ?? []).map((i) => `page ${String(position)}: ${i}`),
    );
    const person = await db
      .selectFrom("people")
      .select("display_name")
      .where("id", "=", run.personId)
      .executeTakeFirst();
    const names = [
      ...new Set(
        all.flatMap((e) => (e.facts?.name === undefined ? [] : [e.facts.name])),
      ),
    ];
    const otherNames = names.filter(
      (n) => !sameName(n, person?.display_name ?? ""),
    );

    // The line: what it is, when, what was read, what needs a look.
    const kind = agreed(all.map((e) => e.facts?.kind));
    const dates = all.map((e) => {
      const date = firstDate(e);
      return date?.iso ?? date?.date;
    });
    const date = agreed(dates);
    const distinctDates = new Set(dates.filter((d) => d !== undefined));
    const reports = new Set(
      all.map((e) =>
        JSON.stringify([
          e.facts?.issuer,
          e.facts?.report_number,
          firstDate(e)?.iso ?? firstDate(e)?.date,
        ]),
      ),
    );
    const today = now();
    const head =
      distinctDates.size > 1
        ? `${reports.size > 1 ? plural(reports.size, "report") : name} · ${plural(distinctDates.size, "date")}`
        : [
            kind === undefined ? name : KIND_WORDS[kind],
            ...(date === undefined
              ? []
              : [/^\d{4}/.test(date) ? shortDate(date, today) : date]),
          ].join(" · ");
    const retry = pages.length !== run.targets.length;
    const parts = [
      retry
        ? `${head} · ${run.targets.length === 1 ? "page" : "pages"} ${ranges(run.targets)} read again`
        : head,
      results === 0 ? "no results read" : `${plural(results, "result")} read`,
      ...(unsureItems.length > 0
        ? [`${String(unsureItems.length)} to check`]
        : []),
      ...(unreadable.length > 0
        ? [`${plural(unreadable.length, "page")} couldn't be read`]
        : []),
      ...(notLooked.length > 0
        ? [`${plural(notLooked.length, "page")} not looked at`]
        : []),
      ...(incomplete.length > 0
        ? [`${plural(incomplete.length, "page")} may be incomplete`]
        : []),
    ];

    // The note for the AI: only when something needs the person.
    const needs = [
      ...unsureItems.map((u) => `unsure: ${u}`),
      ...unreadable.map(
        (e) =>
          `page ${String(e.position)} couldn't be read${e.entry.why === undefined ? "" : ` (${e.entry.why})`}`,
      ),
      ...(notLooked.length > 0
        ? [`pages ${ranges(notLooked)} weren't looked at`]
        : []),
      ...incomplete.map(
        (e) =>
          `page ${String(e.position)} may be incomplete: ${String(e.checks.incomplete?.rows_seen)} rows seen, ${String(e.checks.incomplete?.items)} read`,
      ),
      ...issues.map((i) => `the reader noted: ${i}`),
      ...otherNames.map((n) => `the name on the report is "${n}"`),
    ];
    const ask =
      needs.length === 0
        ? undefined
        : [
            `A document reading finished: ${name} (document ${run.documentId}), ${plural(results, "draft item")} read, not saved.`,
            "What needs the user:",
            ...needs.map((n) => `- ${n}`),
            "Read the document with get_documents if you need to, then tell the user in a few lines and ask what it needs. Don't save anything.",
          ].join("\n");
    return {
      line: parts.join(" · "),
      ask,
      facts: { ...facts(results, unsureItems.length), action: "open" },
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
        waiting: null,
        wait_until: null,
      })
      .where("id", "=", job.id)
      .where("state", "=", "queued")
      .where("attempt", "=", job.attempt)
      .executeTakeFirst();
    if (started.numUpdatedRows !== 1n) {
      throw new Error("The reading changed before it started.");
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

  return {
    consent,
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

    /** Queues a reading of every page, inside an add's transaction, after the yes. */
    queueNew: async (trx: Trx, personId: string, documentId: string) => {
      const row = await trx
        .selectFrom("settings")
        .select("value")
        .where("key", "=", CONSENT)
        .executeTakeFirst();
      if (row?.value !== "yes") return;
      await queueIn(
        trx,
        personId,
        documentId,
        await positions(trx, personId, documentId),
      );
    },

    /**
     * The person's yes or no. A no stops what hasn't started: those
     * documents are not read yet again; a running reading finishes.
     */
    setConsent: async (value: "yes" | "no") => {
      const stopped = await db.transaction().execute(async (trx) => {
        await saveConsent(trx, value);
        if (value === "yes") return [];
        return trx
          .deleteFrom("jobs")
          .where("state", "=", "queued")
          .where("attempt", "=", 0)
          .returning("person_id")
          .execute();
      });
      for (const { person_id } of stopped) changed(person_id);
    },

    /**
     * Reads documents never read: `documentId`, or all of the person's.
     * `yes`: the person said yes just now. Without a yes: NeedsYes.
     */
    readIt: async (
      personId: string,
      documentId: string | undefined,
      yes: boolean,
    ) => {
      const queued = await db.transaction().execute(async (trx) => {
        if (yes) await saveConsent(trx, "yes");
        else {
          const row = await trx
            .selectFrom("settings")
            .select("value")
            .where("key", "=", CONSENT)
            .executeTakeFirst();
          if (row?.value !== "yes") throw new NeedsYes();
        }
        let query = trx
          .selectFrom("documents as d")
          .select("d.id")
          .where("d.person_id", "=", personId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("jobs as j")
                  .select("j.id")
                  .whereRef("j.person_id", "=", "d.person_id")
                  .whereRef("j.document_id", "=", "d.id"),
              ),
            ),
          );
        if (documentId !== undefined)
          query = query.where("d.id", "=", documentId);
        const unread = await query.execute();
        if (documentId !== undefined && unread.length === 0) {
          throw new Refusal(
            "This document is already read or being read. Use Retry for pages that failed.",
          );
        }
        for (const { id } of unread) {
          await queueIn(trx, personId, id, await positions(trx, personId, id));
        }
        return unread.length;
      });
      changed(personId);
      return queued;
    },

    /**
     * Reads again what failed: a failed reading continues where it stopped
     * (with a fresh deadline); a finished one reads its unreadable and
     * not-looked-at pages in a new job, which never touches the drafts
     * already made. Returns the pages it will read.
     */
    retry: async (personId: string, documentId: string) => {
      const targets = await db.transaction().execute(async (trx) => {
        const exists = await trx
          .selectFrom("documents")
          .select("id")
          .where("person_id", "=", personId)
          .where("id", "=", documentId)
          .executeTakeFirst();
        if (!exists)
          throw new Refusal("There is no such document for this person.");
        const job = await latestJob(trx, personId, documentId);
        if (!job) {
          throw new Refusal("This document isn't read yet: use Read it.");
        }
        if (job.state === "queued" || job.state === "running") {
          throw new Refusal("This document is being read now.");
        }
        if (job.state === "failed") {
          await trx
            .updateTable("jobs")
            .set({
              state: "queued",
              error: null,
              ended_at: null,
              retried: 0,
              waiting: null,
              wait_until: null,
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
     * The next reading to run, oldest first: none without the yes. A job
     * waiting for a usage limit waits until its time; `wake` is the
     * earliest such time.
     */
    next: async (): Promise<{
      job: Job | undefined;
      wake: string | undefined;
    }> => {
      if ((await consent()) !== "yes")
        return { job: undefined, wake: undefined };
      const rows = await db
        .selectFrom("jobs")
        .selectAll()
        .where("state", "=", "queued")
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const at = now();
      const jobs = rows.map(jobOf);
      const job = jobs.find((j) => j.waitUntil === null || j.waitUntil <= at);
      const wake = jobs
        .map((j) => j.waitUntil)
        .filter((w): w is string => w !== null && w > at)
        .sort((a, b) => a.localeCompare(b))[0];
      return { job, wake };
    },

    /** Whether every target of the job has an entry from it. */
    allSaved: async (job: Job) => {
      const rows = await db
        .selectFrom("document_pages")
        .select("position")
        .where("person_id", "=", job.personId)
        .where("document_id", "=", job.documentId)
        .where("entry_job_id", "=", job.id)
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

    /** What a run's reader is told: the document's pages, what it saved, its note. */
    about: async (run: Run) => {
      const pages = await db
        .selectFrom("document_pages")
        .select(["position", "file_name", "entry_job_id"])
        .where("person_id", "=", run.personId)
        .where("document_id", "=", run.documentId)
        .orderBy("position")
        .execute();
      const note = await db
        .selectFrom("documents")
        .select("reader_note")
        .where("person_id", "=", run.personId)
        .where("id", "=", run.documentId)
        .executeTakeFirst();
      return {
        pages: pages.length,
        files: pages.map((p) => p.file_name),
        targets: run.targets,
        saved: pages
          .filter(
            (p) =>
              p.entry_job_id === run.jobId && run.targets.includes(p.position),
          )
          .map((p) => p.position),
        note: note?.reader_note ?? null,
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
     * A run that didn't finish goes back to the queue: to wait (for the
     * sign-in, or until a usage limit resets), or as its one automatic retry.
     */
    requeue: async (
      run: Run,
      how:
        | { waiting: "sign_in" }
        | { waiting: "usage_limit"; until: string }
        | { retry: true },
    ) => {
      await db
        .updateTable("jobs")
        .set(
          "retry" in how
            ? { state: "queued", retried: 1 }
            : {
                state: "queued",
                waiting: how.waiting,
                wait_until: how.waiting === "usage_limit" ? how.until : null,
              },
        )
        .where("id", "=", run.jobId)
        .where("state", "=", "running")
        .where("attempt", "=", run.attempt)
        .execute();
      changed(run.personId);
    },

    /** A queued job waits for the sign-in before it runs. */
    waitForSignIn: async (job: Job) => {
      if (job.waiting === "sign_in") return;
      await db
        .updateTable("jobs")
        .set({ waiting: "sign_in" })
        .where("id", "=", job.id)
        .where("state", "=", "queued")
        .execute();
      changed(job.personId);
    },

    ending,

    /**
     * A reading's end that failed, inside its end line's transaction: the
     * job failed, its entries kept, no drafts.
     */
    fail: async (trx: Trx, run: Run, error: string) => {
      const ended = await trx
        .updateTable("jobs")
        .set({ state: "failed", error, ended_at: now() })
        .where("id", "=", run.jobId)
        .where("state", "=", "running")
        .where("attempt", "=", run.attempt)
        .executeTakeFirst();
      if (ended.numUpdatedRows !== 1n) {
        throw new Error("The reading isn't running any more.");
      }
    },

    /**
     * A reading's normal end, inside its end line's transaction, once per
     * job: each target's state (its entry's outcome, or not looked at),
     * draft items from this job's entries, the document's kind and date
     * when every page agrees, its version raised, the job done.
     */
    finish: async (trx: Trx, run: Run) => {
      const at = now();
      const ended = await trx
        .updateTable("jobs")
        .set({ state: "done", ended_at: at, error: null })
        .where("id", "=", run.jobId)
        .where("state", "=", "running")
        .where("attempt", "=", run.attempt)
        .executeTakeFirst();
      if (ended.numUpdatedRows !== 1n) {
        throw new Error("The reading isn't running any more.");
      }
      const pages = await trx
        .selectFrom("document_pages")
        .select(["position", "entry", "entry_job_id", "entry_checks", "state"])
        .where("person_id", "=", run.personId)
        .where("document_id", "=", run.documentId)
        .orderBy("position")
        .execute();
      for (const target of run.targets) {
        const page = pages.find((p) => p.position === target);
        if (!page) continue;
        const entry =
          page.entry_job_id === run.jobId && page.entry
            ? (JSON.parse(page.entry) as Entry)
            : undefined;
        const checks = JSON.parse(
          page.entry_checks ?? '{"items":[]}',
        ) as Checks;
        page.state = entry?.outcome ?? "not_looked_at";
        await trx
          .updateTable("document_pages")
          .set({
            state: page.state,
            state_why:
              entry?.outcome === "unreadable" ? (entry.why ?? null) : null,
          })
          .where("person_id", "=", run.personId)
          .where("document_id", "=", run.documentId)
          .where("position", "=", target)
          .execute();
        if (entry?.outcome !== "read") continue;
        for (const [index, item] of entry.items.entries()) {
          const { unsure, ...fields } = item;
          const flagged = checks.items.find((c) => c.item === index + 1);
          await trx
            .insertInto("draft_items")
            .values({
              id: uuid(),
              person_id: run.personId,
              document_id: run.documentId,
              page: target,
              seq: index + 1,
              job_id: run.jobId,
              kind: "lab_result",
              version: 1,
              status: "pending",
              fields: JSON.stringify(fields),
              original: JSON.stringify(item),
              unsure: JSON.stringify(
                [unsure, flagged?.why].filter((w) => w !== undefined),
              ),
              created_at: at,
            })
            .execute();
        }
      }
      // The document's kind and date: only when every page read agrees.
      const read = pages
        .filter((p) => p.state !== null && p.entry)
        .map((p) => JSON.parse(p.entry ?? "{}") as Entry);
      const kind = agreed(read.map((e) => e.facts?.kind));
      const date = agreed(read.map((e) => firstDate(e)?.iso));
      await trx
        .updateTable("documents")
        .set((eb) => ({
          kind: kind ?? null,
          date: date ?? null,
          version: eb("version", "+", 1),
        }))
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
      const off = (await consent()) !== "yes";
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
          waiting:
            off && job.state === "queued"
              ? ("turned_off" as const)
              : job.waiting,
          waitUntil: job.waitUntil,
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
     */
    statuses: async (personId: string) => {
      const jobs = await db
        .selectFrom("jobs")
        .selectAll()
        .where("person_id", "=", personId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const pages = await db
        .selectFrom("document_pages")
        .select(["document_id", "position", "entry_job_id", "state"])
        .where("person_id", "=", personId)
        .execute();
      const drafts = await db
        .selectFrom("draft_items")
        .select(["document_id", "status", "unsure"])
        .where("person_id", "=", personId)
        .execute();
      const statuses = new Map<
        string,
        {
          status: "reading" | "done" | "failed";
          saved: number;
          of: number;
          results: number;
          toCheck: number;
          canRetry: boolean;
          error: string | null;
        }
      >();
      for (const row of jobs) {
        const job = jobOf(row);
        const mine = pages.filter((p) => p.document_id === job.documentId);
        const pending = drafts.filter(
          (d) => d.document_id === job.documentId && d.status === "pending",
        );
        statuses.set(job.documentId, {
          status:
            job.state === "queued" || job.state === "running"
              ? "reading"
              : job.state,
          saved: mine.filter(
            (p) =>
              p.entry_job_id === job.id && job.targets.includes(p.position),
          ).length,
          of: job.targets.length,
          results: pending.length,
          toCheck: pending.filter((d) => d.unsure !== "[]").length,
          canRetry:
            job.state === "failed" ||
            (job.state === "done" &&
              mine.some(
                (p) => p.state === "unreadable" || p.state === "not_looked_at",
              )),
          error: row.error,
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
        .executeTakeFirst();
      if (!document) return undefined;
      const job = await latestJob(db, personId, documentId);
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
              (p) =>
                p.entry_job_id === job.id && job.targets.includes(p.position),
            ).length
          : 0,
        of: job?.targets.length ?? pages.length,
        runAt: job?.state === "running" ? (row?.run_at ?? null) : null,
        error: row?.error ?? null,
        note: document.reader_note,
        pages: pages.map((p) => ({
          position: p.position,
          state: p.state,
          why: p.state_why,
          entry: p.entry ? (JSON.parse(p.entry) as Entry) : null,
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
