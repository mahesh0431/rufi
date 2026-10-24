// The record as its screens show it: Overview's tiles and latest saves, a
// page per kind in groups (a report's lab results whole, a day of results,
// or one row; a result row with its small trend), a row with its sources and
// history, and a test's series.
// Results have two pages, Lab results and Measurements, by their category
// (docs/adr/0013). Read only, for one person, each answer from one read
// transaction so it is consistent. "Current" is read.ts's isCurrent, as
// everywhere else.
import type {
  BadRow,
  FollowUpNeed,
  FollowUps,
  Overview,
  PageKind,
  RecentChange,
  RecordChange,
  RecordDetail,
  RecordGroup,
  RecordPage,
  RecordSource,
  ResultCategory,
  ResultRow,
  Series,
  ShownRow,
  Tile,
  WaitingDocument,
} from "@rufi/contracts/record";
import type { DocumentSummary } from "@rufi/contracts/documents";
import { RecordRow } from "@rufi/contracts/record";
import { Schema } from "effect";
import { sql, type Kysely, type RawBuilder } from "kysely";
import { documentName } from "../documents/naming.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { KINDS, kindNamed, visitWords, type Kind, type Row } from "./kinds.ts";
import { classify, dueSpan } from "./due.ts";
import { changed, fieldsOf, isCurrent } from "./read.ts";

/** Groups on one page: reports and days are big, other kinds' groups are one row. */
const GROUPS_PER_PAGE = { result: 10, other: 30 };
/** Latest saves on Overview. */
const RECENT_SHOWN = 5;
/** Names a tile shows at most. */
const NAMES_SHOWN = 3;
/** Values a row's small trend shows at most. */
const TREND_POINTS = 6;

/**
 * The kinds each page shows: allergies' page has the "none known"
 * statements too; each results page shows the results of one category.
 */
const PAGES: Record<
  PageKind,
  { kinds: readonly string[]; category?: ResultCategory }
> = {
  lab_result: { kinds: ["result"], category: "lab" },
  measurement: { kinds: ["result"], category: "measurement" },
  medicine_use: { kinds: ["medicine_use"] },
  visit: { kinds: ["visit"] },
  condition: { kinds: ["condition"] },
  allergy: { kinds: ["allergy", "none_known"] },
  symptom: { kinds: ["symptom"] },
  care_event: { kinds: ["care_event"] },
};

/** Whether `kind` names a page. */
export const isPageKind = (kind: string): kind is PageKind =>
  Object.hasOwn(PAGES, kind);

/** A cursor that isn't one this read gave. */
export class BadCursor extends Error {}

type Db = Kysely<Tables>;
const kindOf = (name: string) => kindNamed(name) as Kind;

/** A calendar date, not 'next_visit', words or none. */
const calendar = (date: RawBuilder<unknown>) =>
  sql`${date} GLOB '[0-9][0-9][0-9][0-9]*'`;

/**
 * Each current record's group and the group's date. A lab result read from
 * a report belongs to the report, dated when its sample was collected (or,
 * with no date printed, by its lab results' latest date); a typed one to
 * its day. A measurement belongs to the day it was taken, from a report or
 * not. A day is a month or year at the precision known. Any other record
 * is a group of its own.
 */
