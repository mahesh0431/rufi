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
import { readings } from "../documents/reading.ts";
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
    record: {
      kind: "medicine_use",
      id: "01a12747-0e00-72c9-b7f1-9ea94482ba7d",
    },
  },
  {
    kind: "Medicine use",
    what: "Metformin 500 mg · Mar 2024 · current",
    from: "Saved before Rufi kept sources",
    changedSince: false,
    record: { kind: "medicine_use", id: "med-a1" },
  },
  {
    kind: "Result",
    what: "Vitamin D 24 ng/mL · May 2026",
    from: "Your message, 8 Oct 2026: “My vitamin D in May was 24, not 22”",
    changedSince: false,
    record: { kind: "result", id: "res-a7" },
  },
  {
    kind: "Result",
    what: "Ferritin 35 ng/mL · 1 Sep 2026",
    from: "Sunrise Labs report, collected 1 Sep 2026 · thyroid recheck.jpg, page 1",
    changedSince: false,
    record: { kind: "result", id: "01a12747-0e0e-70a5-afd3-4e38a882c8ab" },
  },
  {
    kind: "Result",
    what: "TSH 4.6 mIU/L · 12 Aug 2026 · amended",
    from: "Sunrise Labs report, collected 1 Sep 2026 · thyroid recheck.jpg, page 1",
    changedSince: true,
    record: { kind: "result", id: "res-a5" },
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

/**
 * Rows as a Rufi before sorting (version 11) had them: the columns
 * migrations 12 and 15 add are left out, to compare an older test's rows.
 */
const beforeSorting = (rows: readonly object[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) =>
          ![
            "issuer",
            "report_number",
            "from_document",
            "sorted_at",
            "quote",
            "sent_at",
          ].includes(key),
      ),
    ),
  );

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
  expect(beforeSorting(after.documents)).toEqual(
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

it("upgrades a record of version 8 so a reading no longer waits for the account: every job, its notebook and its drafts kept, a former wait free to run at once", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 8));
  // Readings as Rufi of version 8 left them: one waiting for the sign-in,
  // one for a usage limit, one running, and one failed after its automatic
  // retry, with a page it saved in the notebook.
  const old = new DatabaseSync(path);
  try {
    old.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, waiting, wait_until, retried, started_at, run_at, ended_at, error, usage, reader, created_at) VALUES
        ('job-failed', 'asha', 'document_read', 'doc-asha-aug', 'failed', 2, '[1,2]', NULL, NULL, 1, '2026-10-16T08:00:00Z', '2026-10-16T08:01:00Z', '2026-10-16T08:02:00Z', 'the reader stopped', '{"totalTokens":120}', '{"model":"gpt-6.1-sol"}', '2026-10-16T08:00:00Z'),
        ('job-sign-in', 'asha', 'document_read', 'doc-asha-aug', 'queued', 1, '[1]', 'sign_in', '2026-10-16T09:00:30Z', 0, '2026-10-16T09:00:00Z', '2026-10-16T09:00:00Z', NULL, NULL, NULL, NULL, '2026-10-16T09:00:00Z'),
        ('job-usage', 'ravi', 'document_read', 'doc-ravi-jul', 'queued', 1, '[1]', 'usage_limit', '2099-01-01T00:00:00Z', 0, '2026-10-16T09:10:00Z', '2026-10-16T09:10:00Z', NULL, NULL, NULL, NULL, '2026-10-16T09:10:00Z'),
        ('job-running', 'asha', 'document_read', 'doc-asha-sep', 'running', 1, '[1]', NULL, NULL, 0, '2026-10-16T09:20:00Z', '2026-10-16T09:20:00Z', NULL, NULL, NULL, NULL, '2026-10-16T09:20:00Z');
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = 'job-failed', entry_attempt = 0, entry_at = '2026-10-16T08:01:30Z'
        WHERE document_id = 'doc-asha-aug' AND position = 2;
    `);
  } finally {
    old.close();
  }
  const stored = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
        pages: db
          .prepare(
            "SELECT * FROM document_pages ORDER BY person_id, document_id, position",
          )
          .all(),
        drafts: db.prepare("SELECT * FROM draft_items ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const before = stored();

  const store = await openRecord(home);
  try {
    const after = stored();
    expect(beforeSorting(after.jobs)).toEqual(
      before.jobs.map(
        ({ waiting: _waiting, wait_until: _until, retried, ...job }) => ({
          ...job,
          retries: retried,
          retry_at: null,
        }),
      ),
    );
    expect(after.pages).toEqual(before.pages);
    expect(beforeSorting(after.drafts)).toEqual(before.drafts);
    // Neither former wait waits any more: the oldest runs now, and no job
    // has a time to wake for.
    const next = await readings(store, () => "2026-10-17T09:00:00.000Z").next();
    expect(next.job?.id).toBe("job-sign-in");
    expect(next.wake).toBeUndefined();
  } finally {
    store.close();
  }
});

it("upgrades a record of version 9 so a chat keeps the context its thread used and a message can wait on its thread's open error: every chat and waiting message kept as it was", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 9));
  // A chat on its AI thread, and a message as Rufi of version 9 held it
  // after its thread didn't open.
  const old = new DatabaseSync(path);
  try {
    old.exec(`
      UPDATE chats SET thread_id = 'thread-asha', thread_provider = 'codex', thread_model = 'gpt-6.1-sol', thread_tools = 'rules-1'
        WHERE person_id = 'asha';
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, held, held_text, created_at, updated_at)
        SELECT 'held-1', person_id, id, 'person', 'Is my HbA1c better?', 1, 'waiting', 'failed', 'Codex stopped.', '2026-10-17T09:00:00Z', '2026-10-17T09:00:00Z'
        FROM chats WHERE person_id = 'asha';
    `);
  } finally {
    old.close();
  }
  const stored = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        chats: db.prepare("SELECT * FROM chats ORDER BY id").all(),
        queue: db.prepare("SELECT * FROM chat_queue ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const before = stored();

  const store = await openRecord(home);
  try {
    const after = stored();
    expect(after.chats).toEqual(
      before.chats.map((chat) => ({
        ...chat,
        context_tokens: null,
        context_window: null,
        context_thread: null,
      })),
    );
    expect(after.queue).toEqual(
      before.queue.map((row) => ({ ...row, hold_id: null })),
    );
    // No meter until the thread reports again.
    expect((await transcripts(store).chat("asha"))?.context).toBeNull();
    // An open error's hold names its occurrence; no other hold has one.
    expect(() => {
      store.db.exec(
        "UPDATE chat_queue SET held = 'open_failed' WHERE id = 'held-1'",
      );
    }).toThrow(/CHECK constraint failed/);
    store.db.exec(
      "UPDATE chat_queue SET held = 'open_failed', hold_id = 'hold-1' WHERE id = 'held-1'",
    );
  } finally {
    store.close();
  }
});

it("upgrades a record of version 10 so the reader can keep page copies: every page, reading and draft kept as it was, and a copy only of the person's own file page", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 10));
  // A reading as Rufi of version 10 left it: a page's entry in its notebook.
  const old = new DatabaseSync(path);
  try {
    old.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, retries, created_at) VALUES
        ('job-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', 0, '2026-10-16T08:00:00Z');
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = 'job-aug', entry_attempt = 1, entry_at = '2026-10-16T08:01:30Z', state = 'read'
        WHERE document_id = 'doc-asha-aug' AND position = 1;
    `);
  } finally {
    old.close();
  }
  const stored = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
        pages: db
          .prepare(
            "SELECT * FROM document_pages ORDER BY person_id, document_id, position",
          )
          .all(),
        drafts: db.prepare("SELECT * FROM draft_items ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const before = stored();

  const store = await openRecord(home);
  try {
    const after = stored();
    expect(beforeSorting(after.jobs)).toEqual(before.jobs);
    expect(after.pages).toEqual(before.pages);
    expect(beforeSorting(after.drafts)).toEqual(before.drafts);
    const page = store.db
      .prepare(
        "SELECT file_id FROM document_pages WHERE document_id = 'doc-asha-aug' AND position = 1",
      )
      .get() as { file_id: string };
    const copy = (person: string) => {
      store.db
        .prepare(
          `INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
           VALUES (?, ?, 1, 'job-aug', 1, 'read', '# Sunrise Labs', '2026-10-17T09:00:00Z')`,
        )
        .run(person, page.file_id);
    };
    // Ravi has no page of Asha's file, nor her reading.
    expect(() => {
      copy("ravi");
    }).toThrow(/FOREIGN KEY constraint failed/);
    copy("asha");
    expect(store.db.prepare("SELECT copy FROM page_copies").all()).toEqual([
      { copy: "# Sunrise Labs" },
    ]);
  } finally {
    store.close();
  }
});

