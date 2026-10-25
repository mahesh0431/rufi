// The export on a real data folder: what is in the zip, values exactly as
// stored (in JSON and in CSV), nothing private, and a save made during an
// export in it whole or not at all.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { devices } from "../devices/devices.ts";
import { documents } from "../documents/documents.ts";
import { filesPath } from "../documents/originals.ts";
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

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");

/** Asha with a PDF and a HEIC photo; their file ids. */
async function withDocuments(): Promise<string[]> {
  const store = openWritable(databasePath(home));
  try {
    store.db.exec(
      "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
    );
    const docs = documents(store, home);
    for (const name of ["sunrise-labs-august.pdf", "sideways.heic"]) {
      const bytes = new Uint8Array(await readFile(join(FIXTURES, name)));
      await docs.add("asha", [{ name, bytes }], true);
    }
    return (await docs.list("asha")).flatMap((d) => d.files.map((f) => f.id));
  } finally {
    store.close();
  }
}

/** Changes one byte of the file at `path`, keeping its size. */
async function flipOneByte(path: string) {
  const bytes = await readFile(path);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  await writeFile(path, bytes);
}

describe("the export's original files", () => {
  it("holds every original exactly as it came, named by its hash and type", async () => {
    const [heic = "", pdf = ""] = await withDocuments();

    const files = await unzipped();

    expect(Buffer.from(files[`${FOLDER}/files/${pdf}.pdf`] ?? [])).toEqual(
      await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
    );
    expect(Buffer.from(files[`${FOLDER}/files/${heic}.heic`] ?? [])).toEqual(
      await readFile(join(FIXTURES, "sideways.heic")),
    );
    expect(
      Object.keys(files).filter((name) => name.includes("/files/")),
    ).toHaveLength(2);
  });

  it.each([
    ["missing", (path: string) => rm(path), "is missing"],
    // The same size, one byte other: only the hash finds it.
    ["changed", (path: string) => flipOneByte(path), "has changed"],
  ])(
    "fails when an original is %s, rather than leave it out",
    async (_how, spoil, says) => {
      const [id = ""] = await withDocuments();
      await spoil(join(filesPath(home), id));

      await expect(exportZip(home, NOW)).rejects.toThrow(
        `The document file ${id} ${says}.`,
      );
    },
  );
});

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
          removed: 0,
        },
      ],
    });
    expect(
      strFromU8(files[`${FOLDER}/csv/follow_ups.csv`] ?? new Uint8Array()),
    ).toBe(
      '"id","person_id","title","due","due_words","status","outcome","linked_kind","linked_id","removed"\r\n' +
        '"f1","asha","रक्त जाँच\nsecond line",,"","open",,,,0\r\n',
    );
    expect(
      strFromU8(files[`${FOLDER}/csv/people.csv`] ?? new Uint8Array()),
    ).toBe('"id","display_name"\r\n"asha","Asha ""Ammu"", Fictional"\r\n');
  });

  it("holds the reader's page copies exactly as written: Markdown, an HTML table, marks and new lines", async () => {
    const [file] = await withDocuments();
    const copy =
      '# Sunrise Labs\n\n<table><tr><td>Glucose, Fasting</td><td>1[0?]4 H</td><td>µmol/L</td></tr></table>\n\n| TSH | ~~5.3~~ [handwritten: 5.8] |\n"Page 1 of 2"';
    const store = openWritable(databasePath(home));
    try {
      store.db.exec(`
        INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
          SELECT 'job-copy', 'asha', 'document_read', document_id, 'done', 1, '[1]', '2026-10-08T09:00:00Z'
          FROM document_pages WHERE file_id = '${file ?? ""}' AND page_in_file = 1;
      `);
      store.db
        .prepare(
          `INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
           VALUES ('asha', ?, 1, 'job-copy', 1, 'read', ?, '2026-10-08T09:01:00Z')`,
        )
        .run(file ?? "", copy);
    } finally {
      store.close();
    }

    const files = await unzipped();

    const table = JSON.parse(
      strFromU8(files[`${FOLDER}/json/page_copies.json`] ?? new Uint8Array()),
    ) as { rows: { copy: string; job_id: string }[] };
    expect(table.rows).toEqual([
      expect.objectContaining({ job_id: "job-copy", copy }),
    ]);
    expect(
      strFromU8(files[`${FOLDER}/csv/page_copies.csv`] ?? new Uint8Array()),
    ).toContain(`"${copy.replaceAll('"', '""')}"`);
  });

  it("holds a device batch exactly, as base64 gzip, and the type list its values name", async () => {
    const store = openWritable(databasePath(home));
    const page = new TextEncoder().encode(
      '{"batch":"p-1","values":[],"deleted":[]}',
    );
    try {
      store.db.exec(
        "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
      );
      const data = devices(store, () => "2026-10-08T09:00:00.000Z");
      const made = await data.addSource({
        name: "Asha's iPhone",
        system: "apple_health",
      });
      if (!("source" in made)) throw new Error("no source");
      await data.receive(made.source.id, page);
    } finally {
      store.close();
    }

    const files = await unzipped();

    const batches = JSON.parse(
      strFromU8(
        files[`${FOLDER}/json/device_batches.json`] ?? new Uint8Array(),
      ),
    ) as { rows: { body: string }[] };
    const body = batches.rows[0]?.body ?? "";
    expect(new Uint8Array(gunzipSync(Buffer.from(body, "base64")))).toEqual(
      page,
    );
    expect(
      strFromU8(files[`${FOLDER}/csv/device_types.csv`] ?? new Uint8Array()),
    ).toBe(
      '"key","label","unit","loinc"\r\n' +
        '"resting_heart_rate","Resting heart rate","/min","40443-4"\r\n',
    );
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
    // Each result says whether it is a lab result or a measurement.
    const results = JSON.parse(
      strFromU8(files[`${FOLDER}/json/results.json`] ?? new Uint8Array()),
    ) as { columns: string[] };
    expect(results.columns).toContain("category");
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