function grouped(kind: Kind, personId: string, category?: ResultCategory) {
  if (kind.name === "result") {
    const measured = sql`r.measured_at`;
    const day = sql`substr(r.measured_at, 1, 10)`;
    const mine = sql`r.person_id = ${personId} AND r.category = ${category} AND ${isCurrent(kind, "r")}`;
    if (category === "measurement") {
      const gid = sql<string>`'day:' || CASE WHEN ${calendar(measured)} THEN ${day} ELSE '' END`;
      return {
        gid,
        mine,
        keys: sql`SELECT ${gid} AS gid, ${day} AS d FROM results r WHERE ${mine}`,
      };
    }
    const gid = sql<string>`CASE WHEN r.report_id IS NOT NULL THEN 'report:' || r.report_id WHEN ${calendar(measured)} THEN 'chat:' || ${day} ELSE 'chat:' END`;
    // A report with no printed date takes its current lab results' latest
    // date, at its precision; undated only when none of them has one.
    const latest = sql`(SELECT max(substr(m.measured_at, 1, 10)) FROM results m WHERE m.person_id = r.person_id AND m.report_id = r.report_id AND m.category = r.category AND ${calendar(sql`m.measured_at`)} AND ${isCurrent(kind, "m")})`;
    const date = sql`CASE WHEN r.report_id IS NOT NULL THEN coalesce(p.collected, ${latest}) ELSE ${day} END`;
    return {
      gid,
      mine,
      keys: sql`SELECT ${gid} AS gid, ${date} AS d FROM results r LEFT JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id WHERE ${mine}`,
    };
  }
  const field = kind.fields[kind.dated];
  const dated = sql.ref(`r.${field?.column ?? kind.dated}`);
  // Allergies with no reaction date sort by the day the user said them.
  const date = kind.asserted ? sql`coalesce(${dated}, r.asserted)` : dated;
  const gid = sql<string>`${kind.name} || ':' || r.id`;
  const mine = sql`r.person_id = ${personId} AND ${isCurrent(kind, "r")}`;
  return {
    gid,
    mine,
    keys: sql`SELECT ${gid} AS gid, ${date} AS d FROM ${sql.table(kind.table)} r WHERE ${mine}`,
  };
}

interface Key {
  /** 0 a calendar date, 1 the next visit, 2 none. */
  bucket: number;
  /** The calendar date at its precision, or ''. */
  d: string;
  gid: string;
}

const encodeCursor = (key: Key) =>
  Buffer.from(JSON.stringify([key.bucket, key.d, key.gid])).toString(
    "base64url",
  );

function decodeCursor(cursor: string): Key {
  try {
    const [bucket, d, gid] = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as unknown[];
    if (
      typeof bucket === "number" &&
      typeof d === "string" &&
      typeof gid === "string"
    ) {
      return { bucket, d, gid };
    }
  } catch (error) {
    throw new BadCursor("That page isn't one Rufi gave.", { cause: error });
  }
  throw new BadCursor("That page isn't one Rufi gave.");
}

/**
 * The page's group keys, in the page order: dated groups newest first (a
 * month after its days), then the next visit, then no date; equal dates by
 * group id, newest first. After `after`, `limit` at most.
 */
async function groupKeys(
  db: Db,
  personId: string,
  pageKind: PageKind,
  after: Key | undefined,
  limit: number,
) {
  const { kinds, category } = PAGES[pageKind];
  const all = sql.join(
    kinds.map((name) => grouped(kindOf(name), personId, category).keys),
    sql` UNION ALL `,
  );
  const from =
    after === undefined
      ? sql``
      : sql`WHERE bucket > ${after.bucket} OR (bucket = ${after.bucket} AND d < ${after.d}) OR (bucket = ${after.bucket} AND d = ${after.d} AND gid < ${after.gid})`;
  const { rows } = await sql<Key>`
    SELECT bucket, d, gid FROM (
      SELECT DISTINCT
        CASE WHEN ${calendar(sql.ref("d"))} THEN 0 WHEN d = 'next_visit' THEN 1 ELSE 2 END AS bucket,
        CASE WHEN ${calendar(sql.ref("d"))} THEN d ELSE '' END AS d,
        gid
      FROM (${all})
    )
    ${from}
    ORDER BY bucket, d DESC, gid DESC
    LIMIT ${limit}`.execute(db);
  return rows;
}

/** A stored row as the screens show it, or why it can't be shown. */
function shown(kind: Kind, row: Row): ShownRow {
  const id = String(row["id"]);
  const record = {
    kind: kind.name,
    id,
    ...fieldsOf(kind, row),
    ...(typeof row["asserted"] === "string" && { asserted: row["asserted"] }),
    ...(typeof row["cited"] === "number" && { cited: row["cited"] }),
  };
  // Fields the row doesn't have are left out, not sent as undefined.
  const decoded = Schema.decodeUnknownResult(RecordRow)(
    JSON.parse(JSON.stringify(record)),
  );
  if (decoded._tag === "Success") return decoded.success;
  const bad: BadRow = {
    kind: kind.name,
    id,
    problem: `Its stored values don't fit a ${kind.noun}.`,
  };
  return bad;
}

