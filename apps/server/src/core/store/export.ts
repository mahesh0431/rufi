// Export: everything in the record, the chat and settings, as one zip
// a person can open without Rufi. Every table as JSON (exact) and CSV (for a
// spreadsheet), every original document file as it came, with a README.
// Made from one fixed copy of the database, so a save is in it whole or not
// at all, and read back against that copy before it is given out. Never the
// sign-in, the AI's files or logs: they aren't in the database.
//
// It is streamed (ADR 0023): each table is read row by row and written into
// its zip entry in chunks, each chunk on disk before the next is read, and
// checked the same way, so years of device data never sit in memory whole.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { DEVICE_TYPES } from "../devices/types.ts";
import { filesPath, OriginalMissing } from "../documents/originals.ts";
import { CheckFailed, copyDatabase } from "./backup.ts";
import type { FileGate } from "../documents/gate.ts";
import { databasePath } from "./database.ts";

type Value = string | number | null;
/** A table of the export: its columns and how many rows it has. */
interface TableInfo {
  name: string;
  columns: string[];
  rows: number;
}

/** A made export, checked, in its staging folder until it is removed. */
export interface MadeExport {
  name: string;
  path: string;
  size: number;
  /** Removes the zip and its staging folder. */
  remove: () => Promise<void>;
}

const STAGING = ".export-";
const VERSION = 1;
/** Text gathered before it goes into a zip entry. */
const CHUNK_CHARS = 256 * 1024;
const DEVICE_TYPES_TABLE = "device_types";

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every table of the copy, with its row count, then Rufi's type list
 * (core/devices/types.ts), which device_values.type names: with it, the
 * values can be read without Rufi.
 */
