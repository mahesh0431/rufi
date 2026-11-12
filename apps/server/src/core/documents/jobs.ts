// A task Rufi AI hands to an agent: one `jobs` row per hand-off. Only
// document_read now: some pages of a document, given to an agent with
// start_agent or send_agent. The job is the hand-off's, not the agent's: a
// save_reading from the agent or any agent below it counts for it, and an
// agent below it given the same document opens no job of its own. Code
// only records here, as a side effect of steps that happen anyway; a job's
// state never starts, orders or refuses an AI step.
//
//   working ── every page it asked for saved ──► done
//      └────── its agent and everything below it stopped, pages unsaved ──► ended (why)
//
// Every move is a guarded update from working, in the transaction of the
// step that caused it.
import { Schema } from "effect";
import type { Kysely, Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Tables } from "../store/tables.ts";
import { Refusal, type Issue } from "../tools/registry.ts";
import { DELETED_DOCUMENT, ranges } from "./naming.ts";
import { finishIn } from "./reading.ts";

type Db = Kysely<Tables> | Transaction<Tables>;

/** Why a job ended without every page it asked for saved. */
export type EndedWhy =
  | "not_started"
  | "no_save"
  | "stopped"
  | "failed"
  | "agent_lost"
  | "deleted";

/** A working document_read job. */
export interface Working {
  id: string;
  personId: string;
  agent: string;
  /** The call that handed it over; null when a save made it. */
  call: string | null;
  documentId: string;
  targets: number[];
}

/** The documents an agent is given to read, as start_agent and send_agent take them. */
export const HandOffInput = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
    ).annotate({ description: "A document, by its id from get_documents." }),
    pages: Schema.optionalKey(
      Schema.Array(Schema.Int.check(Schema.isGreaterThan(0)))
        .check(Schema.isMinLength(1))
        .annotate({
          description:
            "The pages it reads, as get_documents numbers them. Leave it out for every page.",
        }),
    ),
  }),
)
  .check(Schema.isMinLength(1), Schema.isMaxLength(100))
  .annotate({
    description:
      "The documents it reads, when its task is reading: each shows as Reading while it, or an agent it starts, reads it, until their pages are saved or they stop.",
  });
export type HandOffInput = typeof HandOffInput.Type;

/** A document and the pages a hand-off gives. */
export interface HandOff {
  documentId: string;
  pages: number[];
}

/**
 * The hand-offs of these documents of the person's, each sent, not
 * deleted, with pages it has; refused with every problem otherwise. Writes
 * nothing.
 */
export async function handOffsOf(
  db: Db,
  personId: string,
  documents: HandOffInput,
): Promise<HandOff[]> {
  const ids = [...new Set(documents.map((d) => d.id))];
  const found = await db
    .selectFrom("documents")
    .select(["id", "deleted_at", "sent_at"])
    .where("person_id", "=", personId)
    .where("id", "in", ids)
    .execute();
  const pages = await db
    .selectFrom("document_pages")
    .select(["document_id", "position"])
    .where("person_id", "=", personId)
    .where("document_id", "in", ids)
    .where("file_id", "is not", null)
    .orderBy("position")
    .execute();
  const problems: Issue[] = [];
  const handOffs: HandOff[] = [];
  for (const [index, given] of documents.entries()) {
    const path = `documents.${String(index)}`;
    const document = found.find((d) => d.id === given.id);
    if (document?.deleted_at != null) {
      problems.push({
        path,
        got: JSON.stringify(given.id),
        fix: DELETED_DOCUMENT,
      });
      continue;
    }
    // Unsent, it waits in the chat box: not the AI's yet.
    if (!document || document.sent_at === null) {
      problems.push({
        path,
        got: JSON.stringify(given.id),
        fix: "There is no such document for this person: check its id with get_documents.",
      });
      continue;
    }
    const has = pages
      .filter((p) => p.document_id === given.id)
      .map((p) => p.position);
    const wrong = (given.pages ?? []).filter((page) => !has.includes(page));
    if (wrong.length > 0) {
      problems.push({
        path: `${path}.pages`,
        got: JSON.stringify(wrong),
        fix: `This document has no page ${ranges(wrong)}; its pages are ${ranges(has)}.`,
      });
      continue;
    }
    handOffs.push({
      documentId: given.id,
      pages: [...new Set(given.pages ?? has)].sort((a, b) => a - b),
    });
  }
  if (problems.length > 0) {
    throw new Refusal("Nothing was sent. Fix these and try again.", problems);
  }
  return handOffs;
}