/** The members of these groups, current only, in the order they were entered. */
async function members(
  db: Db,
  personId: string,
  kind: Kind,
  category: ResultCategory | undefined,
  gids: readonly string[],
) {
  if (gids.length === 0) return [];
  const { gid, mine } = grouped(kind, personId, category);
  const report =
    kind.name === "result"
      ? sql`, p.issuer AS report_issuer FROM results r LEFT JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id`
      : kind.name === "visit"
        ? sql`, (SELECT count(*) FROM (${citing(personId, sql`r.id`)})) AS cited FROM visits r`
        : sql` FROM ${sql.table(kind.table)} r`;
  const { rows } = await sql<Row>`
    SELECT r.*, ${gid} AS gid${report}
    WHERE ${mine} AND ${gid} IN (${sql.join(gids)})
    ORDER BY r.rowid`.execute(db);
  return rows;
}

/** A group while its rows are read. */
type Building = { -readonly [K in keyof RecordGroup]: RecordGroup[K] } & {
  rows: ShownRow[];
};

/** One page of a kind's groups, after the cursor `after`. */
async function page(
  db: Db,
  personId: string,
  pageKind: PageKind,
  after: string | undefined,
): Promise<RecordPage> {
  const { kinds, category } = PAGES[pageKind];
  const size =
    category === undefined ? GROUPS_PER_PAGE.other : GROUPS_PER_PAGE.result;
  const keys = await groupKeys(
    db,
    personId,
    pageKind,
    after === undefined ? undefined : decodeCursor(after),
    size + 1,
  );
  const mine = keys.slice(0, size);
  const groups = new Map<string, Building>(
    mine.map((key) => {
      const type = key.gid.startsWith("report:")
        ? "report"
        : key.gid.startsWith("chat:")
          ? "chat"
          : key.gid.startsWith("day:")
            ? "day"
            : "row";
      return [
        key.gid,
        {
          id: key.gid,
          type,
          ...(key.bucket === 0 && { date: key.d }),
          ...(key.bucket === 1 && { date: "next_visit" }),
          rows: [],
        },
      ];
    }),
  );
  for (const name of kinds) {
    const kind = kindOf(name);
    const rows = await members(
      db,
      personId,
      kind,
      category,
      mine.map((key) => key.gid),
    );
    for (const row of rows) {
      const group = groups.get(String(row["gid"]));
      if (!group) continue;
      if (
        group.type === "report" &&
        typeof row["report_issuer"] === "string" &&
        group.issuer === undefined
      ) {
        group.issuer = row["report_issuer"];
      }
      group.rows.push(shown(kind, row));
    }
  }
  const last = mine.at(-1);
  const found = [...groups.values()];
  return {
    groups: found,
    next: keys.length > size && last ? encodeCursor(last) : null,
    ...(category !== undefined && {
      trends: await trends(
        db,
        personId,
        category,
        found.flatMap((group) => group.rows),
      ),
    }),
  };
}

