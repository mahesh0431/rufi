// Restore on real files: a checked backup into a new folder, never over
// anything, signed out; and every way it refuses, leaving things as they were.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { holdRufiLock } from "../../platform/files.ts";
import { documents } from "../documents/documents.ts";
import { backupsPath, makeBackup } from "./backup.ts";
import { databasePath, openWritable } from "./database.ts";
import { restore } from "./restore.ts";
import { addSent } from "../../../tests/sent.ts";

let root: string;
let backup: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rufi-restore-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = openWritable(databasePath(home));
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
  );
  store.close();
  // Codex's sign-in, which no backup holds.
  await mkdir(join(home, "codex"));
  await writeFile(join(home, "codex", "auth.json"), '{"fictional":true}');
  const made = await makeBackup(home, new Date("2026-10-08T09:14:03Z"));
  backup = join(backupsPath(home), made.name);
});

const fingerprint = async (folder: string) => {
  const names = (await readdir(folder)).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(join(folder, name)).catch(() => "folder"));
  }
  return hash.digest("hex");
};

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");

/** A backup of Asha with a PDF; the PDF's file id. */
async function backupWithDocument(): Promise<{ folder: string; id: string }> {
  const home = join(root, "with-document");
  await mkdir(home);
  const store = openWritable(databasePath(home));
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
  );
  const name = "sunrise-labs-august.pdf";
  const docs = documents(store, home);
  await addSent(docs, store, "asha", [
    { name, bytes: new Uint8Array(await readFile(join(FIXTURES, name))) },
  ]);
  const id = (await docs.list("asha"))[0]?.files[0]?.id ?? "";
  store.close();
  const made = await makeBackup(home, new Date("2026-10-08T09:14:03Z"));
  return { folder: join(backupsPath(home), made.name), id };
}

describe("restore", () => {
  it("brings every original back, checked", async () => {
    const { folder, id } = await backupWithDocument();
    const target = join(root, "restored");

    await restore(folder, target);

    expect(await readdir(join(target, "files"))).toEqual([id]);
    expect(await readFile(join(target, "files", id))).toEqual(
      await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
    );
  });

  it("refuses a backup whose original has changed, and Rufi won't open the half-restored folder", async () => {
    const { folder, id } = await backupWithDocument();
    const original = await readFile(join(folder, "files", id));
    // The same size, other bytes: only the hash finds it.
    await writeFile(
      join(folder, "files", id),
      original.map((b) => b ^ 1),
    );
    const target = join(root, "restored");

    await expect(restore(folder, target)).rejects.toThrow(
      "A document file in the backup is missing or changed.",
    );

    expect(await readdir(target)).toEqual(["restoring"]);
  });

  it("puts the backup's record into a new folder, signed out, and leaves the backup as it was", async () => {
    const before = await fingerprint(backup);
    const target = join(root, "restored");

    await expect(restore(backup, target)).resolves.toEqual({
      createdAt: "2026-10-08T09:14:03.000Z",
    });

    expect((await readdir(target)).sort()).toEqual([
      "files",
      "installed.json",
      "rufi.sqlite",
    ]);
    const db = new DatabaseSync(databasePath(target), { readOnly: true });
    expect(db.prepare("SELECT id, display_name FROM people").all()).toEqual([
      { id: "asha", display_name: "Asha Fictional" },
    ]);
    db.close();
    expect(
      JSON.parse(await readFile(join(target, "installed.json"), "utf8")),
    ).toMatchObject({ restoredFrom: "2026-10-08T09:14:03.000Z" });
    expect(await fingerprint(backup)).toBe(before);
  });

  it.each([
    {
      case: "a folder that isn't empty",
      prepare: async (target: string) => {
        await mkdir(target);
        await writeFile(join(target, "notes.txt"), "fictional notes");
      },
      refusal: "isn't empty",
    },
    {
      case: "a folder another Rufi uses",
      prepare: (target: string) => holdRufiLock(target, () => undefined),
      refusal: "already running with this data folder",
    },
    {
      case: "a damaged backup",
      prepare: async () => {
        const file = join(backup, "rufi.sqlite");
        const bytes = await readFile(file);
        bytes.writeUInt8(
          bytes.readUInt8(bytes.length - 1) ^ 0xff,
          bytes.length - 1,
        );
        await writeFile(file, bytes);
      },
      refusal: "isn't as it was made",
    },
    {
      case: "a backup from a newer Rufi",
      prepare: async () => {
        // A copy as a newer Rufi made it: a version this one doesn't have.
        const file = join(backup, "rufi.sqlite");
        const newer = new DatabaseSync(file);
        newer.exec("PRAGMA user_version = 1000");
        newer.close();
        const record = JSON.parse(
          await readFile(join(backup, "backup.json"), "utf8"),
        ) as { database: { bytes: number; sha256: string } };
        const bytes = await readFile(file);
        record.database.bytes = bytes.length;
        record.database.sha256 = createHash("sha256")
          .update(bytes)
          .digest("hex");
        await writeFile(join(backup, "backup.json"), JSON.stringify(record));
      },
      refusal:
        "Rufi didn't restore it. The backup is from a newer Rufi, which this one can't use.",
    },
  ])("refuses $case and changes nothing", async ({ prepare, refusal }) => {
    const target = join(root, "restored");
    const release = await prepare(target);
    const before = await fingerprint(target).catch(() => "none");
    await expect(restore(backup, target)).rejects.toThrow(refusal);
    expect(await fingerprint(target).catch(() => "none")).toBe(before);
    await release?.();
  });

  it("restores once when two restores into one folder run at once", async () => {
    const target = join(root, "restored");
    const both = await Promise.allSettled([
      restore(backup, target),
      restore(backup, target),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await readdir(target)).sort()).toEqual([
      "files",
      "installed.json",
      "rufi.sqlite",
    ]);
  });
});

describe("a restore of a backup made while a reply read its files", () => {
  it("runs nothing by itself: the message being read for and the one waiting come back held", async () => {
    const home = join(root, "reading");
    await mkdir(home);
    const store = openWritable(databasePath(home));
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '2026-10-08T09:00:00Z');
      INSERT INTO turns (id, person_id, chat_id, model, status, started_at)
        VALUES ('turn-1', 'asha', 'c-asha', 'gpt-6.1-sol', 'running', '2026-10-08T09:00:00Z');
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, turn_id, created_at, updated_at) VALUES
        ('q-1', 'asha', 'c-asha', 'person', 'What does it say?', 1, 'handing_over', 'turn-1', '2026-10-08T09:00:00Z', '2026-10-08T09:00:00Z'),
        ('q-2', 'asha', 'c-asha', 'person', 'And my iron?', 2, 'waiting', NULL, '2026-10-08T09:01:00Z', '2026-10-08T09:01:00Z');
    `);
    store.close();
    const made = await makeBackup(home, new Date("2026-10-08T09:14:03Z"));
    const target = join(root, "restored");

    await restore(join(backupsPath(home), made.name), target);

    const db = new DatabaseSync(databasePath(target), { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT id, state, held FROM chat_queue ORDER BY position")
          .all(),
      ).toEqual([
        { id: "q-1", state: "waiting", held: "restored" },
        { id: "q-2", state: "waiting", held: "restored" },
      ]);
    } finally {
      db.close();
    }
  });
});
