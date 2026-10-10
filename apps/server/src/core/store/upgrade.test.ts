// Upgrades on real files: a record of version 1 (tests/fixtures/version-1.sql,
// frozen, made by Rufi's own code of that day) opened by this Rufi, directly
// and through a restore of its backup; and the records it refuses.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { familyFiles } from "../../../tests/fixtures/golden.ts";
import { readBrief } from "../briefs/briefs.ts";
import { transcripts, type ChatRow } from "../chat/transcript.ts";
import { claimNotices } from "../record/notices.ts";
import { recentSaves } from "../record/read.ts";
import { chatCaller } from "../tools/tools.ts";
import { backupsPath, makeBackup, upgradeBackupsPath } from "./backup.ts";
import { databasePath, openReadOnly, type Store } from "./database.ts";
import { markerPath, openRecord } from "./install.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";
import { restore } from "./restore.ts";

const VERSION_1 = [
  await readFile(
    new URL("migrations/0001-first-record.sql", import.meta.url),
    "utf8",
  ),
  await readFile(
    new URL("../../../tests/fixtures/version-1.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

/** Asha's brief, made at her third save; two saves changed its records after. */
const BRIEF = "01a12747-0e1a-75e9-a334-901d2eba9d35";
/** Its Sources as Rufi of version 1 showed them. */
const SOURCES = [
  {
    kind: "Medicine use",
    what: "Magnesium 200 mg · 3 Oct 2026 · current",
    from: "Your message, 5 Oct 2026: “I started magnesium 200 mg at night two days ago”",
    changedSince: true,
  },
  {
    kind: "Medicine use",
    what: "Metformin 500 mg · Mar 2024 · current",
    from: "Saved before Rufi kept sources",
    changedSince: false,
  },
  {
    kind: "Result",
    what: "Vitamin D 24 ng/mL · May 2026",
    from: "Your message, 8 Oct 2026: “My vitamin D in May was 24, not 22”",
    changedSince: false,
  },
  {
    kind: "Result",
    what: "Ferritin 35 ng/mL · 1 Sep 2026",
    from: "Sunrise Labs report, collected 1 Sep 2026 · thyroid recheck.jpg, page 1",
    changedSince: false,
  },
  {
    kind: "Result",
    what: "TSH 4.6 mIU/L · 12 Aug 2026 · amended",
    from: "Sunrise Labs report, collected 1 Sep 2026 · thyroid recheck.jpg, page 1",
    changedSince: true,
  },
];

/** Ravi's saves, newest first: the last was made while the Mac's clock was a day behind. */
const RAVIS_SAVES = [
  "2026-10-07T07:20:00.000Z",
  "2026-10-08T07:08:00.000Z",
  "2026-10-08T07:02:00.000Z",
];

let root: string;
let home: string;

/** A data folder as Rufi of version 1 left it: its record, marker and originals. */
async function version1(folder: string): Promise<void> {
  await mkdir(folder, { mode: 0o700 });
  const db = new DatabaseSync(databasePath(folder), {
    enableForeignKeyConstraints: false,
  });
  db.exec(VERSION_1);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  await writeFile(markerPath(folder), '{"createdAt":"2026-10-01T09:00:00Z"}');
  await familyFiles(folder);
}

const sha = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rufi-upgrade-"));
  home = join(root, "home");
  await version1(home);
});

/** Ravi says something and the AI saves it, at `at`. */
async function ravisSave(store: Store, at: string): Promise<void> {
  const chats = transcripts(store, () => at);
  const chat = (await chats.chat("ravi")) as ChatRow;
  await chats.startTurn(chat, "t-after", {
    id: "thread-ravi",
    model: "gpt-6.1-sol",
  });
  const words = "I take fish oil every day";
  await chats.addMessage(chat, {
    id: "m-after",
    kind: "message",
    text: words,
    agentTurnId: "t-after",
  });
  const reader = openReadOnly(databasePath(home)) as Store;
  try {
    const answer = await chatCaller(reader, chats, () => undefined)(
      chat,
      "t-after",
      "person",
    )(
      "save_changes",
      {
        changes: [
          {
            kind: "medicine_use",
            action: "add",
            source: words,
            fields: { name: "Fish oil", status: "current" },
          },
        ],
      },
      "call-after",
    );
    expect(answer.ok).toBe(true);
  } finally {
    reader.close();
  }
}

describe("a record of version 1", () => {
  it("upgrades at start: its brief's values and sources and the order of saves stay, also after VACUUM, and a new save comes last", async () => {
    const store = await openRecord(home);
    try {
      const saves = async () =>
        (await recentSaves(store, "ravi")).map((save) => save.at);
      expect((await readBrief(store.query, "asha", BRIEF))?.sources).toEqual(
        SOURCES,
      );
      expect(await saves()).toEqual(RAVIS_SAVES);

      store.db.exec("VACUUM");
      expect((await readBrief(store.query, "asha", BRIEF))?.sources).toEqual(
        SOURCES,
      );

      // The Mac's clock is behind every earlier save: the save is still the newest.
      await ravisSave(store, "2026-10-01T09:00:00.000Z");
      expect(await saves()).toEqual([
        "2026-10-01T09:00:00.000Z",
        ...RAVIS_SAVES,
      ]);
    } finally {
      store.close();
    }
  });

  it("is backed up as it was before the upgrade, and that backup restores into a new folder upgraded, with its originals and chat", async () => {
    (await openRecord(home)).close();
    const upgradeBackups = upgradeBackupsPath(home);
    const [name] = await readdir(upgradeBackups);
    const backup = join(upgradeBackups, name ?? "");
    const kept = await sha(join(backup, "rufi.sqlite"));
    const target = join(root, "restored");

    await restore(backup, target);

    expect(await sha(join(backup, "rufi.sqlite"))).toBe(kept);
    expect((await readdir(join(target, "files"))).sort()).toEqual(
      (await readdir(join(home, "files"))).sort(),
    );
    for (const file of await readdir(join(home, "files"))) {
      expect(await sha(join(target, "files", file))).toBe(
        await sha(join(home, "files", file)),
      );
    }
    const store = await openRecord(target);
    try {
      expect((await readBrief(store.query, "asha", BRIEF))?.sources).toEqual(
        SOURCES,
      );
      expect((await recentSaves(store, "ravi")).map((save) => save.at)).toEqual(
        RAVIS_SAVES,
      );
      const chats = transcripts(store);
      const page = await chats.page((await chats.chat("ravi")) as ChatRow);
      expect(
        page.entries
          .filter((entry) => entry.kind === "message")
          .map((entry) => entry.text),
      ).toEqual([
        "I've had a mild headache every evening since Monday",
        "I take vitamin B12 1000 mcg every morning",
        "The headache is gone since yesterday",
      ]);
    } finally {
      store.close();
    }
  });

  it("stays as it was when a migration fails, also one after another that worked", async () => {
    const path = databasePath(home);
    const before = await sha(path);

    expect(() => {
      migrate(path, [...MIGRATIONS, "UPDATE no_such_table SET x = 1;"]);
    }).toThrow("left it as it was");

    expect(await sha(path)).toBe(before);
  });
});

it("upgrades a record of version 2 to keep follow-up notices, and a backup keeps them through restore", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 2));
  const db = new DatabaseSync(path);
  db.exec(
    "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-vitamin-d', 'asha', 'Recheck vitamin D', '2026-09')",
  );
  db.close();
  const now = new Date(2026, 9, 11, 9);

  const store = await openRecord(home);
  try {
    expect(await claimNotices(store.query, now)).toEqual([
      { personId: "asha", due: 0, overdue: 1 },
    ]);
  } finally {
    store.close();
  }
  const made = await makeBackup(home, new Date("2026-10-11T08:00:00Z"));
  const target = join(root, "restored");
  await restore(join(backupsPath(home), made.name), target);

  const restored = await openRecord(target);
  try {
    expect(await claimNotices(restored.query, now)).toEqual([]);
  } finally {
    restored.close();
  }
});

it("refuses a record from a newer Rufi, unchanged and with no backup made", async () => {
  const path = databasePath(home);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length + 1)}`);
  db.close();
  const before = await sha(path);

  await expect(openRecord(home)).rejects.toThrow("made by a newer Rufi");

  expect(await sha(path)).toBe(before);
  expect(await readdir(home)).not.toContain("backups");
});

it("opens a record the migrations made as this Rufi's own (schema.sql is what they make)", async () => {
  const path = databasePath(join(root, "migrated"));
  await mkdir(join(root, "migrated"));
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length)}`);
  db.close();

  expect(() => openReadOnly(path)?.close()).not.toThrow();
});