function tablesOf(db: DatabaseSync): TableInfo[] {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row["name"]));
  return [
    ...names.map((name) => ({
      name,
      columns: db
        .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
        .all(name)
        .map((row) => String(row["name"])),
      rows: Number(
        db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(name)}`).get()?.["n"],
      ),
    })),
    {
      name: DEVICE_TYPES_TABLE,
      columns: ["key", "label", "unit", "loinc"],
      rows: DEVICE_TYPES.length,
    },
  ];
}

/** A table's rows one by one, in a fixed order, values as JSON keeps them. */
function* rowsOf(db: DatabaseSync, table: TableInfo): Generator<Value[]> {
  if (table.name === DEVICE_TYPES_TABLE) {
    for (const type of DEVICE_TYPES) {
      yield [type.key, type.label, type.unit, type.loinc];
    }
    return;
  }
  const statement = db.prepare(
    `SELECT * FROM ${quoted(table.name)} ORDER BY ${table.columns.map((_, i) => String(i + 1)).join(", ")}`,
  );
  statement.setReturnArrays(true);
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    yield row.map((value) => valueOf(value, table.name));
  }
}

function valueOf(value: unknown, table: string): Value {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new CheckFailed(
        `A number in ${table} is too large to export exactly.`,
      );
    }
    return Number(value);
  }
  if (typeof value === "number") return value;
  // Bytes (a device batch as it came) as base64 text.
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  throw new CheckFailed(`${table} holds a value the export can't write.`);
}

/** A CSV field: text always in quotes, a number as it is, no value as nothing. */
function field(value: Value): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return `"${value.replaceAll('"', '""')}"`;
}

const asCsv = (value: Value) => (value === null ? null : String(value));

/** A row of a table's JSON file, as JSON.stringify writes it at that depth. */
function jsonRow(table: TableInfo, row: Value[]): string {
  return JSON.stringify(
    Object.fromEntries(table.columns.map((c, i) => [c, row[i] ?? null])),
    null,
    2,
  ).replaceAll("\n", "\n    ");
}

/**
 * A table's JSON file, piece by piece: the same text as
 * JSON.stringify({ table, columns, rows }, null, 2). With `check`, each row
 * must read back as its values.
 */
function* jsonText(
  table: TableInfo,
  rows: Iterable<Value[]>,
  check = false,
): Generator<string> {
  const head = JSON.stringify(
    { table: table.name, columns: table.columns, rows: [] },
    null,
    2,
  );
  if (table.rows === 0) {
    yield `${head}\n`;
    return;
  }
  yield `${head.slice(0, -"[]\n}".length)}[\n`;
  const columns = JSON.stringify(table.columns);
  let first = true;
  for (const row of rows) {
    const text = jsonRow(table, row);
    if (check) {
      const read = JSON.parse(text) as Record<string, Value>;
      // Every row has every column: a missing value isn't the same as null.
      if (
        JSON.stringify(Object.keys(read)) !== columns ||
        JSON.stringify(table.columns.map((c) => read[c])) !==
          JSON.stringify(row)
      ) {
        throw new CheckFailed(
          `The export's ${table.name}.json differs from the record.`,
        );
      }
    }
    yield `${first ? "" : ",\n"}    ${text}`;
    first = false;
  }
  yield "\n  ]\n}\n";
}

/**
 * A table's CSV file, line by line. With `check`, each line must read back
 * as its values.
 */
function* csvText(
  table: TableInfo,
  rows: Iterable<Value[]>,
  check = false,
): Generator<string> {
  const header = `${table.columns.map(field).join(",")}\r\n`;
  if (
    check &&
    JSON.stringify(fromCsv(header)) !== JSON.stringify([table.columns])
  ) {
    throw new CheckFailed(
      `The export's ${table.name}.csv differs from the record.`,
    );
  }
  yield header;
  for (const row of rows) {
    const line = `${row.map(field).join(",")}\r\n`;
    if (
      check &&
      JSON.stringify(fromCsv(line)) !== JSON.stringify([row.map(asCsv)])
    ) {
      throw new CheckFailed(
        `The export's ${table.name}.csv differs from the record.`,
      );
    }
    yield line;
  }
}

/** Text pieces as bytes, a few hundred kilobytes at a time. */
function* bytesOf(pieces: Iterable<string>): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  let gathered: string[] = [];
  let size = 0;
  for (const piece of pieces) {
    gathered.push(piece);
    size += piece.length;
    if (size >= CHUNK_CHARS) {
      yield encoder.encode(gathered.join(""));
      gathered = [];
      size = 0;
    }
  }
  if (size > 0) yield encoder.encode(gathered.join(""));
}

/**
 * Reads the CSV back: a quoted field is text (possibly empty), an unquoted
 * one is a number as written, or no value when empty.
 */
function fromCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let i = 0;
  while (i < text.length) {
    let cell: string | null;
    if (text[i] === '"') {
      let end = i + 1;
      let out = "";
      for (;;) {
        const next = text.indexOf('"', end);
        if (next < 0) throw new CheckFailed("A CSV field isn't closed.");
        out += text.slice(end, next);
        if (text[next + 1] === '"') {
          out += '"';
          end = next + 2;
          continue;
        }
        i = next + 1;
        break;
      }
      cell = out;
    } else {
      let end = i;
      while (end < text.length && text[end] !== "," && text[end] !== "\r")
        end++;
      cell = end === i ? null : text.slice(i, end);
      i = end;
    }
    row.push(cell);
    if (text[i] === ",") {
      i++;
    } else if (text.startsWith("\r\n", i)) {
      rows.push(row);
      row = [];
      i += 2;
    } else {
      throw new CheckFailed("A CSV line isn't as written.");
    }
  }
  return rows;
}

