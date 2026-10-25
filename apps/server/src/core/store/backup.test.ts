// Backups on real database files: what a backup holds, that a save is in it
// whole or not at all, which ones are kept, and what the daily job does
// when a backup fails or was stopped.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documents } from "../documents/documents.ts";
import { filesPath } from "../documents/originals.ts";
import { backupJob, backupsPath, listBackups, makeBackup } from "./backup.ts";
import { databasePath, openWritable } from "./database.ts";
import { addSent } from "../../../tests/sent.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-backup-"));
  openWritable(databasePath(home)).close();
});

const people = (path: string) =>
  new DatabaseSync(path, { readOnly: true })
    .prepare("SELECT id, display_name FROM people ORDER BY id")
    .all()
    .map((row) => ({ ...row }));

describe("a backup", () => {
  it("is a checked copy of the record only: never the sign-in, the AI's files, logs, locks or the model list", async () => {
    const store = openWritable(databasePath(home));
    store.db.exec(
      "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
    );
    store.close();
    await writeFile(join(home, "chatgpt.json"), '{"hostId":"urn:uuid:fake"}');
    await writeFile(join(home, "models.json"), '{"models":["gpt-6-astra"]}');
    await writeFile(join(home, "core.json"), '{"port":1,"launcher":"x"}');
    await mkdir(join(home, "codex"));
    await mkdir(join(home, "logs"));
    await mkdir(join(home, "rufi.lock"));

    const made = await makeBackup(home, new Date(2026, 9, 8, 9, 14, 3));

    expect(made.name).toBe("2026-10-08-091403");
    const folder = join(backupsPath(home), made.name);
    expect((await readdir(folder)).sort()).toEqual([
      "backup.json",
      "files",
      "rufi.sqlite",
    ]);
    expect(people(join(folder, "rufi.sqlite"))).toEqual([
      { id: "asha", display_name: "Asha Fictional" },
    ]);
  });

  it("has every save made before it, and a save made during it whole or not at all", async () => {
    const store = openWritable(databasePath(home));
    // Each save adds a person and their follow-up together.
    let saves = 0;
    const writing = { on: true };
    const writer = (async () => {
      while (writing.on) {
        const n = String(saves);
        store.db.exec(`BEGIN;
          INSERT INTO people (id, display_name) VALUES ('p${n}', 'Fictional ${n}');
          INSERT INTO follow_ups (id, person_id, title)
            VALUES ('f${n}', 'p${n}', 'Recheck');
          COMMIT;`);
        saves++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 300; i++) {
      store.db.exec(
        `INSERT INTO settings (key, value) VALUES ('padding.${String(i)}', '${"x".repeat(2000)}')`,
      );
    }
    const copies: { path: string; savedBefore: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const savedBefore = saves;
      const made = await makeBackup(home, new Date(2026, 9, 8, 9, 14, i));
      copies.push({
        path: join(backupsPath(home), made.name, "rufi.sqlite"),
        savedBefore,
      });
    }
    writing.on = false;
    await writer;
    store.close();
    expect(saves).toBeGreaterThan(0);
    for (const { path, savedBefore } of copies) {
      const db = new DatabaseSync(path, { readOnly: true });
      const count = (table: string) =>
        (
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n;
      expect(count("people")).toBeGreaterThanOrEqual(savedBefore);
      expect(count("follow_ups")).toBe(count("people"));
      db.close();
    }
  });
});

/** A copy that finds the disk full, as node:sqlite reports SQLITE_FULL. */
const diskFull = () =>
  Promise.reject(
    Object.assign(new Error("database or disk is full"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 13,
      errstr: "database or disk is full",
    }),
  );

const HOUR_MS = 60 * 60 * 1000;

const until = async (ready: () => boolean) => {
  for (let i = 0; !ready(); i++) {
    if (i > 300) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
      await addSent(docs, store, "asha", [{ name, bytes }]);
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

describe("a backup's original files", () => {
  it("holds every original exactly as it came, and no display copy", async () => {
    const ids = await withDocuments();

    const made = await makeBackup(home, new Date(2026, 9, 8, 9));

    const folder = join(backupsPath(home), made.name);
    expect((await readdir(join(folder, "files"))).sort()).toEqual(ids.sort());
    for (const id of ids) {
      expect(await readFile(join(folder, "files", id))).toEqual(
        await readFile(join(filesPath(home), id)),
      );
    }
    expect((await readdir(folder)).sort()).toEqual([
      "backup.json",
      "files",
      "rufi.sqlite",
    ]);
  });

  it.each([
    ["missing", (path: string) => rm(path)],
    // The same size, one byte other: only the hash finds it.
    ["changed", (path: string) => flipOneByte(path)],
  ])(
    "fails visibly when an original is %s, and the last good backup stays",
    async (_how, spoil) => {
      const [id = ""] = await withDocuments();
      let now = new Date(2026, 9, 8, 9);
      const good = await makeBackup(home, now);
      await spoil(join(filesPath(home), id));

      now = new Date(2026, 9, 8, 10);
      const job = backupJob(home, () => undefined, { now: () => now });
      await expect(job.backUp()).rejects.toThrow();

      expect(job.status()).toEqual({
        last: undefined,
        failed: { at: now, reason: "a document file is missing or changed" },
        running: false,
      });
      expect(await listBackups(home)).toEqual([good]);
    },
  );
});

describe("the daily backup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes one at every start, then when the newest is a day old", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = new Date(2026, 9, 8, 9);
    const first = backupJob(home, () => undefined, { now: () => now });
    first.start();
    await first.close();
    expect(first.status().last?.createdAt).toEqual(now);

    // Started again an hour later: a new backup, though one is recent.
    now = new Date(2026, 9, 8, 10);
    const job = backupJob(home, () => undefined, { now: () => now });
    job.start();
    await until(() => !job.status().running);
    expect(job.status().last?.createdAt).toEqual(now);

    // Then every hour: none while the newest is less than a day old.
    now = new Date(2026, 9, 9, 9, 59);
    vi.advanceTimersByTime(HOUR_MS);
    await job.close();
    expect(job.status().last?.createdAt).toEqual(new Date(2026, 9, 8, 10));

    const again = backupJob(home, () => undefined, { now: () => now });
    again.start();
    await until(() => !again.status().running);
    now = new Date(2026, 9, 10, 9, 59);
    vi.advanceTimersByTime(HOUR_MS);
    await until(
      () => again.status().last?.createdAt.getTime() === now.getTime(),
    );
    await again.close();
  });

  it("finds a full disk again after a restart, and the warning goes when a backup works", async () => {
    let now = new Date(2026, 9, 8, 9);
    const good = await backupJob(home, () => undefined, {
      now: () => now,
    }).backUp();

    // The disk fills: Rufi can still start, but a copy doesn't fit.
    now = new Date(2026, 9, 8, 9, 30);
    const logged: string[] = [];
    const full = backupJob(home, (event) => logged.push(event), {
      now: () => now,
      copy: diskFull,
    });
    full.start();
    await full.close();
    expect(full.status()).toEqual({
      last: good,
      failed: { at: now, reason: "the disk is full" },
      running: false,
    });
    expect(logged).toEqual(["backup.failed"]);

    // Rufi starts again on the same full disk, with a good backup from less
    // than a day ago.
    now = new Date(2026, 9, 8, 10);
    const restarted = backupJob(home, () => undefined, {
      now: () => now,
      copy: diskFull,
    });
    restarted.start();
    await restarted.close();
    expect(restarted.status().failed).toEqual({
      at: now,
      reason: "the disk is full",
    });

    // Space is freed.
    now = new Date(2026, 9, 8, 10, 30);
    const freed = backupJob(home, () => undefined, { now: () => now });
    freed.start();
    await freed.close();
    expect(freed.status().failed).toBeUndefined();
    expect(freed.status().last?.createdAt).toEqual(now);
  });

  it("shows the start's backup as running, with the last good one, and Back up now joins it", async () => {
    let now = new Date(2026, 9, 8, 9);
    const good = await backupJob(home, () => undefined, {
      now: () => now,
    }).backUp();

    now = new Date(2026, 9, 8, 10);
    const copying = Promise.withResolvers<undefined>();
    const job = backupJob(home, () => undefined, {
      now: () => now,
      copy: async (...args) => {
        await copying.promise;
        return backup(...args);
      },
    });
    job.start();
    expect(job.status().running).toBe(true);
    await until(() => job.status().last !== undefined);
    expect(job.status()).toEqual({
      last: good,
      failed: undefined,
      running: true,
    });
    const joined = job.backUp();
    copying.resolve(undefined);
    const made = await joined;
    await job.close();
    expect(made.createdAt).toEqual(now);
    expect(job.status()).toEqual({
      last: made,
      failed: undefined,
      running: false,
    });
    // One backup for the start and Back up now together; the start's
    // replaced the earlier one of the same day.
    expect(await listBackups(home)).toEqual([made]);
  });

  it("removes what a stopped backup left at the next start, and never counts it", async () => {
    const half = join(backupsPath(home), ".staging-abc123");
    await mkdir(half, { recursive: true });
    await writeFile(join(half, "rufi.sqlite"), "half a copy");
    expect(await listBackups(home)).toEqual([]);
    const job = backupJob(home, () => undefined);
    job.start();
    await job.close();
    const names = await readdir(backupsPath(home));
    expect(names.some((name) => name.startsWith(".staging-"))).toBe(false);
    expect(names).toHaveLength(1);
  });
});

const names = async () => (await readdir(backupsPath(home))).sort();

describe("which backups the daily backup keeps", () => {
  it("gives two backups made in the same second their own names, and keeps the newer", async () => {
    const at = new Date(2026, 9, 8, 15, 38, 18);
    const job = backupJob(home, () => undefined, { now: () => at });
    const first = await job.backUp();
    const second = await job.backUp();
    await job.close();
    expect([first.name, second.name]).toEqual([
      "2026-10-08-153818",
      "2026-10-08-153818-2",
    ]);
    expect(await names()).toEqual(["2026-10-08-153818-2"]);
    expect(job.status().last).toEqual(second);
  });

  it("keeps the newest of each of the last 7 days and 4 weeks that had one, and removes nothing when a backup fails", async () => {
    let now = new Date(2026, 8, 1, 12);
    const job = backupJob(home, () => undefined, { now: () => now });
    // September 2026: Mondays on the 7th, 14th, 21st and 28th. Rufi ran on
    // these days (twice on the 29th); it was closed 10th–19th; the backup
    // on the 24th failed.
    const days = [1, 2, 3, 4, 5, 6, 8, 9, 20, 21, 22, 23, 24, 25, 26, 27, 28];
    for (const day of days) {
      now = new Date(2026, 8, day, 12);
      if (day !== 24) {
        await job.backUp();
        continue;
      }
      const before = await names();
      await chmod(backupsPath(home), 0o500);
      try {
        await expect(job.backUp()).rejects.toThrow();
      } finally {
        await chmod(backupsPath(home), 0o700);
      }
      expect(await names()).toEqual(before);
    }
    for (const at of [
      new Date(2026, 8, 29, 9),
      new Date(2026, 8, 29, 18),
      new Date(2026, 8, 30, 12),
    ]) {
      now = at;
      await job.backUp();
    }
    await job.close();

    expect(await names()).toEqual([
      // The newest of each of the last 4 weeks that had one: the weeks from
      // the 7th (the 9th) and the 14th (only Sunday the 20th); the 21st's
      // and 28th's newest are among the days below.
      "2026-09-09-120000",
      "2026-09-20-120000",
      // The last 7 days that had one; the 29th's newest only.
      "2026-09-23-120000",
      "2026-09-25-120000",
      "2026-09-26-120000",
      "2026-09-27-120000",
      "2026-09-28-120000",
      "2026-09-29-180000",
      "2026-09-30-120000",
    ]);
  });
});

describe("a backup that is damaged or gone", () => {
  it("doesn't count: the last good one is the newest that passes its check, and it says so until a backup works", async () => {
    let now = new Date(2026, 8, 30, 23);
    const job = backupJob(home, () => undefined, { now: () => now });
    const good = await job.backUp();
    now = new Date(2026, 9, 1, 1);
    const damaged = await job.backUp();
    await job.close();
    const file = join(backupsPath(home), damaged.name, "rufi.sqlite");
    const bytes = await readFile(file);
    bytes.writeUInt8(bytes.readUInt8(100) ^ 0xff, 100);
    await writeFile(file, bytes);

    now = new Date(2026, 9, 1, 11);
    const copying = Promise.withResolvers<undefined>();
    const later = backupJob(home, () => undefined, {
      now: () => now,
      copy: async (...args) => {
        await copying.promise;
        return backup(...args);
      },
    });
    later.start();
    await until(() => later.status().last !== undefined);
    expect(later.status()).toEqual({
      last: good,
      failed: { at: now, reason: "a backup is damaged or incomplete" },
      running: true,
    });
    copying.resolve(undefined);
    await later.close();
    expect(later.status().last?.createdAt).toEqual(now);
    expect(later.status().failed).toBeUndefined();
  });
});
