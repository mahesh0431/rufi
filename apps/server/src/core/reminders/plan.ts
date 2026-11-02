// A person's reminder plan (docs/adr/0031, amended): the doses a paired app
// rings as its own notices. The app asks for calendar days in its own
// calendar, so 08:00 rings at 08:00 wherever the phone is; the Mac's own day
// plays no part. Only current medicines with reminders on and times, their
// doses worked out by ../timing/doses.ts, as Today and the Mac's notices
// are; each time lists the medicines whose dose is logged already, so the
// app leaves them out. Nothing about the app is read or kept here.
import type { ReminderPlan } from "@rufi/contracts/record";
import { sql, type Kysely } from "kysely";
import { doseKey, latestLogs } from "../doses/log.ts";
import { localTime } from "../record/dates.ts";
import { remindersOf } from "./setting.ts";
import type { Tables } from "../store/tables.ts";
import { dosesOn, timingOf } from "../timing/doses.ts";

type Medicine = ReminderPlan["doses"][number]["medicines"][number];

/** The person's plan for `days` calendar days from `from` ('YYYY-MM-DD'). */
export async function reminderPlan(
  db: Kysely<Tables>,
  personId: string,
  from: string,
  days: number,
): Promise<ReminderPlan> {
  const setting = (await remindersOf(db, [personId])).get(personId);
  if (!setting) throw new Error("The person isn't in the record.");
  const { rows } = await sql<
    Record<string, unknown>
  >`SELECT m.* FROM medicine_uses m
    WHERE m.person_id = ${personId} AND m.removed = 0 AND m.status = 'current'
      AND m.remind = 1 AND m.times IS NOT NULL
    ORDER BY m.rowid`.execute(db);
  const [year = 0, month = 1, date = 1] = from.split("-").map(Number);
  const dayOf = (n: number) => new Date(year, month - 1, date + n);
  const last = localTime(dayOf(days - 1).toISOString()).slice(0, 10);
  const logs = await latestLogs(db, personId, `${from}T00:00`, `${last}T23:59`);

  const byTime = new Map<string, { medicines: Medicine[]; logged: string[] }>();
  for (let n = 0; n < days; n++) {
    for (const row of rows) {
      const id = String(row["id"]);
      const text = (name: string) =>
        typeof row[name] === "string" ? row[name] : undefined;
      for (const dose of dosesOn(timingOf(row), dayOf(n))) {
        const at = localTime(dose.toISOString());
        const time = byTime.get(at) ?? { medicines: [], logged: [] };
        byTime.set(at, time);
        const strength = text("strength");
        const amount = text("amount");
        time.medicines.push({
          id,
          name: String(row["name"]),
          ...(strength !== undefined && { strength }),
          ...(amount !== undefined && { amount }),
        });
        const log = logs.get(doseKey({ medicine_use_id: id, dose_at: at }));
        if (log && log.state !== "cleared") time.logged.push(id);
      }
    }
  }
  return {
    show: setting.show,
    ring: setting.ring,
    doses: [...byTime]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([at, { medicines, logged }]) => ({
        at,
        medicines: medicines.toSorted((a, b) => a.name.localeCompare(b.name)),
        logged,
      })),
  };
}
