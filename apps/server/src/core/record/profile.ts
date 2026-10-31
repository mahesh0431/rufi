// The person's profile as its page and Settings show it, with its history
// and where each change was made, and a change entered in its form: saved
// through the record's one save (save.ts), with the form as its source and
// only the fields that differ from the profile now.
import type {
  Profile,
  ProfileField,
  ProfileValues,
  SaveProfile,
} from "@rufi/contracts/record";
import { Schema } from "effect";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Tables } from "../store/tables.ts";
import { ageOn } from "./dates.ts";
import { kindNamed, type Kind, type Row } from "./kinds.ts";
import { changed, fieldsOf } from "./read.ts";
import {
  SaveInput,
  SaveRefused,
  saveChanges,
  type FormOrigin,
  type Saved,
} from "./save.ts";

const kind = kindNamed("profile") as Kind;
const FIELDS: readonly ProfileField[] = [
  "birth_date",
  "sex_for_ranges",
  "blood_group",
  "height",
];

/** The fields as save_changes gives them, null when not set. */
function valuesOf(fields: Record<string, unknown>): ProfileValues {
  return Object.fromEntries(
    FIELDS.map((field) => [field, fields[field] ?? null]),
  ) as ProfileValues;
}

async function rowOf(db: Kysely<Tables>, personId: string) {
  const { rows } =
    await sql<Row>`SELECT * FROM profiles WHERE person_id = ${personId} AND id = ${personId}`.execute(
      db,
    );
  return rows[0];
}

/**
 * The person's profile on `today` ('YYYY-MM-DD'), with each save that
 * changed a value, in the order of saves; undefined when there is none.
 */
export async function readProfile(
  db: Kysely<Tables>,
  personId: string,
  today: string,
): Promise<Profile | undefined> {
  const row = await rowOf(db, personId);
  if (!row) return undefined;
  const changes = await db
    .selectFrom("record_changes as c")
    .innerJoin("operations as o", (join) =>
      join
        .onRef("o.person_id", "=", "c.person_id")
        .onRef("o.id", "=", "c.operation_id"),
    )
    .select([
      "c.operation_id",
      "c.before",
      "c.after",
      "o.origin",
      "o.created_at",
    ])
    .where("c.person_id", "=", personId)
    .where("c.kind", "=", kind.name)
    .where("c.record_id", "=", personId)
    // A source added or taken off changes no value.
    .where("c.action", "=", "change")
    .orderBy("o.seq")
    .orderBy("c.seq")
    .execute();
  const birth = row["birth_date"];
  return {
    values: valuesOf(fieldsOf(kind, row)),
    age: typeof birth === "string" ? ageOn(birth, today) : null,
    history: changes.flatMap((change) => {
      const diff = changed(
        kind,
        JSON.parse(change.before ?? "{}") as Row,
        JSON.parse(change.after) as Row,
      );
      const before = valuesOf(diff.before);
      const after = valuesOf(diff.after);
      const fields = FIELDS.filter(
        (field) => field in diff.before || field in diff.after,
      ).map((field) => ({
        field,
        before: before[field],
        after: after[field],
      })) as Profile["history"][number]["fields"];
      return fields.length === 0
        ? []
        : [
            {
              save: change.operation_id,
              at: change.created_at,
              madeIn: change.origin as FormOrigin | "chat",
              fields,
            },
          ];
    }),
  };
}

/**
 * Saves what the person entered in the profile's form, in `trx`: only the
 * fields that differ from the profile now, as one save from `form`, keyed
 * by the form's `sending`. Undefined when nothing differs; SaveRefused with
 * nothing saved when a value can't be kept.
 */
export async function changeProfile(
  trx: Transaction<Tables>,
  where: { personId: string; form: FormOrigin; sending: string; now: string },
  changes: SaveProfile["changes"],
): Promise<Saved | undefined> {
  const row = await rowOf(trx, where.personId);
  const now = valuesOf(row ? fieldsOf(kind, row) : {});
  const fields = Object.fromEntries(
    Object.entries(changes).filter(
      ([field, value]) =>
        JSON.stringify(value) !== JSON.stringify(now[field as ProfileField]),
    ),
  );
  if (Object.keys(fields).length === 0) return undefined;
  const request = Schema.decodeUnknownResult(SaveInput)({
    changes: [
      { kind: kind.name, action: "change", id: where.personId, fields },
    ],
  });
  if (request._tag === "Failure") {
    throw new SaveRefused(
      "Rufi can't keep that value, so nothing was saved. Check it and try again.",
    );
  }
  return saveChanges(
    trx,
    {
      personId: where.personId,
      form: where.form,
      callId: where.sending,
      now: where.now,
    },
    request.success,
  );
}