const workingOf = (row: {
  id: string;
  person_id: string;
  agent_id: string | null;
  call_id: string | null;
  document_id: string | null;
  targets: string | null;
}): Working => ({
  id: row.id,
  personId: row.person_id,
  agent: row.agent_id ?? "",
  call: row.call_id,
  documentId: row.document_id ?? "",
  targets: JSON.parse(row.targets ?? "[]") as number[],
});

/** The working document_read jobs of these agents; of the person's document, when given. */
export async function working(
  db: Db,
  agents: readonly string[],
  document?: { personId: string; documentId: string },
): Promise<Working[]> {
  if (agents.length === 0) return [];
  let query = db
    .selectFrom("jobs")
    .select([
      "id",
      "person_id",
      "agent_id",
      "call_id",
      "document_id",
      "targets",
    ])
    .where("kind", "=", "document_read")
    .where("state", "=", "working")
    .where("agent_id", "in", [...agents]);
  if (document) {
    query = query
      .where("person_id", "=", document.personId)
      .where("document_id", "=", document.documentId);
  }
  return (await query.orderBy("created_at").execute()).map(workingOf);
}

/**
 * In `trx`: `agent` is given these documents' pages by the call `call` of
 * the agent whose line is `caller` (the caller, then its parent, up to
 * Rufi AI): a job opens for each, one per hand-off, also a second one to
 * an agent still working on the document. A caller inside a working job on
 * a document hands on part of that job: nothing is opened.
 */
export async function openJobs(
  trx: Transaction<Tables>,
  personId: string,
  hand: {
    agent: string;
    caller: readonly string[];
    call: string;
    handOffs: HandOff[];
  },
  at: string,
) {
  for (const { documentId, pages } of hand.handOffs) {
    const document = { personId, documentId };
    if ((await working(trx, hand.caller, document)).length > 0) continue;
    await trx
      .insertInto("jobs")
      .values({
        id: uuid(),
        person_id: personId,
        kind: "document_read",
        agent_id: hand.agent,
        call_id: hand.call,
        state: "working",
        document_id: documentId,
        targets: JSON.stringify(pages),
        started_at: at,
        created_at: at,
      })
      .execute();
  }
}

/**
 * The working job a save of the document by the agent whose line is
 * `line` (the agent, then its parent, up) counts for: the nearest agent's,
 * and of its hand-offs the oldest whose message it has taken (`taken`), so
 * a hand-off still waiting in its queue stays open; the oldest when none
 * is taken.
 */
export async function jobFor(
  db: Db,
  personId: string,
  documentId: string,
  line: readonly string[],
  taken: (call: string) => boolean = () => true,
): Promise<Working | undefined> {
  const open = await working(db, line, { personId, documentId });
  for (const agent of line) {
    const mine = open.filter((job) => job.agent === agent);
    const found =
      mine.find((job) => job.call === null || taken(job.call)) ?? mine[0];
    if (found) return found;
  }
  return undefined;
}

/** In `trx`: the job ends with why; its pages as its copies say (reading.ts). */
export async function endJob(
  trx: Transaction<Tables>,
  job: Working,
  why: EndedWhy,
  at: string,
) {
  await finishIn(
    trx,
    {
      jobId: job.id,
      personId: job.personId,
      documentId: job.documentId,
      targets: job.targets,
    },
    at,
    why,
  );
}

/**
 * In `trx`: every working job of these agents ends with why, all of them
 * when none are given. Answers the people whose documents changed.
 */
export async function endAll(
  trx: Transaction<Tables>,
  why: EndedWhy,
  at: string,
  agents?: readonly string[],
): Promise<string[]> {
  let query = trx
    .selectFrom("jobs")
    .select([
      "id",
      "person_id",
      "agent_id",
      "call_id",
      "document_id",
      "targets",
    ])
    .where("kind", "=", "document_read")
    .where("state", "=", "working");
  if (agents) {
    if (agents.length === 0) return [];
    query = query.where("agent_id", "in", [...agents]);
  }
  const jobs = (await query.execute()).map(workingOf);
  for (const job of jobs) await endJob(trx, job, why, at);
  return [...new Set(jobs.map((job) => job.personId))];
}

/**
 * In `trx`: the working jobs on these documents of the person's end as
 * deleted, as the documents go (delete.ts). Their pages go with them.
 */
export async function endDeleted(
  trx: Transaction<Tables>,
  personId: string,
  documentIds: readonly string[],
  at: string,
) {
  await trx
    .updateTable("jobs")
    .set({ state: "ended", ended_why: "deleted", ended_at: at })
    .where("person_id", "=", personId)
    .where("document_id", "in", [...documentIds])
    .where("state", "=", "working")
    .execute();
}
