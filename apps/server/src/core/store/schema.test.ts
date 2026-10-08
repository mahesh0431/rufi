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
  describe("chats stay with their person", () => {
    const turn = {
      agent_turn_id: "t",
      thread_id: "thread-1",
      model: "gpt-6.1-sol",
      status: "running",
      started_at: now,
    };
    const entry = {
      seq: 1,
      kind: "message",
      text: "Hello",
      revision: 1,
      created_at: now,
      updated_at: now,
    };

    // Each person's chat, made with them, named here for the tests.
    beforeEach(() => {
      db.exec("UPDATE chats SET id = 'c-' || person_id");
    });

    it("gives each person one chat, made with them, and never a second", () => {
      insert("people", { id: "ammamma", display_name: "Ammamma" });
      expect(
        db
          .prepare("SELECT person_id, revision FROM chats ORDER BY person_id")
          .all(),
      ).toEqual([
        { person_id: "amma", revision: 0 },
        { person_id: "ammamma", revision: 0 },
        { person_id: "nanna", revision: 0 },
      ]);
      expect(() => {
        insert("chats", { id: "c-2", person_id: "amma", created_at: now });
      }).toThrow("UNIQUE constraint failed: chats.person_id");
    });

    it("rejects a turn, an entry or a draft for one person in another's chat", () => {
      expect(() => {
        insert("turns", {
          ...turn,
          id: "t-x",
          person_id: "amma",
          chat_id: "c-nanna",
        });
      }).toThrow("FOREIGN KEY constraint failed");
      expect(() => {
        insert("transcript_entries", {
          ...entry,
          id: "e-x",
          person_id: "amma",
          chat_id: "c-nanna",
        });
      }).toThrow("FOREIGN KEY constraint failed");
      expect(() => {
        insert("drafts", {
          person_id: "amma",
          chat_id: "c-nanna",
          text: "x",
          revision: 1,
          updated_at: now,
        });
      }).toThrow("FOREIGN KEY constraint failed");
    });

    it("rejects an entry that cites another person's turn", () => {
      insert("turns", {
        ...turn,
        id: "t-nanna",
        person_id: "nanna",
        chat_id: "c-nanna",
      });
      expect(() => {
        insert("transcript_entries", {
          ...entry,
          id: "e-x",
          person_id: "amma",
          chat_id: "c-amma",
          turn_id: "t-nanna",
        });
      }).toThrow("FOREIGN KEY constraint failed");
    });

    it("keeps an activity line's kind and status, and only on activity", () => {
      const line = {
        ...entry,
        person_id: "amma",
        chat_id: "c-amma",
        kind: "activity",
      };
      expect(() => {
        insert("transcript_entries", { ...line, id: "e-1" });
      }).toThrow("CHECK constraint failed");
      insert("transcript_entries", {
        ...line,
        id: "e-2",
        activity: "command",
        status: "done",
      });
      expect(() => {
        insert("transcript_entries", {
          ...entry,
          id: "e-3",
          seq: 2,
          person_id: "amma",
          chat_id: "c-amma",
          status: "done",
        });
      }).toThrow("CHECK constraint failed");
    });

    it("holds a draft for a send only with its message id", () => {
      const draft = {
        person_id: "amma",
        chat_id: "c-amma",
        text: "a",
        revision: 1,
        updated_at: now,
      };
      expect(() => {
        insert("drafts", { ...draft, state: "sending" });
      }).toThrow("CHECK constraint failed");
      expect(() => {
        insert("drafts", { ...draft, attempt: "m-1" });
      }).toThrow("CHECK constraint failed");
      insert("drafts", { ...draft, state: "sending", attempt: "m-1" });
    });
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

    it("rejects a typed-in result for a person who doesn't exist", () => {
      const typed = {
        id: "res-typed",
        test_name: "Weight",
        value_text: "61 kg",
        entered_at: now,
      };
      insert("results", { ...typed, person_id: "amma" });
      expect(() => {
        insert("results", { ...typed, id: "res-x", person_id: "nobody" });
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

  describe("results keep what was printed", () => {
    const crp = {
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
      context_text: "High sensitivity",
      measured_at: "2026-09-12",
      entered_at: now,
      replaces_id: null,
      group_label: null,
      second_number: null,
      measured_words: null,
      source_entry_id: null,
      removed: 0,
    };

    it("reads back every printed field unchanged", () => {
      insert("results", crp);
      expect(
        db.prepare("SELECT * FROM results WHERE id = 'res-crp'").get(),
      ).toEqual(crp);
    });

    it("links an amendment to the result it replaces, keeping both as printed", () => {
      const original = {
        ...crp,
        id: "res-ldl",
        test_name: "LDL Cholesterol",
        value_text: "162",
        comparator: null,
        value_number: 162,
        unit: "mg/dL",
        reference_range: "<130",
        flag_text: "High",
        context_text: "Calculated",
        measured_at: "2026-09",
        group_label: "LDL",
      };
      const amended = {
        ...original,
        id: "res-ldl-2",
        test_name: "LDL-C (direct)",
        value_text: "148",
        value_number: 148,
        context_text: "Direct",
        replaces_id: "res-ldl",
      };
      insert("results", original);
      insert("results", amended);
      const rows = db
        .prepare("SELECT * FROM results WHERE group_label = 'LDL' ORDER BY id")
        .all();
      expect(rows).toEqual([original, amended]);
    });

    it("keeps dates at the precision they were known", () => {
      for (const [id, measured] of [
        ["res-y", "2025"],
        ["res-m", "2025-11"],
        ["res-d", "2025-11-03"],
      ] as const) {
        insert("results", { ...crp, id, measured_at: measured });
      }
      const dates = db
        .prepare("SELECT measured_at FROM results ORDER BY id")
        .all()
        .map((row) => row.measured_at);
      expect(dates).toEqual(["2025-11-03", "2025-11", "2025"]);
    });
  });
});
