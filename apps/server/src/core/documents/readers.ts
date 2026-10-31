// Which agent reads a document. Rufi AI sets it (set_reader) after it starts
// a reader or hands one a document, and the document's row keeps only the
// agent's id. Whether the document is being read is worked out when asked:
// its agent is at work and hasn't saved a reading of it (the kept
// save_reading calls say so). One agent per document; one agent can read
// several.
import { Schema } from "effect";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Tables } from "../store/tables.ts";
import { Refusal, type Issue } from "../tools/registry.ts";
import { DELETED_DOCUMENT } from "./naming.ts";

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

export const SetReaderInput = Schema.Struct({
  documents: Schema.Array(
    Id.annotate({ description: "A document, by its id." }),
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(100))
    .annotate({ description: "The documents it reads." }),
  agent: Id.annotate({
    description:
      "The agent that reads them, by its id: from start_agent's answer, or agent_status.",
  }),
});
export type SetReaderInput = typeof SetReaderInput.Type;

/**
 * In `trx`: `agent` reads these documents of the person's, each one sent
 * and not deleted; refused with every problem, and nothing written,
 * otherwise. The caller checks that the agent is in its chat.
 */
export async function setReader(
  trx: Transaction<Tables>,
  personId: string,
  input: SetReaderInput,
) {
  const ids = [...new Set(input.documents)];
  const found = await trx
    .selectFrom("documents")
    .select(["id", "deleted_at", "sent_at"])
    .where("person_id", "=", personId)
    .where("id", "in", ids)
    .execute();
  const problems: Issue[] = input.documents.flatMap((id, index) => {
    const document = found.find((d) => d.id === id);
    const path = `documents.${String(index)}`;
    if (document?.deleted_at != null) {
      return [{ path, got: JSON.stringify(id), fix: DELETED_DOCUMENT }];
    }
    // Unsent, it waits in the chat box: not the AI's yet.
    if (!document || document.sent_at === null) {
      return [
        {
          path,
          got: JSON.stringify(id),
          fix: "There is no such document for this person: check its id with get_documents.",
        },
      ];
    }
    return [];
  });
  if (problems.length > 0) {
    throw new Refusal("Nothing was set. Fix these and try again.", problems);
  }
  await trx
    .updateTable("documents")
    .set({ reader_agent: input.agent })
    .where("person_id", "=", personId)
    .where("id", "in", ids)
    .execute();
  return { set: true, agent: input.agent, documents: ids };
}

/**
 * Each of these documents' reader, by document: its agent, and whether it
 * is reading the document now (`runs` says whether an agent is at work).
 */
export async function readersOf(
  db: Kysely<Tables> | Transaction<Tables>,
  personId: string,
  documentIds: readonly string[],
  runs: (agent: string) => boolean,
): Promise<Map<string, { agent: string; reading: boolean }>> {
  if (documentIds.length === 0) return new Map();
  const set = await db
    .selectFrom("documents")
    .select(["id", "reader_agent"])
    .where("person_id", "=", personId)
    .where("id", "in", [...documentIds])
    .where("reader_agent", "is not", null)
    .execute();
  const agents = [...new Set(set.map((d) => d.reader_agent ?? ""))];
  // The readings each agent saved: its kept save_reading calls.
  const saved =
    agents.length === 0
      ? []
      : await db
          .selectFrom("tool_calls")
          .select([
            "agent_id",
            sql<string | null>`json_extract(input, '$.document')`.as(
              "document",
            ),
          ])
          .where("person_id", "=", personId)
          .where("tool", "=", "save_reading")
          .where("ok", "=", 1)
          .where("agent_id", "in", agents)
          .execute();
  return new Map(
    set.map((d) => {
      const agent = d.reader_agent ?? "";
      const done = saved.some(
        (call) => call.agent_id === agent && call.document === d.id,
      );
      return [d.id, { agent, reading: !done && runs(agent) }];
    }),
  );
}
