import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

const schema = readFileSync(new URL("schema.sql", import.meta.url), "utf8");
const now = "2026-09-30T10:00:00Z";

let db: DatabaseSync;

function insert(
  table: string,
  row: Record<string, string | number | null>,
): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

// Two fictional people, each with one document and one report.
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  insert("people", { id: "amma", display_name: "Amma" });
  insert("people", { id: "nanna", display_name: "Nanna" });
  insert("files", {
    id: "sha-a",
    size: 1200,
    media_type: "application/pdf",
    created_at: now,
  });
  insert("files", {
    id: "sha-n",
    size: 900,
    media_type: "image/jpeg",
    created_at: now,
  });
  insert("documents", {
    id: "doc-amma",
    person_id: "amma",
    file_id: "sha-a",
    original_name: "lipid-panel.pdf",
    added_at: now,
  });
  insert("documents", {
    id: "doc-nanna",
    person_id: "nanna",
    file_id: "sha-n",
    original_name: "IMG_2041.jpg",
    added_at: now,
  });
  insert("reports", {
    id: "rep-amma",
    person_id: "amma",
    document_id: "doc-amma",
  });
  insert("reports", {
    id: "rep-nanna",
    person_id: "nanna",
    document_id: "doc-nanna",
  });
});

describe("schema", () => {
  it("loads into an empty database", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "documents",
      "files",
      "people",
      "reports",
      "results",
    ]);
  });

  describe("person scope is enforced by the database", () => {
    it("rejects a report for one person citing another person's document", () => {
      expect(() => {
        insert("reports", {
          id: "rep-x",
          person_id: "amma",
          document_id: "doc-nanna",
        });
      }).toThrow("FOREIGN KEY constraint failed");
    });

    it("rejects a result for one person citing another person's report", () => {
      expect(() => {
        insert("results", {
          id: "res-x",
          person_id: "amma",
          report_id: "rep-nanna",
          test_name: "HbA1c",
          value_text: "6.8",
          entered_at: now,
        });
      }).toThrow("FOREIGN KEY constraint failed");
    });

    it("rejects an amendment that replaces another person's result", () => {
      insert("results", {
        id: "res-nanna",
        person_id: "nanna",
        report_id: "rep-nanna",
        test_name: "Ferritin",
        value_text: "22",
        entered_at: now,
      });
      expect(() => {
        insert("results", {
          id: "res-x",
          person_id: "amma",
          test_name: "Ferritin",
          value_text: "25",
          entered_at: now,
          replaces_id: "res-nanna",
        });
      }).toThrow("FOREIGN KEY constraint failed");
    });

    it("lets two people hold the same file, but not one person twice", () => {
      insert("documents", {
        id: "doc-shared",
        person_id: "nanna",
        file_id: "sha-a",
        original_name: "lipid-panel.pdf",
        added_at: now,
      });
      expect(() => {
        insert("documents", {
          id: "doc-again",
          person_id: "amma",
          file_id: "sha-a",
          original_name: "copy.pdf",
          added_at: now,
        });
      }).toThrow(
        "UNIQUE constraint failed: documents.person_id, documents.file_id",
      );
    });
  });

  it("keeps a result exactly as printed", () => {
    insert("results", {
      id: "res-crp",
      person_id: "amma",
      report_id: "rep-amma",
      test_name: "C-Reactive Protein",
      value_text: "<5",
      comparator: "<",
      value_number: 5,
      unit: "mg/L",
      reference_range: "0 - 5",
      flag_text: null,
      measured_at: "2026-09-12",
      entered_at: now,
    });
    const row = db.prepare("SELECT * FROM results WHERE id = 'res-crp'").get();
    expect(row).toMatchObject({
      test_name: "C-Reactive Protein",
      value_text: "<5",
      comparator: "<",
      value_number: 5,
      unit: "mg/L",
      reference_range: "0 - 5",
      flag_text: null,
      measured_at: "2026-09-12",
      entered_at: now,
    });
  });
});
