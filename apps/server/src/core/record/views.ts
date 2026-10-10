// The record as its screens show it: Overview's tiles and latest saves, a
// page per kind in groups (a report whole, a day of typed results, or one
// row), a row with its sources and history, and a test's series. Read only,
// for one person, each answer from one read transaction so it is
// consistent. "Current" is read.ts's isCurrent, as everywhere else.
import type {
  BadRow,
  Overview,
  PageKind,
  RecentChange,
  RecordChange,
  RecordDetail,
  RecordGroup,
  RecordPage,
  RecordSource,
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
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { kindNamed, type Kind, type Row } from "./kinds.ts";
import { changed, fieldsOf, isCurrent } from "./read.ts";

/** Groups on one page: reports are big, other kinds' groups are one row. */
const GROUPS_PER_PAGE = { result: 10, other: 30 };
/** Latest saves on Overview. */
export const RECENT_SHOWN = 5;
/** Names a tile shows at most. */
const NAMES_SHOWN = 3;

/** The kinds each page shows: allergies' page has the "none known" statements too. */
const PAGE_KINDS: Record<PageKind, readonly string[]> = {
  result: ["result"],
  medicine_use: ["medicine_use"],
  prescription: ["prescription"],
  condition: ["condition"],
  allergy: ["allergy", "none_known"],
  symptom: ["symptom"],
  care_event: ["care_event"],
};

/** Whether `kind` names a page. */
export const isPageKind = (kind: string): kind is PageKind =>
  Object.hasOwn(PAGE_KINDS, kind);

/** A cursor that isn't one this read gave. */
export class BadCursor extends Error {}

type Db = Kysely<Tables>;
const kindOf = (name: string) => kindNamed(name) as Kind;

/** A calendar date, not 'next_visit', words or none. */
const calendar = (date: RawBuilder<unknown>) =>
  sql`${date} GLOB '[0-9][0-9][0-9][0-9]*'`;

/**
 * Each current record's group and the group's date. A result read from a
 * report belongs to the report, dated when its sample was collected; a
 * typed one to its day (or month or year, at the precision known); any
 * other record is a group of its own.
 */
function grouped(kind: Kind, personId: string) {
  if (kind.name === "result") {
    const measured = sql`r.measured_at`;
    const gid = sql<string>`CASE WHEN r.report_id IS NOT NULL THEN 'report:' || r.report_id WHEN ${calendar(measured)} THEN 'chat:' || substr(r.measured_at, 1, 10) ELSE 'chat:' END`;
    const date = sql`CASE WHEN r.report_id IS NOT NULL THEN p.collected ELSE substr(r.measured_at, 1, 10) END`;
    return {
      gid,
      keys: sql`SELECT ${gid} AS gid, ${date} AS d FROM results r LEFT JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id WHERE r.person_id = ${personId} AND ${isCurrent(kind, "r")}`,
    };
  }
  const field = kind.fields[kind.dated];
  const dated = sql.ref(`r.${field?.column ?? kind.dated}`);
  // Allergies with no reaction date sort by the day the user said them.
  const date = kind.asserted ? sql`coalesce(${dated}, r.asserted)` : dated;
  const gid = sql<string>`${kind.name} || ':' || r.id`;
  return {
    gid,
    keys: sql`SELECT ${gid} AS gid, ${date} AS d FROM ${sql.table(kind.table)} r WHERE r.person_id = ${personId} AND ${isCurrent(kind, "r")}`,
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
  kinds: readonly Kind[],
  after: Key | undefined,
  limit: number,
) {
  const all = sql.join(
    kinds.map((kind) => grouped(kind, personId).keys),
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
  gids: readonly string[],
) {
  if (gids.length === 0) return [];
  const { gid } = grouped(kind, personId);
  const report =
    kind.name === "result"
      ? sql`, p.issuer AS report_issuer FROM results r LEFT JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id`
      : sql` FROM ${sql.table(kind.table)} r`;
  const { rows } = await sql<Row>`
    SELECT r.*, ${gid} AS gid${report}
    WHERE r.person_id = ${personId} AND ${isCurrent(kind, "r")} AND ${gid} IN (${sql.join(gids)})
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
  const kinds = PAGE_KINDS[pageKind].map(kindOf);
  const size =
    pageKind === "result" ? GROUPS_PER_PAGE.result : GROUPS_PER_PAGE.other;
  const keys = await groupKeys(
    db,
    personId,
    kinds,
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
  for (const kind of kinds) {
    const rows = await members(
      db,
      personId,
      kind,
      mine.map((key) => key.gid),
    );
    for (const row of rows) {
      const group = groups.get(String(row["gid"]));
      if (!group) continue;
      if (
        typeof row["report_issuer"] === "string" &&
        group.issuer === undefined
      ) {
        group.issuer = row["report_issuer"];
      }
      group.rows.push(shown(kind, row));
    }
  }
  const last = mine.at(-1);
  return {
    groups: [...groups.values()],
    next: keys.length > size && last ? encodeCursor(last) : null,
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
    .leftJoin("transcript_entries as e", (join) =>
      join
        .onRef("e.person_id", "=", "s.person_id")
        .onRef("e.id", "=", "s.entry_id"),
    )
    .select([
      "s.type",
      "s.entry_id",
      "s.document_id",
      "s.page",
      "p.file_name",
      "e.text",
      "e.created_at",
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
      : {
          type: "document",
          document: source.document_id ?? "",
          page: source.page ?? 0,
          file: source.file_name ?? "",
        },
  );
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

/** Every current value of one test in one unit: dated oldest first, then undated. */
async function series(
  db: Db,
  personId: string,
  test: string,
  unit: string | null,
): Promise<Series> {
  const kind = kindOf("result");
  const { rows } = await sql<Row>`
    SELECT r.* FROM results r
    WHERE r.person_id = ${personId} AND r.test_name = ${test}
      AND ${unit === null ? sql`r.unit IS NULL` : sql`r.unit = ${unit}`}
      AND ${isCurrent(kind, "r")}
    ORDER BY ${calendar(sql`r.measured_at`)} DESC, r.measured_at, r.entered_at, r.rowid`.execute(
    db,
  );
  return { test, unit, values: rows.map((row) => shown(kind, row)) };
}

/** A kind's tile: its count and what it counts. */
async function tile(
  db: Db,
  personId: string,
  pageKind: PageKind,
): Promise<Tile> {
  const kind = kindOf(pageKind);
  const current = sql`FROM ${sql.table(kind.table)} r WHERE r.person_id = ${personId} AND ${isCurrent(kind, "r")}`;
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
  if (pageKind === "result") {
    const results = first.rows.filter(
      (r): r is ResultRow => r.kind === "result" && !("problem" in r),
    );
    return {
      ...base,
      latest: {
        label:
          first.issuer ??
          (first.type === "report" ? "A report" : "Typed in the chat"),
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

/** Documents waiting for the person: read and not saved, or a reading that failed. */
export function waiting(
  documents: readonly DocumentSummary[],
): WaitingDocument[] {
  return documents.flatMap((document): WaitingDocument[] => {
    const name = document.files.map((file) => file.name).join(", ");
    const reading = document.reading;
    if (document.status === "failed") {
      return [
        { id: document.id, name, state: "failed", results: 0, toCheck: 0 },
      ];
    }
    if (document.status === "done" && reading && reading.results > 0) {
      return [
        {
          id: document.id,
          name,
          state: "to_save",
          results: reading.results,
          toCheck: reading.toCheck,
        },
      ];
    }
    return [];
  });
}

/** The record's reads for the screens, on Rufi's read-only connection. */
export function recordViews(store: Store) {
  const read = <A>(work: (db: Db) => Promise<A>) =>
    store.query.transaction().execute(work);
  return {
    /** Overview without Needs you; undefined when the person isn't in Rufi. */
    overview: (personId: string) =>
      read(async (db): Promise<Omit<Overview, "needsYou"> | undefined> => {
        const person = await db
          .selectFrom("people")
          .select("display_name")
          .where("id", "=", personId)
          .executeTakeFirst();
        if (!person) return undefined;
        const tiles = [];
        for (const kind of Object.keys(PAGE_KINDS) as PageKind[]) {
          tiles.push(await tile(db, personId, kind));
        }
        return {
          person: person.display_name,
          tiles,
          recent: await recent(db, personId),
        };
      }),
    page: (personId: string, kind: PageKind, after?: string) =>
      read((db) => page(db, personId, kind, after)),
    detail: (personId: string, kind: string, id: string) =>
      read((db) => detail(db, personId, kind, id)),
    series: (personId: string, test: string, unit: string | null) =>
      read((db) => series(db, personId, test, unit)),
  };
}

export type RecordViews = ReturnType<typeof recordViews>;
