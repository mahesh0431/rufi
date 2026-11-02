// read_doses and log_dose: Rufi AI reads the dose log and logs what the
// user tells it (docs/adr/0033). A log is kept as it came, outside the
// record, so it has no receipt; its id is the call's, so the same call
// again logs nothing more. Times go to and from the AI in the Mac's local
// time, as the doses are.
import { DoseState, type LogDose } from "@rufi/contracts/record";
import { sql } from "kysely";
import { Schema } from "effect";
import {
  IdTaken,
  listDoses,
  NoSuchMedicine,
  type DoseLog,
} from "../doses/log.ts";
import { dateProblem, localTime } from "../record/dates.ts";
import { kindNamed, type Kind, type Row } from "../record/kinds.ts";
import { fieldsOf } from "../record/read.ts";
import type { Store } from "../store/database.ts";
import { defineTool, Refusal } from "./registry.ts";

/** The most days one read_doses covers, as the screens' read. */
const DAYS_MAX = 62;
const DAY_MS = 86_400_000;

const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
).annotate({ description: "A local day, 'YYYY-MM-DD'." });
const LocalTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
).annotate({ description: "A local date and time, 'YYYY-MM-DDTHH:MM'." });

/** What log_dose takes: the call's id and when are Rufi's. */
export const LogDoseInput = Schema.Struct({
  medicine: Schema.String.annotate({
    description: "The medicine use's id, from get_overview or get_records.",
  }),
  dose_at: LocalTime.annotate({
    description:
      "The dose: its local date and one of the medicine's times, 'YYYY-MM-DDTHH:MM'.",
  }),
  state: DoseState.annotate({
    description:
      "taken, skipped, or cleared: takes back the dose's earlier log, as Undo does.",
  }),
  taken_at: Schema.optionalKey(
    LocalTime.annotate({
      description:
        "Only with taken: when the user said they took it, local 'YYYY-MM-DDTHH:MM'.",
    }),
  ),
});
export type LogDoseInput = typeof LogDoseInput.Type;

/** Where a log was made, for the AI. */
const byOf = (by: string) => (by.startsWith("app:") ? "iphone" : by);

/** A real local day as its UTC midnight; undefined when it isn't one. */
function dayAt(text: string): number | undefined {
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text
    ? undefined
    : at;
}

/** A local 'YYYY-MM-DDTHH:MM' as the UTC instant it is on this Mac. */
function instantOf(local: string): string {
  const [date = "", time = ""] = local.split("T");
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const [h = 0, min = 0] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toISOString();
}

/** The person's medicine use, as stored; undefined when it isn't theirs. */
async function medicineOf(store: Store, personId: string, id: string) {
  return (await store.query
    .selectFrom("medicine_uses")
    .selectAll()
    .where("person_id", "=", personId)
    .where("id", "=", id)
    .executeTakeFirst()) as Row | undefined;
}

/** A medicine's timing and fields as save_changes takes them. */
const timingOf = (row: Row) => ({
  id: row["id"],
  ...fieldsOf(kindNamed("medicine_use") as Kind, row),
  ...(row["removed"] === 1 && { removed: true }),
});

export const readDoses = defineTool({
  name: "read_doses",
  description: `The active person's dose log: what they logged for each dose of their medicines on the local days from to to (at most ${String(DAYS_MAX)} days), of one medicine or all, as the rows came, by dose, then in the order logged. A row's state is taken, skipped, or cleared (an earlier log taken back with Undo); a dose's state is its last row. Each row has its dose (dose_at), when the user said they took it (taken_at, only when said), when it was logged (logged_at) and when Rufi got it (arrived_at: later when it waited on their iPhone), all local, and where: mac (Today on the Mac), iphone, or rufi_ai (you, with log_dose). Also medicines: each one's fields as save_changes takes them, as they are now (its times, days, started, until, status, remind): with medicine, that one; else the current medicines with times and every medicine in the rows. Times may have changed since a past day, and Rufi works out no doses for past days: a dose with no row is not logged. Read only. Rufi chooses the person, not you.`,
  input: Schema.Struct({
    from: Day,
    to: Day,
    medicine: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only this medicine use's logs: its id, from get_overview or get_records.",
      }),
    ),
  }),
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    { from: "2026-10-27", to: "2026-11-02" },
    {
      from: "2026-11-01",
      to: "2026-11-02",
      medicine: "0199a0f2-0000-7000-8000-00000000000d",
    },
  ],
  run: async (input, { store, personId }) => {
    if (!store) return { note: "Rufi has no records yet." };
    if (personId === undefined) {
      throw new Refusal(
        "No person is chosen in Rufi, so the dose log can't be read. Ask the user which person they mean.",
      );
    }
    const first = dayAt(input.from);
    const last = dayAt(input.to);
    if (
      first === undefined ||
      last === undefined ||
      last < first ||
      (last - first) / DAY_MS + 1 > DAYS_MAX
    ) {
      throw new Refusal(
        `Give from and to as real days, from no later than to, at most ${String(DAYS_MAX)} days.`,
      );
    }
    let medicines: Row[];
    if (input.medicine === undefined) {
      const { rows } = await sql<Row>`SELECT m.* FROM medicine_uses m
        WHERE m.person_id = ${personId} AND (
          (m.removed = 0 AND m.status = 'current' AND m.times IS NOT NULL)
          OR m.id IN (SELECT d.medicine_use_id FROM dose_log d
            WHERE d.person_id = ${personId}
              AND d.dose_at BETWEEN ${`${input.from}T00:00`} AND ${`${input.to}T23:59`}))
        ORDER BY m.rowid`.execute(store.query);
      medicines = rows;
    } else {
      const one = await medicineOf(store, personId, input.medicine);
      if (!one) {
        throw new Refusal(
          `There is no medicine ${input.medicine} in this person's record.`,
        );
      }
      medicines = [one];
    }
    const rows = await listDoses(
      store.query,
      personId,
      input.from,
      input.to,
      input.medicine,
    );
    return {
      doses: rows.map((row) => ({
        medicine: row.medicine.id,
        dose_at: row.doseAt,
        state: row.state,
        ...(row.takenAt !== undefined && {
          taken_at: localTime(row.takenAt),
        }),
        logged_at: localTime(row.loggedAt),
        arrived_at: localTime(row.receivedAt),
        by: byOf(row.by),
      })),
      medicines: medicines.map(timingOf),
    };
  },
});

