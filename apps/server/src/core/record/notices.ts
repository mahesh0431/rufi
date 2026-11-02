// The notice claim (docs/adr/0012): which open follow-ups just became due or
// overdue, and which medicines' dose time just came, for the Rufi app to
// tell as Mac notices. A follow-up is told once per state (due, then
// overdue) and per due: a moved date is told again. A medicine with
// reminders on is told its latest dose since the last one handled (or since
// the save that last changed it), only within 60 minutes of it: never a
// backlog (docs/adr/0031). A dose is told on the Mac only when the
// person's reminders ring there (the Mac, or both); one rung on their
// iPhone is still handled, so the Mac never tells it later. The claim
// records what it handles in follow_up_notices and medicine_notices, in one
// transaction with the read, and gives back counts per person and what a
// reminder shows: no titles, and a medicine's name only at Which ones. The
// marker is committed before the app shows anything, so a crash in between
// loses that notice; Needs you and Today still show it.
import type { PersonNotices } from "@rufi/contracts/app";
import { sql, type Kysely, type Transaction } from "kysely";
import { remindersOf } from "../reminders/setting.ts";
import type { Tables } from "../store/tables.ts";
import { latestDose, timingOf } from "../timing/doses.ts";
import { localTime } from "./dates.ts";
import { classify, dueSpan } from "./due.ts";

/** How late a medicine's dose can still be told. */
const LATE_MS = 60 * 60_000;

const RANK: Readonly<Record<string, number>> = { due: 1, overdue: 2 };

/**
 * Takes the notices due at the local time `now`: marks each follow-up that
 * reached a state it wasn't told yet, and counts them per person. A clock
 * moved back never lowers a marker.
 */
export function claimNotices(
  db: Kysely<Tables>,
  now: Date,
): Promise<PersonNotices[]> {
  return db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom("follow_ups as f")
      .leftJoin("follow_up_notices as n", (join) =>
        join
          .onRef("n.person_id", "=", "f.person_id")
          .onRef("n.follow_up_id", "=", "f.id"),
      )
      .select([
        "f.person_id as personId",
        "f.id",
        "f.due",
        "n.due as toldDue",
        "n.state as toldState",
      ])
      .where("f.status", "=", "open")
      .where("f.removed", "=", 0)
      .orderBy("f.person_id")
      .execute();
    const people = new Map<
      string,
      {
        due: number;
        overdue: number;
        medicines: number;
        at?: string;
        show?: "time" | "count" | "names";
        names?: string[];
      }
    >();
    const of = (personId: string) => {
      const counts = people.get(personId) ?? {
        due: 0,
        overdue: 0,
        medicines: 0,
      };
      people.set(personId, counts);
      return counts;
    };
    for (const { personId, id, due, toldDue, toldState } of open) {
      const state = classify(due, now);
      if (due === null || (state !== "due" && state !== "overdue")) continue;
      // Told nothing yet for this due: 0.
      const told = (toldDue === due && RANK[toldState ?? ""]) || 0;
      if ((RANK[state] ?? 0) <= told) continue;
      await trx
        .insertInto("follow_up_notices")
        .values({ person_id: personId, follow_up_id: id, due, state })
        .onConflict((conflict) =>
          conflict
            .columns(["person_id", "follow_up_id"])
            .doUpdateSet({ due, state }),
        )
        .execute();
      of(personId)[state] += 1;
    }
    const doses = await claimDoses(trx, now);
    const settings = await remindersOf(trx, [
      ...new Set(doses.map((dose) => dose.personId)),
    ]);
    for (const { personId, at, label } of doses) {
      const setting = settings.get(personId);
      // Rung on their iPhone only: handled, and not told here.
      if (!setting || setting.ring === "iphone") continue;
      const counts = of(personId);
      counts.medicines += 1;
      const time = localTime(at.toISOString()).slice(11);
      // The time only when every dose told shares it.
      counts.at =
        counts.medicines === 1 || counts.at === time ? time : undefined;
      counts.show = setting.show;
      if (setting.show === "names")
        counts.names = [...(counts.names ?? []), label];
    }
    return [...people]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([personId, { at, show, names, ...counts }]) => ({
        personId,
        ...counts,
        ...(at !== undefined && { at }),
        ...(show !== undefined && { show }),
        ...(names !== undefined && { names }),
      }));
  });
}

/**
 * The medicines to tell now: each with reminders on whose latest dose since
 * its marker, or else since the save that last changed it, has come. The
 * marker moves to that dose, told or passed over.
 */
async function claimDoses(
  trx: Transaction<Tables>,
  now: Date,
): Promise<{ personId: string; at: Date; label: string }[]> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT m.*, n.told,
      (SELECT o.created_at FROM record_changes c
        JOIN operations o ON o.id = c.operation_id
        WHERE c.person_id = m.person_id AND c.kind = 'medicine_use' AND c.record_id = m.id
        ORDER BY o.seq DESC LIMIT 1) AS saved
    FROM medicine_uses m
    LEFT JOIN medicine_notices n
      ON n.person_id = m.person_id AND n.medicine_use_id = m.id
    WHERE m.removed = 0 AND m.status = 'current' AND m.remind = 1
      AND m.times IS NOT NULL
    ORDER BY m.person_id, m.rowid`.execute(trx);
  const told: { personId: string; at: Date; label: string }[] = [];
  for (const row of rows) {
    const personId = String(row["person_id"]);
    const marker =
      typeof row["told"] === "string" ? dueSpan(row["told"]) : undefined;
    // Never saved since Rufi kept saves: from always.
    const from =
      marker?.from ??
      (typeof row["saved"] === "string" ? new Date(row["saved"]) : new Date(0));
    const dose = latestDose(timingOf(row), from, now);
    if (dose === undefined) continue;
    const handled = localTime(dose.toISOString());
    await trx
      .insertInto("medicine_notices")
      .values({
        person_id: personId,
        medicine_use_id: String(row["id"]),
        told: handled,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["person_id", "medicine_use_id"])
          .doUpdateSet({ told: handled }),
      )
      .execute();
    if (now.getTime() - dose.getTime() <= LATE_MS) {
      const text = (name: string) =>
        typeof row[name] === "string" ? row[name] : undefined;
      // "Amoxicillin 500 mg · 1 capsule", as Today names it.
      const label = [
        [text("name"), text("strength")].filter(Boolean).join(" "),
        text("amount"),
      ]
        .filter(Boolean)
        .join(" · ");
      told.push({ personId, at: dose, label });
    }
  }
  return told;
}
