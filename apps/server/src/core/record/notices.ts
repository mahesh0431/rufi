// The notice claim (docs/adr/0012): which open follow-ups just became due or
// overdue, for the Rufi app to tell as Mac notices. Each is told once per
// state (due, then overdue) and per due: a moved date is told again. The
// claim records what it tells in follow_up_notices, in one transaction with
// the read, and gives back only counts per person: no titles, no names. The
// marker is committed before the app shows anything, so a crash in between
// loses that notice; Needs you still shows the follow-up.
import type { PersonNotices } from "@rufi/contracts/app";
import type { Kysely } from "kysely";
import type { Tables } from "../store/tables.ts";
import { classify } from "./due.ts";

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
    const people = new Map<string, { due: number; overdue: number }>();
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
      const counts = people.get(personId) ?? { due: 0, overdue: 0 };
      counts[state] += 1;
      people.set(personId, counts);
    }
    return [...people].map(([personId, counts]) => ({ personId, ...counts }));
  });
}
