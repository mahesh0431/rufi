// Export: everything in the record, the chat and settings, as one zip
// a person can open without Rufi. Every table as JSON (exact) and CSV (for a
// spreadsheet), every original document file as it came, with a README. Made from one fixed copy of the database, so
// a save is in it whole or not at all, and read back against that copy
// before it is given out. Never the sign-in, the AI's files or logs: they
// aren't in the database.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { filesPath, OriginalMissing } from "../documents/originals.ts";
import { CheckFailed, copyDatabase } from "./backup.ts";
import type { FileGate } from "../documents/gate.ts";
import { databasePath } from "./database.ts";

type Value = string | number | null;
interface Table {
  name: string;
  columns: string[];
  rows: Value[][];
}

const STAGING = ".export-";
const VERSION = 1;

/** Every table of a database, rows in a fixed order, values as JSON keeps them. */
function readTables(path: string): Table[] {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row["name"]));
    return names.map((name) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
        .all(name)
        .map((row) => String(row["name"]));
      const statement = db.prepare(
        `SELECT * FROM ${quoted} ORDER BY ${columns.map((_, i) => String(i + 1)).join(", ")}`,
      );
      statement.setReturnArrays(true);
      const rows = (statement.all() as unknown as unknown[][]).map((row) =>
        row.map((value) => valueOf(value, name)),
      );
      return { name, columns, rows };
    });
  } finally {
    db.close();
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
  throw new CheckFailed(`${table} holds a value the export can't write.`);
}

/** A CSV field: text always in quotes, a number as it is, no value as nothing. */
function field(value: Value): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return `"${value.replaceAll('"', '""')}"`;
}

function toCsv(table: Table): string {
  const lines = [
    table.columns.map(field),
    ...table.rows.map((row) => row.map(field)),
  ];
  return lines.map((cells) => `${cells.join(",")}\r\n`).join("");
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
  tables: Table[],
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
- \`results\`: your lab results and measurements, as printed. Its
  \`category\` column says which each one is: \`lab\` (on Lab results) or
  \`measurement\` (on Measurements). Results saved before Rufi had
  categories count as \`lab\`.
- \`record_sources\`: where each record came from: your message, or a page
  of a document.

Dates and times are as Rufi stored them: ISO 8601, times in UTC; a date you
gave in your own words keeps those words next to it.

Not in this export: your ChatGPT sign-in, the AI's working files, Rufi's
log, the list of AI models (\`models.json\`), and the JPEG copies Rufi
makes to show HEIC photos.

The tables (${String(tables.length)}):

${tables.map((t) => `- \`${t.name}\`: ${String(t.rows.length)} rows`).join("\n")}

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
function exportName(table: Table, row: Value[]): string {
  const id = String(row[table.columns.indexOf("id")]);
  const type = String(row[table.columns.indexOf("media_type")]);
  return `files/${id}.${EXTENSIONS[type] ?? "bin"}`;
}

const hashOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The export as zip bytes and its file name. Made from one fixed copy of the
 * database in the data folder, checked against it, then the copy is removed.
 * The copy and the reading of its originals are inside the running Rufi's
 * file `gate`, so a delete never removes an original the copy names.
 */