it("upgrades a record of version 11 so Rufi AI sorts: every document, reading and draft kept, and an ended reading counted sorted", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 11));
  // Readings as Rufi of version 11 left them: a done one with entries and
  // drafts, page 1 printing the report's head and page 2 none; one still
  // running; a page with no facts at all.
  const COLLECTED = {
    label: "Collected",
    date: "12/08/2026",
    iso: "2026-08-12",
  };
  const old = new DatabaseSync(path);
  try {
    old.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, retries, ended_at, created_at) VALUES
        ('job-v11-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', 0, '2026-10-16T08:02:00Z', '2026-10-16T08:00:00Z'),
        ('job-v11-sep', 'asha', 'document_read', 'doc-asha-sep', 'running', 1, '[1]', 0, NULL, '2026-10-16T08:00:00Z');
      UPDATE document_pages SET entry = '${JSON.stringify({
        outcome: "read",
        facts: {
          issuer: "Sunrise Labs",
          report_number: "SL-1",
          dates: [COLLECTED],
        },
        items: [],
      })}', entry_job_id = 'job-v11-aug', entry_attempt = 1, state = 'read'
        WHERE document_id = 'doc-asha-aug' AND position = 1;
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = 'job-v11-aug', entry_attempt = 1, state = 'read'
        WHERE document_id = 'doc-asha-aug' AND position = 2;
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = 'job-v11-sep', entry_attempt = 1
        WHERE document_id = 'doc-asha-sep';
      INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at) VALUES
        ('d-v11-1', 'asha', 'doc-asha-aug', 1, 1, 'job-v11-aug', 'lab_result', '{"test_name":"HbA1c","value_text":"6.9"}', '{"test_name":"HbA1c","value_text":"6.9"}', '2026-10-16T08:02:00Z'),
        ('d-v11-2', 'asha', 'doc-asha-aug', 2, 1, 'job-v11-aug', 'lab_result', '{"test_name":"TSH","value_text":"2.3"}', '{"test_name":"TSH","value_text":"2.3"}', '2026-10-16T08:02:00Z'),
        ('d-v11-3', 'asha', 'doc-asha-sep', 1, 1, 'job-v11-sep', 'lab_result', '{"test_name":"Free T4","value_text":"1.1"}', '{"test_name":"Free T4","value_text":"1.1"}', '2026-10-16T08:02:00Z');
    `);
  } finally {
    old.close();
  }
  const stored = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
        jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
        pages: db
          .prepare(
            "SELECT * FROM document_pages ORDER BY person_id, document_id, position",
          )
          .all(),
        drafts: db.prepare("SELECT * FROM draft_items ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const before = stored();

  (await openRecord(home)).close();

  const after = stored();
  expect(beforeSorting(after.documents)).toEqual(before.documents);
  expect(beforeSorting(after.jobs)).toEqual(before.jobs);
  expect(after.pages).toEqual(before.pages);
  expect(beforeSorting(after.drafts)).toEqual(before.drafts);
  expect(
    after.documents.map((d) => [
      d["id"],
      d["issuer"],
      d["report_number"],
      d["from_document"],
    ]),
  ).toEqual(before.documents.map((d) => [d["id"], null, null, null]));
  expect(
    after.jobs
      .filter((j) => String(j["id"]).startsWith("job-v11"))
      .map((j) => [j["id"], j["sorted_at"]]),
  ).toEqual([
    ["job-v11-aug", "2026-10-16T08:02:00Z"],
    ["job-v11-sep", null],
  ]);
  expect(
    after.drafts
      .filter((d) => String(d["id"]).startsWith("d-v11"))
      .map((d) => [d["id"], d["quote"]]),
  ).toEqual([
    ["d-v11-1", null],
    ["d-v11-2", null],
    ["d-v11-3", null],
  ]);
});

it("upgrades a record of version 14 so files start on Send: every document sent as it was added, every reply, line and queued message kept", async () => {
  const path = databasePath(home);
  migrate(path, MIGRATIONS.slice(0, 14));
  const stored = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const all = (table: string) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return {
        documents: all("documents"),
        turns: all("turns"),
        entries: all("transcript_entries"),
        queue: all("chat_queue"),
      };
    } finally {
      db.close();
    }
  };
  const before = stored();
  expect(before.documents.length).toBeGreaterThan(0);
  expect(before.turns.length).toBeGreaterThan(0);

  (await openRecord(home)).close();

  const after = stored();
  expect(after.documents).toEqual(
    before.documents.map((row) => ({ ...row, sent_at: row["added_at"] })),
  );
  expect(after.turns).toEqual(before.turns);
  expect(after.entries).toEqual(before.entries);
  expect(after.queue).toEqual(before.queue);
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
