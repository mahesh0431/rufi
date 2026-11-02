// Each person's reminder setting (docs/adr/0012, amended): what a medicine
// reminder shows and where it rings. Only the person's choices are kept,
// in reminder_settings; what applies is worked out here. Reminders ring on
// the Mac while no iPhone is paired for them, when the choice isn't shown;
// pairing their first iPhone chooses the iPhone (../paired/paired-apps.ts),
// and unpairing the last one, or a restore that revokes every key, needs no
// write.
import type {
  ReminderRing,
  ReminderShow,
  Reminders,
  SaveReminders,
} from "@rufi/contracts/record";
import type { Kysely } from "kysely";
import type { Tables } from "../store/tables.ts";

/** Before the person chooses: How many, on the Mac. */
const SHOW: ReminderShow = "count";
const RING: ReminderRing = "mac";

/** Each person's iPhones paired and not revoked, the first paired first. */
async function iphonesOf(db: Kysely<Tables>, personIds?: readonly string[]) {
  let query = db
    .selectFrom("paired_apps")
    .select(["id", "name", "person_id"])
    .where("kind", "=", "iphone")
    .where("revoked_at", "is", null)
    .orderBy("paired_at");
  if (personIds) query = query.where("person_id", "in", personIds);
  return query.execute();
}

/** What applies for each of `personIds`, by person. */
export async function remindersOf(
  db: Kysely<Tables>,
  personIds: readonly string[],
): Promise<Map<string, Reminders>> {
  if (personIds.length === 0) return new Map();
  const chosen = new Map(
    (
      await db
        .selectFrom("reminder_settings")
        .selectAll()
        .where("person_id", "in", personIds)
        .execute()
    ).map((row) => [row.person_id, row]),
  );
  const iphones = await iphonesOf(db, personIds);
  return new Map(
    personIds.map((personId) => {
      const theirs = iphones
        .filter((app) => app.person_id === personId)
        .map(({ id, name }) => ({ id, name }));
      const choice = chosen.get(personId);
      const ring: ReminderRing =
        theirs.length === 0
          ? "mac"
          : ((choice?.ring as ReminderRing | null) ?? RING);
      return [
        personId,
        {
          show: (choice?.show as ReminderShow | null) ?? SHOW,
          ring,
          iphones: theirs,
        },
      ];
    }),
  );
}

/** Keeps the person's two choices, as picked. */
export async function saveReminders(
  db: Kysely<Tables>,
  personId: string,
  { show, ring }: SaveReminders,
): Promise<void> {
  await db
    .insertInto("reminder_settings")
    .values({ person_id: personId, show, ring })
    .onConflict((oc) => oc.column("person_id").doUpdateSet({ show, ring }))
    .execute();
}
