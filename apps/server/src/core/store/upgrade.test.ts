// Upgrades on real files: a record of version 1 (tests/fixtures/version-1.sql,
// frozen, made by Rufi's own code of that day) opened by this Rufi, directly
// and through a restore of its backup; and the records it refuses.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { familyFiles } from "../../../tests/fixtures/golden.ts";
import { holdRufiLock } from "../../platform/files.ts";
import { readBrief } from "../briefs/briefs.ts";
import { transcripts, type ChatRow } from "../chat/transcript.ts";
import { claimNotices } from "../record/notices.ts";
import { recentSaves } from "../record/read.ts";
import { chatCaller } from "../tools/tools.ts";
import { backupsPath, makeBackup, upgradeBackupsPath } from "./backup.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "./database.ts";
import { markerPath, openRecord } from "./install.ts";
import { MIGRATIONS, inspect, migrate } from "./migrations.ts";
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

/**
 * The originals the frozen record names: the family's files as they were on
 * 11 Oct 2026. The thyroid photo has changed since; its old bytes stay here.
 */
const VERSION_1_FILES = [
  "sunrise-labs-august.pdf",
  "thyroid-recheck-version-1.jpg",
  "ravi-lipid-panel.pdf",
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
  await familyFiles(folder, VERSION_1_FILES);
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
  it("upgrades at start: its brief's values and sources, its reading and the order of saves stay, also after VACUUM, and a new save comes last", async () => {
    const store = await openRecord(home);
    try {
      const saves = async () =>
        (await recentSaves(store, "ravi")).map((save) => save.at);
      expect((await readBrief(store.query, "asha", BRIEF))?.sources).toEqual(
        SOURCES,
      );
      expect(await saves()).toEqual(RAVIS_SAVES);
      expect(
        await store.query
          .selectFrom("operations")
          .select("warnings")
          .distinct()
          .execute(),
      ).toEqual([{ warnings: "[]" }]);
      // Its reading is kept, with no automatic retry used or waiting.
      expect(
        await store.query
          .selectFrom("jobs")
          .select(["id", "state", "retries", "retry_at"])
          .execute(),
      ).toEqual([{ id: "job-sep", state: "done", retries: 0, retry_at: null }]);

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

  it("restarts after a process dies with migration pages spilled before commit", async () => {
    const path = databasePath(home);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    const release = await holdRufiLock(home, () => undefined);
    try {
      // Only the child changes SQLite's cache and kills itself. The real gate
      // and backup run; no test hook is needed in product code.
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { DatabaseSync } from "node:sqlite";
        const { openRecord } = await import(process.argv[2]);
        const exec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          if (sql === "BEGIN IMMEDIATE") exec.call(this, "PRAGMA cache_size = 1");
          if (sql === "COMMIT") process.kill(process.pid, "SIGKILL");
          return exec.call(this, sql);
        };
        (await openRecord(process.argv[1])).close();
        throw new Error("The upgrade ended without its crash.");
      `,
          home,
          new URL("install.ts", import.meta.url).href,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(child.stderr).toBe("");
      expect(child.signal).toBe("SIGKILL");

      // Nothing from the pending migration is committed. This read must
      // work without a writable connection recovering a rollback journal.
      const old = new DatabaseSync(path, { readOnly: true });
      try {
        expect(inspect(old)).toEqual({ state: "older", version: 1 });
        expect(
          old
            .prepare("PRAGMA table_info(operations)")
            .all()
            .map((column) => column.name),
        ).not.toContain("seq");
      } finally {
        old.close();
      }

      const restarted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        const { openRecord } = await import(process.argv[2]);
        (await openRecord(process.argv[1])).close();
      `,
          home,
          new URL("install.ts", import.meta.url).href,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(restarted.stderr).toBe("");
      expect(restarted.status).toBe(0);
      const restored = openReadOnly(path) as Store;
      try {
        expect(
          (await readBrief(restored.query, "asha", BRIEF))?.sources,
        ).toEqual(SOURCES);
        expect(
          (await recentSaves(restored, "ravi")).map((save) => save.at),
        ).toEqual(RAVIS_SAVES);
      } finally {
        restored.close();
      }
    } finally {
      await release();
    }
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

/** Every result as stored, and every change to one as history keeps it. */
function resultsIn(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: (
        db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version,
      results: db.prepare("SELECT * FROM results ORDER BY id").all(),
      history: db
        .prepare(
          "SELECT * FROM record_changes WHERE kind = 'result' ORDER BY operation_id, seq",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

it.each([1, 3])(
  "upgrades a record of version %i so every result is a lab result, its fields, ids and links kept and its history unchanged",
  async (version) => {
    const path = databasePath(home);
    if (version > 1) migrate(path, MIGRATIONS.slice(0, version));
    const before = resultsIn(path);
    expect(before.results.length).toBeGreaterThan(0);

    (await openRecord(home)).close();

    const after = resultsIn(path);
    expect(after.version).toBe(MIGRATIONS.length);
    expect(after.results).toEqual(
      before.results.map((row) => ({ ...row, category: "lab" })),
    );
    expect(after.history).toEqual(before.history);
  },
);

it("keeps the backup made before the category upgrade at version 3, and a restore of it upgrades only the new folder", async () => {
  migrate(databasePath(home), MIGRATIONS.slice(0, 3));
  const before = resultsIn(databasePath(home));
  (await openRecord(home)).close();
  const [name] = await readdir(upgradeBackupsPath(home));
  const backup = join(upgradeBackupsPath(home), name ?? "");
  const target = join(root, "restored");

  await restore(backup, target);

  expect(resultsIn(join(backup, "rufi.sqlite")).version).toBe(3);
  const restored = resultsIn(databasePath(target));
  expect(restored.version).toBe(MIGRATIONS.length);
  expect(restored.results).toEqual(
    before.results.map((row) => ({ ...row, category: "lab" })),
  );
});

/** The documents and their pages as stored. */
function documentsIn(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
      pages: db
        .prepare(
          "SELECT * FROM document_pages ORDER BY person_id, document_id, position",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

it("upgrades a record of version 4 so a document can be deleted, every document and page kept as it was and none deleted", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 4));
  const before = documentsIn(path);
  expect(before.pages.length).toBeGreaterThan(0);

  (await openRecord(home)).close();

  const after = documentsIn(path);
  expect(after.documents).toEqual(
    before.documents.map((row) => ({ ...row, deleted_at: null })),
  );
  expect(after.pages).toEqual(before.pages);
});

it("upgrades a record of version 5 so a generated picture can be a line of the chat, every line kept as it was", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 5));
  const lines = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db
        .prepare("SELECT * FROM transcript_entries ORDER BY rowid")
        .all();
    } finally {
      db.close();
    }
  };
  const before = lines();
  expect(before.length).toBeGreaterThan(0);

  (await openRecord(home)).close();

  expect(lines()).toEqual(before);
  const db = new DatabaseSync(path);
  try {
    const turn = db
      .prepare("SELECT person_id, chat_id, id FROM turns LIMIT 1")
      .get() as { person_id: string; chat_id: string; id: string };
    db.prepare(
      `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, status, revision, created_at, updated_at)
       VALUES ('picture-1', ?, ?, 9999, ?, 'activity', 'Made a picture', 'picture', '/fictional/generated_images/t/c.png', 'done', 1, '2026-10-14T09:00:00Z', '2026-10-14T09:00:00Z')`,
    ).run(turn.person_id, turn.chat_id, turn.id);
  } finally {
    db.close();
  }
});

it("upgrades a record of version 6 so the AI's notes can be steps of its Activity, every line kept as it was, in order", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 6));
  // A command line as Rufi of version 6 stored it: its words, the command
  // cut to one line, and everything Codex gave about it.
  const old = new DatabaseSync(path);
  try {
    const turn = old
      .prepare("SELECT person_id, chat_id, id FROM turns LIMIT 1")
      .get() as { person_id: string; chat_id: string; id: string };
    old
      .prepare(
        `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, status, agent_item_id, revision, created_at, updated_at)
         VALUES ('command-1', ?, ?, 9998, ?, 'activity', 'Ran a command', 'command', 'ls', '{"type":"commandExecution","command":"ls","aggregatedOutput":"notes.txt\\n","exitCode":0}', 'done', 'cmd-1', 1, '2026-10-13T09:00:00Z', '2026-10-13T09:00:01Z')`,
      )
      .run(turn.person_id, turn.chat_id, turn.id);
  } finally {
    old.close();
  }
  const lines = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare("SELECT * FROM transcript_entries ORDER BY seq").all();
    } finally {
      db.close();
    }
  };
  const before = lines();
  expect(before.some((line) => line["kind"] === "reply")).toBe(true);
  expect(before.at(-1)).toMatchObject({ id: "command-1", detail: "ls" });

  (await openRecord(home)).close();

  expect(lines()).toEqual(before);
  const db = new DatabaseSync(path);
  try {
    const turn = db
      .prepare("SELECT person_id, chat_id, id FROM turns LIMIT 1")
      .get() as { person_id: string; chat_id: string; id: string };
    db.prepare(
      `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, status, agent_item_id, revision, created_at, updated_at)
       VALUES ('note-1', ?, ?, 9999, ?, 'activity', 'I''ll check your results first.', 'note', 'done', 'msg-1', 1, '2026-10-14T09:00:00Z', '2026-10-14T09:00:00Z')`,
    ).run(turn.person_id, turn.chat_id, turn.id);
  } finally {
    db.close();
  }
});

