// get_overview: the active person's record at a glance, as printed.
import { z } from "zod";
import { defineTool, Refusal } from "./registry.ts";

/** Results shown at most; the description says the same number. */
export const RESULTS_SHOWN = 20;

interface ResultRow {
  test_name: string;
  value_text: string;
  unit: string | null;
  reference_range: string | null;
  flag_text: string | null;
  context_text: string | null;
  measured_at: string | null;
  amended: number;
}

export const getOverview = defineTool({
  name: "get_overview",
  description: `The active person's health record in Rufi at a glance: their name, how many documents and reports they have, and their current test results exactly as printed (test, value, unit, reference range, flag, method or context, measured date at the precision known). At most ${String(RESULTS_SHOWN)} results, newest measured first, undated last. An amended result replaces the one it corrects and says "amended": true. Takes no input: Rufi chooses the person, not you.`,
  input: z.strictObject({}),
  callers: "both",
  readOnly: true,
  destructive: false,
  examples: [{}],
  run: (_input, { store, personId }) => {
    if (!store) return { note: "Rufi has no records yet." };
    const { db } = store;
    if (personId === undefined) {
      const people = db
        .prepare("SELECT display_name FROM people ORDER BY display_name")
        .all() as { display_name: string }[];
      if (people.length === 0) return { note: "Rufi has no people yet." };
      throw new Refusal(
        `No person is chosen in Rufi, so the record can't be read. Ask the user which person they mean: ${people.map((p) => p.display_name).join(", ")}.`,
      );
    }
    const person = db
      .prepare("SELECT id, display_name FROM people WHERE id = ?")
      .get(personId) as { id: string; display_name: string } | undefined;
    if (!person) throw new Refusal("The chosen person isn't in Rufi.");

    const count = (sql: string) =>
      (db.prepare(sql).get(person.id) as { n: number }).n;
    // Current: no other result of this person replaces it.
    const current = `FROM results r WHERE r.person_id = ? AND NOT EXISTS (
      SELECT 1 FROM results n WHERE n.person_id = r.person_id AND n.replaces_id = r.id)`;
    const total = count(
      "SELECT count(*) AS n FROM results WHERE person_id = ?",
    );
    const currentCount = count(`SELECT count(*) AS n ${current}`);
    const rows = db
      .prepare(
        `SELECT test_name, value_text, unit, reference_range, flag_text,
           context_text, measured_at, replaces_id IS NOT NULL AS amended
         ${current}
         ORDER BY measured_at IS NULL, measured_at DESC, entered_at DESC, id DESC
         LIMIT ${String(RESULTS_SHOWN)}`,
      )
      .all(person.id) as unknown as ResultRow[];

    return {
      person: person.display_name,
      documents: count(
        "SELECT count(*) AS n FROM documents WHERE person_id = ?",
      ),
      reports: count("SELECT count(*) AS n FROM reports WHERE person_id = ?"),
      results: currentCount,
      earlier_versions_kept: total - currentCount,
      latest_results: rows.map((row) => ({
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
  },
});