export async function exportZip(
  home: string,
  now: Date,
  gate?: FileGate,
): Promise<{ name: string; bytes: Uint8Array }> {
  const folder = `rufi-export-${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const staging = await mkdtemp(join(home, STAGING));
  try {
    const copy = join(staging, "rufi.sqlite");
    const read = async () => {
      await copyDatabase(databasePath(home), copy);
      const tables = readTables(copy);
      const bytes = new Map<string, Uint8Array>();
      for (const row of tables.find((t) => t.name === "files")?.rows ?? []) {
        const id = String(row[0]);
        bytes.set(
          id,
          await readFile(join(filesPath(home), id)).catch((error: unknown) => {
            throw new OriginalMissing(`The document file ${id} is missing.`, {
              cause: error,
            });
          }),
        );
      }
      return { tables, bytes };
    };
    const { tables, bytes: originalBytes } = await (gate
      ? gate.run(read)
      : read());
    const createdAt = now.toISOString();
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
      [`${folder}/README.md`]: strToU8(README(folder, createdAt, tables)),
      [`${folder}/export.json`]: strToU8(
        `${JSON.stringify(
          {
            format: "rufi-export",
            version: VERSION,
            createdAt,
            tables: Object.fromEntries(
              tables.map((t) => [
                t.name,
                { columns: t.columns, rows: t.rows.length },
              ]),
            ),
          },
          null,
          2,
        )}\n`,
      ),
    };
    const originals = tables.find((t) => t.name === "files");
    for (const row of originals?.rows ?? []) {
      const id = String(row[0]);
      const bytes = originalBytes.get(id) ?? new Uint8Array();
      if (hashOf(bytes) !== id) {
        throw new OriginalMissing(`The document file ${id} has changed.`);
      }
      // Already compressed (PDFs, photos): stored as they are.
      files[`${folder}/${exportName(originals as Table, row)}`] = [
        bytes,
        { level: 0 },
      ];
    }
    for (const table of tables) {
      files[`${folder}/json/${table.name}.json`] = strToU8(
        `${JSON.stringify(
          {
            table: table.name,
            columns: table.columns,
            rows: table.rows.map((row) =>
              Object.fromEntries(
                table.columns.map((c, i) => [c, row[i] ?? null]),
              ),
            ),
          },
          null,
          2,
        )}\n`,
      );
      files[`${folder}/csv/${table.name}.csv`] = strToU8(toCsv(table));
    }
    const bytes = zipSync(files);
    checkExport(bytes, folder, tables);
    return { name: `${folder}.zip`, bytes };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Reads the zip back and compares every table, row and value, in JSON and
 * in CSV, with the copy it was made from. Throws when anything differs.
 */
function checkExport(
  bytes: Uint8Array,
  folder: string,
  tables: readonly Table[],
): void {
  const files = unzipSync(bytes);
  const originals = tables.find((t) => t.name === "files");
  const expected = new Set([
    `${folder}/README.md`,
    `${folder}/export.json`,
    ...tables.flatMap((t) => [
      `${folder}/json/${t.name}.json`,
      `${folder}/csv/${t.name}.csv`,
    ]),
    ...(originals?.rows ?? []).map(
      (row) => `${folder}/${exportName(originals as Table, row)}`,
    ),
  ]);
  const names = Object.keys(files);
  if (names.length !== expected.size || names.some((n) => !expected.has(n))) {
    throw new CheckFailed("The export doesn't hold the files it should.");
  }
  const text = (name: string) =>
    strFromU8(files[`${folder}/${name}`] ?? new Uint8Array());
  for (const row of originals?.rows ?? []) {
    const name = exportName(originals as Table, row);
    if (hashOf(files[`${folder}/${name}`] ?? new Uint8Array()) !== row[0]) {
      throw new CheckFailed(`The export's ${name} differs from the original.`);
    }
  }
  for (const table of tables) {
    const json = JSON.parse(text(`json/${table.name}.json`)) as {
      columns: string[];
      rows: Record<string, Value>[];
    };
    const columns = JSON.stringify(table.columns);
    if (
      JSON.stringify(json.columns) !== columns ||
      // Every row has every column: a missing value isn't the same as null.
      json.rows.some((row) => JSON.stringify(Object.keys(row)) !== columns) ||
      JSON.stringify(
        json.rows.map((row) => table.columns.map((c) => row[c])),
      ) !== JSON.stringify(table.rows)
    ) {
      throw new CheckFailed(
        `The export's ${table.name}.json differs from the record.`,
      );
    }
    const asCsv = (value: Value) => (value === null ? null : String(value));
    const csv = fromCsv(text(`csv/${table.name}.csv`));
    const wanted = [table.columns, ...table.rows.map((row) => row.map(asCsv))];
    if (JSON.stringify(csv) !== JSON.stringify(wanted)) {
      throw new CheckFailed(
        `The export's ${table.name}.csv differs from the record.`,
      );
    }
  }
}

/** Removes the copy a stopped export left. Only while Rufi holds the data folder. */
export async function cleanExportStaging(home: string): Promise<void> {
  const names = await readdir(home).catch(() => []);
  for (const name of names.filter((n) => n.startsWith(STAGING))) {
    await rm(join(home, name), { recursive: true, force: true });
  }
}
