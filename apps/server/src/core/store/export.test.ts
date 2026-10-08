// The export on a real data folder: what is in the zip, values exactly as
// stored (in JSON and in CSV), nothing private, and a save made during an
// export in it whole or not at all.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable } from "./database.ts";
import { exportZip } from "./export.ts";

let home: string;
const NOW = new Date(2026, 9, 8, 9, 14);
const FOLDER = "rufi-export-2026-10-08";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-export-"));
  openWritable(databasePath(home)).close();
});

const unzipped = async () => {
  const { name, bytes } = await exportZip(home, NOW);
  expect(name).toBe(`${FOLDER}.zip`);
  return unzipSync(bytes);
};

describe("the export", () => {
  it("writes every value as stored: no value, empty text, quotes, commas, new lines, other scripts", async () => {
    const store = openWritable(databasePath(home));
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha "Ammu", Fictional');
      INSERT INTO follow_ups (id, person_id, title, due, due_words)
        VALUES ('f1', 'asha', 'रक्त जाँच
second line', NULL, '');
    `);
    store.close();

    const files = await unzipped();

    expect(
      JSON.parse(
        strFromU8(files[`${FOLDER}/json/follow_ups.json`] ?? new Uint8Array()),
      ),
    ).toEqual({
      table: "follow_ups",
      columns: [
        "id",
        "person_id",
        "title",
        "due",
        "due_words",
        "status",
        "outcome",
        "linked_kind",
        "linked_id",
        "source_entry_id",
        "removed",
      ],
      rows: [
        {
          id: "f1",
          person_id: "asha",
          title: "रक्त जाँच\nsecond line",
          due: null,
          due_words: "",
          status: "open",
          outcome: null,
          linked_kind: null,
          linked_id: null,
          source_entry_id: null,
          removed: 0,
        },
      ],
    });
    expect(
      strFromU8(files[`${FOLDER}/csv/follow_ups.csv`] ?? new Uint8Array()),
    ).toBe(
      '"id","person_id","title","due","due_words","status","outcome","linked_kind","linked_id","source_entry_id","removed"\r\n' +
        '"f1","asha","रक्त जाँच\nsecond line",,"","open",,,,,0\r\n',
    );
    expect(
      strFromU8(files[`${FOLDER}/csv/people.csv`] ?? new Uint8Array()),
    ).toBe('"id","display_name"\r\n"asha","Asha ""Ammu"", Fictional"\r\n');
  });

  it("holds every table, a README and its own record, and nothing of the sign-in, the AI's files or logs", async () => {
    const sentinel = "NOT FOR THE EXPORT";
    await writeFile(join(home, "chatgpt.json"), `{"hostId":"${sentinel}"}`);
    await writeFile(join(home, "models.json"), `{"models":["${sentinel}"]}`);
    await mkdir(join(home, "codex"));
    await writeFile(join(home, "codex", "config.toml"), sentinel);
    await mkdir(join(home, "logs"));
    await writeFile(join(home, "logs", "rufi.log"), sentinel);

    const files = await unzipped();

    const names = Object.keys(files);
    expect(names.filter((n) => !/\/(json|csv)\//.test(n)).sort()).toEqual([
      `${FOLDER}/README.md`,
      `${FOLDER}/export.json`,
    ]);
    expect(names.filter((n) => n.includes("/json/"))).toContain(
      `${FOLDER}/json/record_changes.json`,
    );
    expect(names.filter((n) => n.includes("/json/"))).toHaveLength(
      names.filter((n) => n.includes("/csv/")).length,
    );
    for (const bytes of Object.values(files)) {
      expect(strFromU8(bytes)).not.toContain(sentinel);
    }
    // The fixed copy it was made from is gone.
    expect(
      (await readdir(home)).filter((n) => n.startsWith(".export-")),
    ).toEqual([]);
  });

  it("has a save made during it whole, or not at all", async () => {
    const store = openWritable(databasePath(home));
    for (let i = 0; i < 300; i++) {
      store.db.exec(
        `INSERT INTO settings (key, value) VALUES ('padding.${String(i)}', '${"x".repeat(2000)}')`,
      );
    }
    let saves = 0;
    const writing = { on: true };
    const writer = (async () => {
      while (writing.on) {
        const n = String(saves);
        store.db.exec(`BEGIN;
          INSERT INTO people (id, display_name) VALUES ('p${n}', 'Fictional ${n}');
          INSERT INTO follow_ups (id, person_id, title) VALUES ('f${n}', 'p${n}', 'Recheck');
          COMMIT;`);
        saves++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const exports: Record<string, Uint8Array>[] = [];
    for (let i = 0; i < 3; i++) exports.push(await unzipped());
    writing.on = false;
    await writer;
    store.close();
    expect(saves).toBeGreaterThan(0);
    for (const files of exports) {
      const rows = (table: string) =>
        (
          JSON.parse(
            strFromU8(
              files[`${FOLDER}/json/${table}.json`] ?? new Uint8Array(),
            ),
          ) as { rows: unknown[] }
        ).rows.length;
      expect(rows("follow_ups")).toBe(rows("people"));
    }
  });
});