export const logDose = defineTool({
  name: "log_dose",
  description:
    "Logs what the user told you happened to one dose of one of their medicines: taken, skipped, or cleared (takes back the dose's earlier log, as Undo on Today does). Only on the user's own word in this chat; when it's unclear which medicine or which dose, ask first. dose_at is the dose as the medicine's times had it that day; taken_at only with taken, when they said when. The log is kept as given, outside the health record: no receipt, and no log is ever changed or removed; to correct one, log the dose again (its last log decides) or clear it. Answers with the log; the same call again logs nothing more. Rufi chooses the person, not you.",
  input: LogDoseInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      medicine: "0199a0f2-0000-7000-8000-00000000000d",
      dose_at: "2026-11-02T21:00",
      state: "taken",
      taken_at: "2026-11-02T21:15",
    },
    {
      medicine: "0199a0f2-0000-7000-8000-00000000000d",
      dose_at: "2026-11-03T08:00",
      state: "skipped",
    },
  ],
  run: async (input, { logDose: log, callId }) => {
    if (!log || callId === undefined) {
      throw new Refusal(
        "Doses are logged only in Rufi's chat, on the user's word.",
      );
    }
    return log(input, callId);
  },
});

/** The same call again: the same log, whenever it comes. */
const USED =
  "This call was already used for another log, so nothing was logged. Make a new call.";

/**
 * log_dose in a person's chat: the log, under the call's id, by Rufi AI,
 * logged at `now`. The same call again answers with the log it made.
 */
export async function logDoseFor(
  doses: Pick<DoseLog, "add">,
  reader: Store | undefined,
  personId: string,
  input: LogDoseInput,
  callId: string,
  now: string,
) {
  if (!reader) throw new Refusal("Rufi has no records yet.");
  if (input.taken_at !== undefined && input.state !== "taken") {
    throw new Refusal("Give taken_at only with taken.");
  }
  // A date that isn't real would roll into another day as it is converted.
  const notReal =
    input.taken_at === undefined ? undefined : dateProblem(input.taken_at);
  if (notReal !== undefined) throw new Refusal(`taken_at: ${notReal}`);
  const medicine = await medicineOf(reader, personId, input.medicine);
  if (!medicine) {
    throw new Refusal(
      `There is no medicine ${input.medicine} in this person's record.`,
    );
  }
  const takenAt = input.taken_at && instantOf(input.taken_at);
  const answer = (loggedAt: string, already: boolean) => ({
    logged: {
      medicine: {
        id: input.medicine,
        name: medicine["name"],
        ...(medicine["strength"] != null && { strength: medicine["strength"] }),
      },
      dose_at: input.dose_at,
      state: input.state,
      ...(input.taken_at !== undefined && { taken_at: input.taken_at }),
      logged_at: localTime(loggedAt),
    },
    ...(already && { already: true }),
  });
  const earlier = await reader.query
    .selectFrom("dose_log")
    .selectAll()
    .where("id", "=", callId)
    .executeTakeFirst();
  if (earlier) {
    const same =
      earlier.person_id === personId &&
      earlier.medicine_use_id === input.medicine &&
      earlier.dose_at === input.dose_at &&
      earlier.state === input.state &&
      earlier.taken_at === (takenAt ?? null);
    if (!same) throw new Refusal(USED);
    return answer(earlier.logged_at, true);
  }
  const log: LogDose = {
    id: callId,
    medicineUseId: input.medicine,
    doseAt: input.dose_at,
    state: input.state,
    loggedAt: now,
    ...(takenAt !== undefined && { takenAt }),
  };
  try {
    await doses.add(personId, log, "rufi_ai");
  } catch (error) {
    if (error instanceof IdTaken) throw new Refusal(USED);
    if (error instanceof NoSuchMedicine) throw new Refusal(error.message);
    throw error;
  }
  return answer(now, false);
}
