// get_overview: the active person's record at a glance, as printed.
import { sql } from "kysely";
import {
  currentRecords,
  RECORDS_SHOWN,
  recentSaves,
  SAVES_SHOWN,
} from "../record/read.ts";
import type { Store } from "../store/database.ts";
import { defineTool, NoInput, Refusal } from "./registry.ts";

/** Results shown at most; the description says the same number. */
export const RESULTS_SHOWN = 20;

export const getOverview = defineTool({
  name: "get_overview",
  shown: "Read your overview",
  description: `The active person's health record in Rufi at a glance: their name, how many documents and reports they have, their current test results exactly as printed (id, test, value, unit, reference range, flag, method or context, measured date at the precision known), their other records by kind (medicine uses, prescriptions, symptoms, conditions, allergies, care events, "none known" statements, follow-ups; each with its id and fields as save_changes takes them), and their latest saves with what each changed. At most ${String(RESULTS_SHOWN)} results, newest measured first, undated last; at most ${String(RECORDS_SHOWN)} records of a kind, newest first; the latest ${String(SAVES_SHOWN)} saves, newest first. An amended result replaces the one it corrects and says "amended": true. Removed records aren't shown. Takes no input: Rufi chooses the person, not you.`,
  input: NoInput,
  callers: "both",
  readOnly: true,
  destructive: false,
  examples: [{}],
  run: async (_input, { store, personId }) => {
    if (!store) return { note: "Rufi has no records yet." };
    const { query } = store;
    if (personId === undefined) {
      const people = await query
        .selectFrom("people")
        .select("display_name")
        .orderBy("display_name")
        .execute();
      if (people.length === 0) return { note: "Rufi has no people yet." };
      throw new Refusal(
        `No person is chosen in Rufi, so the record can't be read. Ask the user which person they mean: ${people.map((p) => p.display_name).join(", ")}.`,
      );
    }
    const overview = await readOverview(store, personId);
    if (!overview) throw new Refusal("The chosen person isn't in Rufi.");
    return {
      ...overview,
      record: await currentRecords(store, personId),
      latest_saves: await recentSaves(store, personId),
    };
  },
});

/**
 * The person's overview as the screens show it: their name, counts and
 * current results. Undefined when the person isn't in Rufi.
 */
export async function readOverview(store: Store, personId: string) {
  const { query } = store;
  const person = await query
    .selectFrom("people")
    .select(["id", "display_name"])
    .where("id", "=", personId)
    .executeTakeFirst();
  if (!person) return undefined;
  const count = async (table: "documents" | "reports" | "results") =>
    (
      await query
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("person_id", "=", person.id)
        .executeTakeFirstOrThrow()
    ).n;
  // Current: not removed, and no other result of this person replaces it.
  const current = query
    .selectFrom("results as r")
    .where("r.person_id", "=", person.id)
    .where("r.removed", "=", 0)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("results as n")
            .select("n.id")
            .whereRef("n.person_id", "=", "r.person_id")
            .whereRef("n.replaces_id", "=", "r.id"),
        ),
      ),
    );
  const replaced = (
    await query
      .selectFrom("results as r")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("r.person_id", "=", person.id)
      .where("r.removed", "=", 0)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("results as n")
            .select("n.id")
            .whereRef("n.person_id", "=", "r.person_id")
            .whereRef("n.replaces_id", "=", "r.id"),
        ),
      )
      .executeTakeFirstOrThrow()
  ).n;
  const currentCount = (
    await current
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow()
  ).n;
  const rows = await current
    .select([
      "r.id",
      "r.test_name",
      "r.value_text",
      "r.unit",
      "r.reference_range",
      "r.flag_text",
      "r.context_text",
      "r.measured_at",
      sql<number>`r.replaces_id IS NOT NULL`.as("amended"),
    ])
    .orderBy(sql`r.measured_at IS NULL`)
    .orderBy("r.measured_at", "desc")
    .orderBy("r.entered_at", "desc")
    .orderBy("r.id", "desc")
    .limit(RESULTS_SHOWN)
    .execute();

  return {
    person: person.display_name,
    documents: await count("documents"),
    reports: await count("reports"),
    results: currentCount,
    earlier_versions_kept: replaced,
    latest_results: rows.map((row) => ({
      id: row.id,
      test: row.test_name,
      value: row.value_text,
      ...(row.unit !== null && { unit: row.unit }),
      ...(row.reference_range !== null && { range: row.reference_range }),
      ...(row.flag_text !== null && { flag: row.flag_text }),
      ...(row.context_text !== null && { context: row.context_text }),
      ...(row.measured_at !== null && { measured: row.measured_at }),
      ...(row.amended === 1 && { amended: true }),
    })),
  };
}