const README = (
  folder: string,
  createdAt: string,
  tables: readonly TableInfo[],
) => `# Your Rufi data

Exported from Rufi on ${createdAt}. This is everything in your health
record, your chat, your documents and Rufi's settings, as Rufi stored it.

- \`json/\`: one file per table. Each file holds the table's name, its
  columns, and its rows, each row an object of column and value. A value
  is text, a number, or \`null\` (no value). This is the exact copy.
- \`csv/\`: the same tables, for a spreadsheet. The first line names the
  columns. Text is always in double quotes, with a double quote inside it
  written twice; it may span lines. A number has no quotes. An empty field
  without quotes means no value; \`""\` means empty text. UTF-8, lines end
  with CRLF.
- \`export.json\`: the export's format and version, and each table's columns
  and number of rows.
- \`files/\`: your original documents (PDFs and photos), exactly as you
  added them. Each is named by its SHA-256 hash, as in the \`files\` table,
  with an extension for its type. \`document_pages\` says which document
  and page each file is, and the name it had when you added it. A document
  you deleted has \`deleted_at\` in \`documents\`, and its pages have no file.
- \`draft_items\`: what Rufi's reader read from your documents, each not
  saved yet, saved, or dismissed. Not your record: Rufi counts one nowhere
  until you save it.
- \`page_copies\`: the reader's copy of a page of your documents, as
  Markdown, exactly as it wrote it, with its marks where something was
  unclear. One for each page and reading. Not your record either.
- \`results\`: your lab results and measurements, as printed. Its
  \`category\` column says which each one is: \`lab\` (on Lab results) or
  \`measurement\` (on Measurements). Results saved before Rufi had
  categories count as \`lab\`.
- \`visits\`: your visits to a doctor, each with the doctor's words as
  written (\`as_written\`, Markdown).
- \`record_sources\`: where each record came from: your message, a page of
  a document, or a visit.
- \`device_values\`: what your devices measured (Apple Health), outside your
  record, each with its source's own ID. \`type\` is a key in
  \`device_types\`, which gives its name, unit (UCUM) and LOINC code; a
  value with \`removed_at\` was deleted at its source. \`device_sources\` is
  each connected device and whose it is.
- \`device_batches\`: each batch a device sent, kept for a while: \`body\` is
  the batch exactly as it came, as base64 of gzip of its JSON.
- \`device_types\`: Rufi's list of what device values measure. Not a table
  of Rufi's database: it is written from Rufi's own list.

Dates and times are as Rufi stored them: ISO 8601, times in UTC; a date you
gave in your own words keeps those words next to it.

Not in this export: your ChatGPT sign-in, the AI's working files, Rufi's
log, and the JPEG copies Rufi makes to show HEIC photos.

The tables (${String(tables.length)}):

${tables.map((t) => `- \`${t.name}\`: ${String(t.rows)} rows`).join("\n")}

The folder name is \`${folder}\`.
`;

const two = (n: number) => String(n).padStart(2, "0");

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** An original's name in the export: its id and an extension for its type. */
const exportName = (id: string, type: string) =>
  `files/${id}.${EXTENSIONS[type] ?? "bin"}`;

/** The originals the copy names: their ids and types, in a fixed order. */
const originalsOf = (db: DatabaseSync) =>
  db
    .prepare("SELECT id, media_type FROM files ORDER BY id")
    .all()
    .map((row) => ({ id: String(row["id"]), type: String(row["media_type"]) }));

/** Every byte a zip writer wrote: how many, and their SHA-256. */
interface Written {
  bytes: number;
  sha256: string;
}

/**
 * A zip being written to `path` through Node's write stream, which finishes
 * a short write itself; each entry's chunks are handed over before the next
 * is read. It counts and hashes every byte it writes, its directory and
 * end record too, for the check.
 */
async function zipFile(path: string, signal: AbortSignal | undefined) {
  const out = createWriteStream(path, {
    flags: "wx",
    mode: 0o600,
    flush: true,
  });
  await once(out, "open");
  const hash = createHash("sha256");
  const written = { bytes: 0 };
  const pending: Uint8Array[] = [];
  const failure: { error?: Error } = {};
  const zip = new Zip((error, chunk) => {
    if (error) failure.error = error;
    else pending.push(chunk);
  });
  const flush = async () => {
    if (failure.error) throw failure.error;
    signal?.throwIfAborted();
    for (let chunk = pending.shift(); chunk; chunk = pending.shift()) {
      hash.update(chunk);
      written.bytes += chunk.length;
      if (!out.write(chunk)) await once(out, "drain", { signal });
    }
  };
  return {
    add: async (
      name: string,
      chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
      // Already compressed (PDFs, photos): stored as they are.
      stored = false,
    ) => {
      const entry = stored ? new ZipPassThrough(name) : new ZipDeflate(name);
      zip.add(entry);
      for await (const chunk of chunks) {
        entry.push(chunk);
        await flush();
      }
      entry.push(new Uint8Array(0), true);
      await flush();
    },
    /** How many bytes are written so far: where the next entry starts. */
    offset: () => written.bytes,
    end: async (): Promise<Written> => {
      zip.end();
      await flush();
      out.end();
      await finished(out);
      return { bytes: written.bytes, sha256: hash.digest("hex") };
    },
    /**
     * Lets go of the file, written or not. After a failure, the stream's own
     * complaint about it (writes cut off) adds nothing to the cause.
     */
    close: async () => {
      out.destroy();
      await finished(out).catch(() => undefined);
    },
  };
}