/** A record of the person's by kind and id, whether current or not. */
async function stored(db: Db, personId: string, kind: Kind, id: string) {
  const { rows } =
    await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND id = ${id}`.execute(
      db,
    );
  return rows[0];
}

async function sourcesOf(
  db: Db,
  personId: string,
  kind: Kind,
  id: string,
): Promise<RecordSource[]> {
  const rows = await db
    .selectFrom("record_sources as s")
    .leftJoin("document_pages as p", (join) =>
      join
        .onRef("p.person_id", "=", "s.person_id")
        .onRef("p.document_id", "=", "s.document_id")
        .onRef("p.position", "=", "s.page"),
    )
    .leftJoin("documents as d", (join) =>
      join
        .onRef("d.person_id", "=", "s.person_id")
        .onRef("d.id", "=", "s.document_id"),
    )
    .leftJoin("transcript_entries as e", (join) =>
      join
        .onRef("e.person_id", "=", "s.person_id")
        .onRef("e.id", "=", "s.entry_id"),
    )
    .leftJoin("visits as v", (join) =>
      join
        .onRef("v.person_id", "=", "s.person_id")
        .onRef("v.id", "=", "s.visit_id"),
    )
    .select([
      "s.type",
      "s.entry_id",
      "s.document_id",
      "s.page",
      "p.file_name",
      "d.deleted_at",
      "e.text",
      "e.created_at",
      "s.visit_id",
      "v.doctor",
      "v.place",
      "v.reason",
      "v.as_written",
      "v.date",
      "v.removed",
    ])
    .where("s.person_id", "=", personId)
    .where("s.kind", "=", kind.name)
    .where("s.record_id", "=", id)
    .where("s.removed_by", "is", null)
    .orderBy(sql.ref("s.rowid"))
    .execute();
  return rows.map((source) =>
    source.type === "message"
      ? {
          type: "message",
          entry: source.entry_id ?? "",
          text: source.text ?? "",
          at: source.created_at ?? "",
        }
      : source.type === "visit"
        ? {
            type: "visit",
            visit: source.visit_id ?? "",
            label: visitWords(source),
            removed: source.removed === 1,
          }
        : {
            type: "document",
            document: source.document_id ?? "",
            page: source.page ?? 0,
            file: source.file_name ?? "",
            deleted: source.deleted_at !== null,
          },
  );
}

/**
 * The records that cite a visit now, as their kind and id, in the order
 * they first cited it: a source not taken off, of a record that is
 * current. `visit` is SQL for its id.
 */
function citing(personId: string, visit: RawBuilder<unknown>) {
  return sql`SELECT s.kind, s.record_id FROM record_sources s
    WHERE s.person_id = ${personId} AND s.visit_id = ${visit} AND s.removed_by IS NULL
    AND (${sql.join(
      KINDS.map(
        (kind) =>
          sql`(s.kind = ${kind.name} AND EXISTS (SELECT 1 FROM ${sql.table(kind.table)} c WHERE c.person_id = s.person_id AND c.id = s.record_id AND ${isCurrent(kind, "c")}))`,
      ),
      sql` OR `,
    )})
    GROUP BY s.kind, s.record_id ORDER BY min(s.rowid)`;
}

/** From this visit: the current records that cite it now. */
async function fromVisit(
  db: Db,
  personId: string,
  id: string,
): Promise<ShownRow[]> {
  const { rows } = await sql<{
    kind: string;
    record_id: string;
  }>`${citing(personId, sql`${id}`)}`.execute(db);
  const found: ShownRow[] = [];
  for (const { kind: name, record_id } of rows) {
    const kind = kindOf(name);
    const row = await stored(db, personId, kind, record_id);
    if (row) found.push(shown(kind, row));
  }
  return found;
}

/** Each change saves made to the record, in the order of the saves. */
async function historyOf(
  db: Db,
  personId: string,
  kind: Kind,
  id: string,
): Promise<RecordChange[]> {
  const rows = await db
    .selectFrom("record_changes as c")
    .innerJoin("operations as o", (join) =>
      join
        .onRef("o.person_id", "=", "c.person_id")
        .onRef("o.id", "=", "c.operation_id"),
    )
    .select([
      "c.operation_id",
      "c.action",
      "c.before",
      "c.after",
      "c.source_entry_id",
      "o.created_at",
    ])
    .where("c.person_id", "=", personId)
    .where("c.kind", "=", kind.name)
    .where("c.record_id", "=", id)
    .orderBy("o.seq")
    .orderBy("c.seq")
    .execute();
  return rows.map((change) => {
    const before =
      change.before === null ? undefined : (JSON.parse(change.before) as Row);
    const after = JSON.parse(change.after) as Row;
    const fields = [];
    if (change.action === "change" && before) {
      const diff = changed(kind, before, after);
      const names = new Set([
        ...Object.keys(diff.before),
        ...Object.keys(diff.after),
      ]);
      for (const field of names) {
        fields.push({
          field,
          ...(field in diff.before && { before: diff.before[field] }),
          ...(field in diff.after && { after: diff.after[field] }),
        });
      }
    }
    return {
      save: change.operation_id,
      at: change.created_at,
      action: change.action as RecordChange["action"],
      fields,
      fromMessage: change.source_entry_id !== null,
    };
  });
}

/** A row opened: undefined when the person has no such record. */
async function detail(
  db: Db,
  personId: string,
  kindName: string,
  id: string,
): Promise<RecordDetail | undefined> {
  const kind = kindNamed(kindName);
  if (!kind) return undefined;
  const row = await stored(db, personId, kind, id);
  if (!row) return undefined;
  const result: RecordDetail = {
    row: shown(kind, row),
    removed: row["removed"] === 1,
    sources: await sourcesOf(db, personId, kind, id),
    history: await historyOf(db, personId, kind, id),
  };
  if (kind.name === "visit") {
    return { ...result, fromVisit: await fromVisit(db, personId, id) };
  }
  if (kind.name !== "result") return result;
  const replaces =
    typeof row["replaces_id"] === "string"
      ? await stored(db, personId, kind, row["replaces_id"])
      : undefined;
  const { rows: successors } =
    await sql<Row>`SELECT * FROM results WHERE person_id = ${personId} AND replaces_id = ${id} AND removed = 0 ORDER BY rowid DESC LIMIT 1`.execute(
      db,
    );
  const replacedBy = successors[0];
  return {
    ...result,
    entered: String(row["entered_at"]),
    ...(replaces && { replaces: shown(kind, replaces) }),
    ...(replacedBy && { replacedBy: shown(kind, replacedBy) }),
  };
}

/**
 * Every current value of one test in one unit and one category: dated
 * oldest first, then undated. A lab test and a measurement of the same
 * name are two series.
 */
async function series(
  db: Db,
  personId: string,
  test: string,
  unit: string | null,
  category: ResultCategory,
): Promise<Series> {
  const rows = await seriesRows(
    db,
    personId,
    category,
    sql`r.test_name = ${test} AND ${unit === null ? sql`r.unit IS NULL` : sql`r.unit = ${unit}`}`,
  );
  return {
    test,
    unit,
    category,
    values: rows.map((row) => shown(kindOf("result"), row)),
  };
}

/** Current results of one category that match `where`, in a series' order. */
async function seriesRows(
  db: Db,
  personId: string,
  category: ResultCategory,
  where: RawBuilder<unknown>,
) {
  const { rows } = await sql<Row>`
    SELECT r.* FROM results r
    WHERE r.person_id = ${personId} AND ${where}
      AND r.category = ${category}
      AND ${isCurrent(kindOf("result"), "r")}
    ORDER BY ${calendar(sql`r.measured_at`)} DESC, r.measured_at, r.entered_at, r.rowid`.execute(
    db,
  );
  return rows;
}

/** Whether a result can be a point on a trend: a calendar date and a number. */
const placed = (row: ShownRow): row is ResultRow =>
  !("problem" in row) &&
  row.kind === "result" &&
  row.number !== undefined &&
  row.measured !== undefined &&
  /^\d{4}/.test(row.measured.date);

/**
 * Each result row's small trend: the latest values of its series (its test
 * in its unit and category) up to it, a few at most, read for the whole
 * page at once. Only rows with two or more such values have one.
 */
async function trends(
  db: Db,
  personId: string,
  category: ResultCategory,
  rows: readonly ShownRow[],
): Promise<Record<string, ResultRow[]>> {
  const shownRows = rows.filter(placed);
  const tests = [...new Set(shownRows.map((row) => row.test))];
  if (tests.length === 0) return {};
  const key = (row: ResultRow) => JSON.stringify([row.test, row.unit ?? null]);
  const wanted = new Set(shownRows.map((row) => row.id));
  const all = new Map<string, ResultRow[]>();
  // Where each shown row is in its series, found as the series is built.
  const at = new Map<string, number>();
  for (const row of await seriesRows(
    db,
    personId,
    category,
    sql`r.test_name IN (${sql.join(tests)})`,
  )) {
    const value = shown(kindOf("result"), row);
    if (!placed(value)) continue;
    let values = all.get(key(value));
    if (values === undefined) {
      values = [];
      all.set(key(value), values);
    }
    if (wanted.has(value.id)) at.set(value.id, values.length);
    values.push(value);
  }
  const found: Record<string, ResultRow[]> = {};
  for (const row of shownRows) {
    const end = at.get(row.id);
    if (end === undefined) continue;
    const trend = (all.get(key(row)) ?? []).slice(
      Math.max(0, end + 1 - TREND_POINTS),
      end + 1,
    );
    if (trend.length > 1) found[row.id] = trend;
  }
  return found;
}

/** A page's tile: its count and what it counts. */
async function tile(
  db: Db,
  personId: string,
  pageKind: PageKind,
): Promise<Tile> {
  const { kinds, category } = PAGES[pageKind];
  const kind = kindOf(kinds[0] ?? "");
  const current = sql`FROM ${sql.table(kind.table)} r WHERE ${grouped(kind, personId, category).mine}`;
  const { rows: counted } = await sql<{
    n: number;
  }>`SELECT count(*) AS n ${current}`.execute(db);
  const count = counted[0]?.n ?? 0;
  const base: Tile = { kind: pageKind, count, names: [] };
  // The status that means it applies now.
  const now = (
    {
      medicine_use: "current",
      condition: "ongoing",
      allergy: "active",
    } as Record<string, string>
  )[pageKind];
  if (now !== undefined) {
    const { rows } =
      await sql<Row>`SELECT * ${current} AND r.status = ${now} ORDER BY r.rowid DESC`.execute(
        db,
      );
    const tiled: Tile = {
      ...base,
      now: rows.length,
      names: rows.slice(0, NAMES_SHOWN).map((row) => kind.label(row)),
    };
    if (pageKind !== "allergy") return tiled;
    const noneKnown = kindOf("none_known");
    const { rows: statements } = await sql<{
      asserted: string | null;
    }>`SELECT r.asserted FROM none_known r WHERE r.person_id = ${personId} AND ${isCurrent(noneKnown, "r")} ORDER BY r.rowid DESC LIMIT 1`.execute(
      db,
    );
    const said = statements[0];
    return said ? { ...tiled, noneKnown: said.asserted ?? "" } : tiled;
  }
  if (count === 0) return base;
  // The newest group, as the kind's page starts.
  const first = (await page(db, personId, pageKind, undefined)).groups[0];
  const row = first?.rows[0];
  if (!first || !row) return base;
  if (category !== undefined) {
    const results = first.rows.filter(
      (r): r is ResultRow => r.kind === "result" && !("problem" in r),
    );
    // A day of measurements is named by what was measured.
    const names = [...new Set(results.map((r) => r.test))];
    return {
      ...base,
      ...(first.type === "day" && { names: names.slice(0, NAMES_SHOWN) }),
      latest: {
        label:
          first.type === "day"
            ? names.slice(0, NAMES_SHOWN).join(", ")
            : (first.issuer ??
              (first.type === "report" ? "A report" : "Typed in the chat")),
        ...(first.date !== undefined && { date: first.date }),
        results: first.rows.length,
        flagged: results.filter((r) => r.flag !== undefined).length,
      },
    };
  }
  const latest = await stored(db, personId, kind, row.id);
  return {
    ...base,
    latest: {
      label: latest ? kind.label(latest) : "",
      ...(first.date !== undefined && { date: first.date }),
    },
  };
}

/** The person's latest saves, newest first, each with its receipt. */
async function recent(db: Db, personId: string): Promise<RecentChange[]> {
  const rows = await db
    .selectFrom("operations as o")
    .innerJoin("transcript_entries as e", (join) =>
      join.onRef("e.person_id", "=", "o.person_id").onRef("e.id", "=", "o.id"),
    )
    .select(["o.id", "o.created_at", "e.text"])
    .where("o.person_id", "=", personId)
    .orderBy("o.seq", "desc")
    .limit(RECENT_SHOWN)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    at: row.created_at,
    receipt: row.text,
  }));
}

/** The Follow-ups page's groups, in its order. */
const FOLLOW_UP_GROUPS = [
  "overdue",
  "due",
  "coming_up",
  "later",
  "next_visit",
  "no_date",
  "done",
  "dropped",
] as const;
type FollowUpGroup = (typeof FOLLOW_UP_GROUPS)[number];

/**
 * The person's follow-ups that aren't removed, each in its group at the
 * local time `now`: the open ones by the due rules (./due.ts), soonest
 * first, then done and dropped. A row that can't be shown goes with No date.
 */
async function followUps(
  db: Db,
  personId: string,
  now: Date,
): Promise<{ group: FollowUpGroup; row: ShownRow; due: string | null }[]> {
  const kind = kindOf("follow_up");
  const { rows } = await sql<Row>`SELECT r.* FROM follow_ups r
    WHERE r.person_id = ${personId} AND ${isCurrent(kind, "r")}
    ORDER BY r.rowid`.execute(db);
  const placed = rows.map((row) => {
    const due = typeof row["due"] === "string" ? row["due"] : null;
    const shownRow = shown(kind, row);
    const group: FollowUpGroup =
      "problem" in shownRow
        ? "no_date"
        : row["status"] === "done" || row["status"] === "dropped"
          ? row["status"]
          : classify(due, now);
    return { group, row: shownRow, due };
  });
  // Dated ones by when they stop being due, then when they start: today's
  // before this month's. The others stay in the order they were saved.
  const order = (due: string | null) => {
    const span = dueSpan(due);
    return span ? [span.overdueFrom.getTime(), span.from.getTime()] : [0, 0];
  };
  return placed.toSorted((a, b) => {
    const byGroup =
      FOLLOW_UP_GROUPS.indexOf(a.group) - FOLLOW_UP_GROUPS.indexOf(b.group);
    if (byGroup !== 0 || a.group === "done" || a.group === "dropped") {
      return byGroup;
    }
    const [aEnd = 0, aFrom = 0] = order(a.due);
    const [bEnd = 0, bFrom = 0] = order(b.due);
    return aEnd - bEnd || aFrom - bFrom;
  });
}

/** Whether follow-ups in this group show in Needs you. */
const isNeed = (group: FollowUpGroup): group is FollowUpNeed["state"] =>
  group === "overdue" || group === "due" || group === "coming_up";

/**
 * Documents waiting for the person: read with results not saved, read with
 * pages that couldn't be read (Retry reads them), or a reading that failed.
 * A document read cleanly with nothing to save waits for nothing.
 */
export function waiting(
  documents: readonly DocumentSummary[],
): WaitingDocument[] {
  return documents.flatMap((document): WaitingDocument[] => {
    const name = documentName(document.files.map((file) => file.name));
    const reading = document.reading;
    const state =
      document.status === "failed"
        ? "failed"
        : document.status !== "done" || !reading
          ? undefined
          : reading.results > 0
            ? "to_save"
            : reading.canRetry
              ? "unread_pages"
              : undefined;
    if (state === undefined) return [];
    return [
      {
        id: document.id,
        name,
        state,
        results: state === "failed" ? 0 : (reading?.results ?? 0),
        toCheck: state === "failed" ? 0 : (reading?.toCheck ?? 0),
      },
    ];
  });
}

/**
 * The record's reads for the screens, on Rufi's read-only connection. `now`
 * is the Mac's local time, read on each call, for when follow-ups are due.
 */
export function recordViews(store: Store, now: () => Date = () => new Date()) {
  const read = <A>(work: (db: Db) => Promise<A>) =>
    store.query.transaction().execute(work);
  return {
    /**
     * Overview with the follow-ups that need the person, but not the
     * documents; undefined when the person isn't in Rufi.
     */
    overview: (personId: string) =>
      read(
        async (
          db,
        ): Promise<
          | (Omit<Overview, "needsYou"> & {
              needsYou: Pick<Overview["needsYou"], "followUps">;
            })
          | undefined
        > => {
          const person = await db
            .selectFrom("people")
            .select("display_name")
            .where("id", "=", personId)
            .executeTakeFirst();
          if (!person) return undefined;
          const tiles = [];
          for (const kind of Object.keys(PAGES) as PageKind[]) {
            tiles.push(await tile(db, personId, kind));
          }
          const placed = await followUps(db, personId, now());
          return {
            person: person.display_name,
            needsYou: {
              followUps: placed.flatMap(({ group, row }): FollowUpNeed[] =>
                isNeed(group) && !("problem" in row) && row.kind === "follow_up"
                  ? [{ state: group, followUp: row }]
                  : [],
              ),
            },
            tiles,
            recent: await recent(db, personId),
            openFollowUps: placed.filter(
              ({ group }) => group !== "done" && group !== "dropped",
            ).length,
          };
        },
      ),
    /** The person's follow-ups in the Follow-ups page's groups. */
    followUps: (personId: string) =>
      read(async (db): Promise<FollowUps> => {
        const groups = new Map<FollowUpGroup, ShownRow[]>();
        for (const { group, row } of await followUps(db, personId, now())) {
          groups.set(group, [...(groups.get(group) ?? []), row]);
        }
        return {
          groups: [...groups].map(([group, rows]) => ({ group, rows })),
        };
      }),
    page: (personId: string, kind: PageKind, after?: string) =>
      read((db) => page(db, personId, kind, after)),
    detail: (personId: string, kind: string, id: string) =>
      read((db) => detail(db, personId, kind, id)),
    series: (
      personId: string,
      test: string,
      unit: string | null,
      category: ResultCategory,
    ) => read((db) => series(db, personId, test, unit, category)),
  };
}

export type RecordViews = ReturnType<typeof recordViews>;
