import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteDialect } from "./dialect.ts";
import type { Tables } from "./tables.ts";

const SCHEMA = readFileSync(new URL("schema.sql", import.meta.url), "utf8");

let db: DatabaseSync;
let query: Kysely<Tables>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  query = new Kysely<Tables>({ dialect: new NodeSqliteDialect(db) });
});

const names = () =>
  db.prepare("SELECT display_name FROM people ORDER BY id").all();

describe("Rufi's node:sqlite dialect", () => {
  it("returns the rows of a write with RETURNING", async () => {
    const rows = await query
      .insertInto("people")
      .values([
        { id: "a", display_name: "Asha Fictional" },
        { id: "b", display_name: "Ravi Fictional" },
      ])
      .returning(["id", "display_name"])
      .execute();
    expect(rows).toEqual([
      { id: "a", display_name: "Asha Fictional" },
      { id: "b", display_name: "Ravi Fictional" },
    ]);
  });

  it("reports how many rows a write changed", async () => {
    await query
      .insertInto("people")
      .values({ id: "a", display_name: "Asha Fictional" })
      .execute();
    const [result] = await query
      .updateTable("people")
      .set({ display_name: "Asha F." })
      .where("id", "=", "a")
      .execute();
    expect(result?.numUpdatedRows).toBe(1n);
  });

  it("gives a large row id exactly", async () => {
    const result = await sql`INSERT INTO people (rowid, id, display_name)
      VALUES (9007199254740993, 'a', 'Asha Fictional')`.execute(query);
    expect(result.insertId).toBe(9007199254740993n);
  });

  it("commits a transaction, and rolls back a failed one completely", async () => {
    await query.transaction().execute(async (tx) => {
      await tx
        .insertInto("people")
        .values({ id: "a", display_name: "Asha Fictional" })
        .execute();
    });
    await expect(
      query.transaction().execute(async (tx) => {
        await tx
          .insertInto("people")
          .values({ id: "b", display_name: "Ravi Fictional" })
          .execute();
        throw new Error("fictional failure");
      }),
    ).rejects.toThrow("fictional failure");
    expect(names()).toEqual([{ display_name: "Asha Fictional" }]);
  });

  it("gives a full disk's own error when SQLite rolled the transaction back itself", async () => {
    const { page_count } = db.prepare("PRAGMA page_count").get() as { page_count: number };
    db.exec(`PRAGMA max_page_count = ${String(page_count)}`);
    await expect(
      query.transaction().execute(async (tx) => {
        for (let n = 0; n < 500; n++) {
          await tx
            .insertInto("people")
            .values({ id: String(n), display_name: "Fictional ".repeat(50) })
            .execute();
        }
      }),
    ).rejects.toMatchObject({ errcode: 13 });
    expect(db.isTransaction).toBe(false);
  });

  it("runs one transaction at a time on the one connection", async () => {
    const order: string[] = [];
    const slow = query.transaction().execute(async (tx) => {
      order.push("first begins");
      await tx
        .insertInto("people")
        .values({ id: "a", display_name: "Asha Fictional" })
        .execute();
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first ends");
    });
    const next = query.transaction().execute(async (tx) => {
      order.push("second begins");
      await tx
        .insertInto("people")
        .values({ id: "b", display_name: "Ravi Fictional" })
        .execute();
    });
    await Promise.all([slow, next]);
    expect(order).toEqual(["first begins", "first ends", "second begins"]);
    expect(names()).toHaveLength(2);
  });

  it("leaves the connection open when Kysely is closed", async () => {
    await query.destroy();
    expect(db.isOpen).toBe(true);
  });
});