/** An original's bytes in chunks, checked against its hash as they pass. */
async function* originalBytes(home: string, id: string) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(join(filesPath(home), id))) {
      hash.update(chunk as Buffer);
      yield chunk as Uint8Array;
    }
  } catch (error) {
    throw new OriginalMissing(`The document file ${id} is missing.`, {
      cause: error,
    });
  }
  if (hash.digest("hex") !== id) {
    throw new OriginalMissing(`The document file ${id} has changed.`);
  }
}

interface EntryCheck {
  push: (data: Uint8Array) => void;
  end: () => void;
}

/** Takes an entry's bytes as they come; they must be exactly `expected`. */
function sameBytes(
  expected: Iterator<Uint8Array>,
  differs: () => Error,
): EntryCheck {
  let have: Uint8Array = new Uint8Array(0);
  let at = 0;
  const more = () => {
    while (at >= have.length) {
      const next = expected.next();
      if (next.done === true) return false;
      have = next.value;
      at = 0;
    }
    return true;
  };
  return {
    push: (data) => {
      let from = 0;
      while (from < data.length) {
        if (!more()) throw differs();
        const n = Math.min(data.length - from, have.length - at);
        const got = Buffer.from(data.buffer, data.byteOffset + from, n);
        if (!got.equals(Buffer.from(have.buffer, have.byteOffset + at, n))) {
          throw differs();
        }
        from += n;
        at += n;
      }
    },
    end: () => {
      if (more()) throw differs();
    },
  };
}

/**
 * Reads the zip back in chunks. Every byte on disk, its directory and end
 * record too, must be the bytes written (their count and SHA-256). And every
 * entry but the originals must hold what it should: each table's JSON and
 * CSV made again from the copy (each row read back as its values), the
 * README and export.json. The originals were checked against their hashes as
 * they were written, and are skipped here: their bytes are stored as they
 * came, and could look like zip records to the reader. Throws when anything
 * differs or is missing.
 */
