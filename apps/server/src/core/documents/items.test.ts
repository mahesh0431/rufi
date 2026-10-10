// The document page's draft items on a real database: what the page shows,
// and the person's fixes with versions (two tabs, saved items, the reader's
// value kept, the number made again from a fixed value).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { Refusal } from "../tools/registry.ts";
import { draftItems, StaleFix, type DraftItems } from "./items.ts";

const NOW = "2026-10-10T09:00:00.000Z";
const HBA1C = {
  test_name: "HbA1c",
  value_text: "5.3",
  value_number: 5.3,
  unit: "%",
  reference_range: "<5.7",
};

let store: Store;
let items: DraftItems;
let told: string[];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "rufi-items-"));
  store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO files (id, size, media_type, created_at) VALUES ('f1', 10, 'application/pdf', '${NOW}');
    INSERT INTO documents (id, person_id, added_at, added_from, version) VALUES ('d1', 'asha', '${NOW}', 'documents_page', 1);
    INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
      VALUES ('j1', 'asha', 'document_read', 'd1', 'done', 1, '[1,2]', '${NOW}');
    INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name, entry_checks, state, state_why)
      VALUES ('asha', 'd1', 1, 'f1', 1, 'northfield.pdf', '{"incomplete":{"rows_seen":3,"items":2},"items":[]}', 'read', NULL),
             ('asha', 'd1', 2, 'f1', 2, 'northfield.pdf', NULL, 'not_looked_at', NULL);
  `);
  const insert = store.db.prepare(
    `INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, status, fields, original, unsure, created_at)
     VALUES (?, 'asha', 'd1', 1, ?, 'j1', 'lab_result', ?, ?, ?, ?, '${NOW}')`,
  );
  insert.run(
    "i1",
    1,
    "pending",
    JSON.stringify(HBA1C),
    JSON.stringify({ ...HBA1C, unsure: "faint digit" }),
    '["faint digit"]',
  );
  insert.run(
    "i2",
    2,
    "pending",
    JSON.stringify({ test_name: "TSH", value_text: "2.41" }),
    JSON.stringify({ test_name: "TSH", value_text: "2.41" }),
    "[]",
  );
  // i2 is saved: by a save in the chat, into a result.
  store.db.exec(`
    INSERT INTO chats (id, person_id, created_at) VALUES ('c1', 'asha', '${NOW}');
    INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at)
      VALUES ('op1', 1, 'asha', 'c1', 'call-1', '{}', '${NOW}');
    UPDATE draft_items SET status = 'saved', saved_as = 'new', record_kind = 'result', record_id = 'r1', operation_id = 'op1'
      WHERE id = 'i2';
  `);
  told = [];
  items = draftItems(store, (personId) => told.push(personId));
  return () => {
    store.close();
  };
});

const documentVersion = () =>
  (
    store.db.prepare("SELECT version FROM documents WHERE id = 'd1'").get() as {
      version: number;
    }
  ).version;

describe("the document page's items", () => {
  it("shows each page's state and checks, and the items with the reader's fields and why they're unsure", async () => {
    const view = await items.view("asha", "d1");

    expect(view?.pages).toEqual([
      {
        position: 1,
        state: "read",
        why: null,
        incomplete: { rows_seen: 3, items: 2 },
      },
      { position: 2, state: "not_looked_at", why: null, incomplete: null },
    ]);
    expect(view?.items[0]).toEqual({
      id: "i1",
      version: 1,
      page: 1,
      status: "pending",
      fields: HBA1C,
      original: HBA1C,
      unsure: ["faint digit"],
    });
    expect(view?.items[1]?.status).toBe("saved");
  });

  it("shows nothing of another person's document", async () => {
    expect(await items.view("ravi", "d1")).toBeUndefined();
    expect(
      await items.fix("ravi", "d1", "i1", {
        version: 1,
        fields: { value_text: "5.8" },
      }),
    ).toBeUndefined();
  });
});

describe("a fix", () => {
  it("changes the fields, keeps the reader's, and raises the item's and the document's version", async () => {
    const fixed = await items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { value_text: " 5.8 ", flag_text: "H" },
    });

    expect(fixed?.version).toBe(2);
    expect(fixed?.fields).toEqual({
      ...HBA1C,
      value_text: "5.8",
      value_number: 5.8,
      flag_text: "H",
    });
    const [shown] = (await items.view("asha", "d1"))?.items ?? [];
    expect(shown?.fields).toEqual(fixed?.fields);
    expect(shown?.original).toEqual(HBA1C);
    expect(shown?.unsure).toEqual(["faint digit"]);
    expect(documentVersion()).toBe(2);
    expect(told).toEqual(["asha"]);
  });

  it("from a tab holding an older version is refused with the item as it is now, and changes nothing", async () => {
    await items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { value_text: "5.6" },
    });

    const second = items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { value_text: "5.8" },
    });

    await expect(second).rejects.toBeInstanceOf(StaleFix);
    const refused = (await second.catch((error: unknown) => error)) as StaleFix;
    expect(refused.current.version).toBe(2);
    expect(refused.current.fields.value_text).toBe("5.6");
    expect((await items.view("asha", "d1"))?.items[0]?.fields.value_text).toBe(
      "5.6",
    );
    expect(documentVersion()).toBe(2);
  });

  it("can't fix a saved item", async () => {
    await expect(
      items.fix("asha", "d1", "i2", {
        version: 1,
        fields: { value_text: "3" },
      }),
    ).rejects.toThrow("This result is already saved");
  });

  it("can't empty the test name or the value, and leaves out an emptied optional field", async () => {
    await expect(
      items.fix("asha", "d1", "i1", {
        version: 1,
        fields: { value_text: " " },
      }),
    ).rejects.toBeInstanceOf(Refusal);

    const fixed = await items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { reference_range: "" },
    });

    expect(fixed?.fields).not.toHaveProperty("reference_range");
    expect(fixed?.version).toBe(2);
  });

  it("makes the number again only from a plain printed number", async () => {
    const less = await items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { value_text: "<5" },
    });
    expect(less?.fields).toMatchObject({ comparator: "<", value_number: 5 });

    const comma = await items.fix("asha", "d1", "i1", {
      version: 2,
      fields: { value_text: "4,6" },
    });
    expect(comma?.fields).not.toHaveProperty("value_number");
    expect(comma?.fields).not.toHaveProperty("comparator");
  });

  it("that changes nothing keeps the version", async () => {
    const same = await items.fix("asha", "d1", "i1", {
      version: 1,
      fields: { value_text: "5.3", unit: "%" },
    });

    expect(same?.version).toBe(1);
    expect(documentVersion()).toBe(1);
    expect(told).toEqual([]);
  });
});
