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

const page = (
  person: string,
  document: string,
  position: number,
  file: string,
) => ({
  person_id: person,
  document_id: document,
  position,
  file_id: file,
  page_in_file: 1,
  file_name: "lipid-panel.pdf",
});

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
  for (const [person, file] of [
    ["amma", "sha-a"],
    ["nanna", "sha-n"],
  ] as const) {
    insert("documents", {
      id: `doc-${person}`,
      person_id: person,
      added_at: now,
      added_from: "documents_page",
    });
    insert("document_pages", page(person, `doc-${person}`, 1, file));
  }
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

    // Each person's chat.
    beforeEach(() => {
      insert("chats", { id: "c-amma", person_id: "amma", created_at: now });
      insert("chats", { id: "c-nanna", person_id: "nanna", created_at: now });
    });

    it("never gives a person a second chat", () => {
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

    it("keeps the queue's rows whole: Rufi's with its line, held only while waiting, never another person's chat", () => {
      const row = {
        id: "q-1",
        person_id: "amma",
        chat_id: "c-amma",
        origin: "person",
        text: "a",
        position: 1,
        created_at: now,
        updated_at: now,
      };
      expect(() => {
        insert("chat_queue", { ...row, origin: "rufi" });
      }).toThrow("CHECK constraint failed");
      expect(() => {
        insert("chat_queue", { ...row, state: "sent", held: "restored" });
      }).toThrow("CHECK constraint failed");
      expect(() => {
        insert("chat_queue", { ...row, person_id: "nanna" });
      }).toThrow("FOREIGN KEY constraint failed");
      insert("chat_queue", { ...row, held: "restored" });
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
      const second = (person: string, id: string) => {
        insert("documents", {
          id,
          person_id: person,
          added_at: now,
          added_from: "documents_page",
        });
        insert("document_pages", page(person, id, 1, "sha-a"));
      };
      second("nanna", "doc-shared");
      expect(() => {
        second("amma", "doc-again");
      }).toThrow(
        "UNIQUE constraint failed: document_pages.person_id, document_pages.file_id, document_pages.page_in_file",
      );
    });

    it("rejects a page for one person in another person's document", () => {
      expect(() => {
        insert("document_pages", page("nanna", "doc-amma", 2, "sha-a"));
      }).toThrow("FOREIGN KEY constraint failed");
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