async function checkExport(
  path: string,
  folder: string,
  db: DatabaseSync,
  tables: readonly TableInfo[],
  fixed: Record<string, string>,
  written: Written,
  originals: { from: number; to: number },
  signal: AbortSignal | undefined,
): Promise<void> {
  const expected = new Map<string, () => EntryCheck>();
  for (const [name, text] of Object.entries(fixed)) {
    expected.set(`${folder}/${name}`, () =>
      sameBytes(
        bytesOf([text]),
        () => new CheckFailed(`The export's ${name} differs.`),
      ),
    );
  }
  for (const table of tables) {
    const differs = (kind: string) => () =>
      new CheckFailed(
        `The export's ${table.name}.${kind} differs from the record.`,
      );
    expected.set(`${folder}/json/${table.name}.json`, () =>
      sameBytes(
        bytesOf(jsonText(table, rowsOf(db, table), true)),
        differs("json"),
      ),
    );
    expected.set(`${folder}/csv/${table.name}.csv`, () =>
      sameBytes(
        bytesOf(csvText(table, rowsOf(db, table), true)),
        differs("csv"),
      ),
    );
  }

  const holds = () =>
    new CheckFailed("The export doesn't hold the files it should.");
  const seen = new Set<string>();
  const found: { problem?: Error } = {};
  const unzip = new Unzip((file) => {
    const make = expected.get(file.name);
    if (make === undefined || seen.has(file.name)) {
      found.problem ??= holds();
      return;
    }
    seen.add(file.name);
    const check = make();
    file.ondata = (error, data, final) => {
      if (found.problem !== undefined) return;
      try {
        if (error) throw error;
        check.push(data);
        if (final) check.end();
      } catch (problem) {
        found.problem =
          problem instanceof Error ? problem : new CheckFailed(String(problem));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const read = createHash("sha256");
  let at = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    signal?.throwIfAborted();
    read.update(chunk);
    // The parts of the chunk before and after the originals.
    const end = at + chunk.length;
    const before = chunk.subarray(
      0,
      Math.max(0, Math.min(end, originals.from) - at),
    );
    const after = chunk.subarray(
      Math.max(0, Math.min(chunk.length, originals.to - at)),
    );
    if (before.length > 0) unzip.push(before);
    if (after.length > 0 && end > originals.to) unzip.push(after);
    at = end;
    if (found.problem !== undefined) throw found.problem;
  }
  if (at !== written.bytes || read.digest("hex") !== written.sha256) {
    throw new CheckFailed("The export on disk isn't the zip that was written.");
  }
  unzip.push(new Uint8Array(0), true);
  if (found.problem !== undefined) throw found.problem;
  if (seen.size !== expected.size) throw holds();
}

/**
 * The export, made and checked in a staging folder in the data folder: its
 * file name, where it is, and how to remove it once it is sent. Made from one
 * fixed copy of the database and checked against it. The copy and the
 * reading of its originals are inside the running Rufi's file `gate`, so a
 * delete never removes an original the copy names.
 */
export async function exportZip(
  home: string,
  now: Date,
  gate?: FileGate,
  /** The person went (the request was cut): stop and remove what was made. */
  signal?: AbortSignal,
): Promise<MadeExport> {
  const folder = `rufi-export-${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const staging = await mkdtemp(join(home, STAGING));
  const remove = () => rm(staging, { recursive: true, force: true });
  try {
    const copy = join(staging, "rufi.sqlite");
    const path = join(staging, `${folder}.zip`);
    const zip = await zipFile(path, signal);
    const originals = { from: 0, to: 0 };
    const opened: { db?: DatabaseSync } = {};
    try {
      const createdAt = now.toISOString();
      // The copy and every original it names, while no delete can remove one.
      const withOriginals = async () => {
        await copyDatabase(databasePath(home), copy);
        const db = new DatabaseSync(copy, {
          readOnly: true,
          readBigInts: true,
        });
        opened.db = db;
        const tables = tablesOf(db);
        const fixed = {
          "README.md": README(folder, createdAt, tables),
          "export.json": `${JSON.stringify(
            {
              format: "rufi-export",
              version: VERSION,
              createdAt,
              tables: Object.fromEntries(
                tables.map((t) => [
                  t.name,
                  { columns: t.columns, rows: t.rows },
                ]),
              ),
            },
            null,
            2,
          )}\n`,
        };
        for (const [name, text] of Object.entries(fixed)) {
          await zip.add(`${folder}/${name}`, bytesOf([text]));
        }
        originals.from = zip.offset();
        for (const { id, type } of originalsOf(db)) {
          await zip.add(
            `${folder}/${exportName(id, type)}`,
            originalBytes(home, id),
            true,
          );
        }
        originals.to = zip.offset();
        return { db, tables, fixed };
      };
      const { db, tables, fixed } = await (gate
        ? gate.shared(withOriginals)
        : withOriginals());
      for (const table of tables) {
        await zip.add(
          `${folder}/json/${table.name}.json`,
          bytesOf(jsonText(table, rowsOf(db, table))),
        );
        await zip.add(
          `${folder}/csv/${table.name}.csv`,
          bytesOf(csvText(table, rowsOf(db, table))),
        );
      }
      const written = await zip.end();
      await checkExport(
        path,
        folder,
        db,
        tables,
        fixed,
        written,
        originals,
        signal,
      );
    } finally {
      opened.db?.close();
      await zip.close();
    }
    await rm(copy, { force: true });
    const { size } = await stat(path);
    return { name: `${folder}.zip`, path, size, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Removes the copy a stopped export left. Only while Rufi holds the data folder. */
export async function cleanExportStaging(home: string): Promise<void> {
  const names = await readdir(home).catch(() => []);
  for (const name of names.filter((n) => n.startsWith(STAGING))) {
    await rm(join(home, name), { recursive: true, force: true });
  }
}
