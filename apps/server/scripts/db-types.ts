// Writes src/core/store/tables.ts, the column types Kysely checks queries
// against, from schema.sql. A test checks the committed copy.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STORE = join(import.meta.dirname, "../src/core/store");
export const TABLES_TS = join(STORE, "tables.ts");

/** SQLite's STRICT column types as node:sqlite returns them. */
const TS_TYPES: Record<string, string> = {
  TEXT: "string",
  INTEGER: "number",
  REAL: "number",
  BLOB: "Uint8Array",
  ANY: "unknown",
};

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export function tablesTs(schemaSql: string): string {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as { name: string }[];
    const body = tables.map(({ name }) => {
      const columns = db
        .prepare(`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`)
        .all(name) as unknown as Column[];
      const fields = columns.map((column) => {
        const type = TS_TYPES[column.type];
        if (type === undefined) {
          throw new Error(
            `${name}.${column.name}: no TypeScript type for ${column.type}`,
          );
        }
        // A STRICT table's primary key can't be null.
        const nullable = column.notnull === 0 && column.pk === 0;
        return `    ${column.name}: ${type}${nullable ? " | null" : ""};`;
      });
      return `  ${name}: {\n${fields.join("\n")}\n  };`;
    });
    return `// Generated from schema.sql by pnpm db:types; a test fails if it differs.\nexport interface Tables {\n${body.join("\n")}\n}\n`;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  writeFileSync(
    TABLES_TS,
    tablesTs(readFileSync(join(STORE, "schema.sql"), "utf8")),
  );
}