it.each([
  {
    record: "a record from a newer Rufi",
    prepare: () => {
      const db = new DatabaseSync(databasePath(home));
      db.exec(
        `PRAGMA journal_mode = DELETE; PRAGMA user_version = ${String(MIGRATIONS.length + 1)}`,
      );
      db.close();
    },
    refusal: "made by a newer Rufi",
    empty: false,
  },
  {
    record: "an unknown record",
    prepare: () => {
      const db = new DatabaseSync(databasePath(home));
      db.exec("PRAGMA journal_mode = DELETE; CREATE TABLE unknown (id TEXT)");
      db.close();
    },
    refusal: "isn't a record this Rufi knows",
    empty: false,
  },
  ...[true, false].map((marked) => ({
    record: `an existing empty record ${marked ? "with" : "without"} installed.json`,
    prepare: async () => {
      await writeFile(databasePath(home), "");
      if (!marked) await rm(markerPath(home));
    },
    refusal: "restore",
    empty: true,
  })),
])(
  "refuses $record, unchanged and with no backup made",
  async ({ prepare, refusal, empty }) => {
    const path = databasePath(home);
    await Promise.resolve().then(prepare);
    const before = await sha(path);
    const names = (await readdir(home)).sort();

    await expect(
      openRecord(home).then((store) => {
        store.close();
      }),
    ).rejects.toThrow(refusal);
    // The writable opener is also used without the startup gate.
    if (empty) {
      expect(() => {
        openWritable(path).close();
      }).toThrow(refusal);
    }

    expect(await sha(path)).toBe(before);
    expect((await readdir(home)).sort()).toEqual(names);
  },
);

it("opens a record the migrations made as this Rufi's own (schema.sql is what they make)", async () => {
  const path = databasePath(join(root, "migrated"));
  await mkdir(join(root, "migrated"));
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length)}`);
  db.close();

  expect(() => openReadOnly(path)?.close()).not.toThrow();
});
