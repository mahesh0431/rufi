// Backups on real database files: what a backup holds, that a save is in it
// whole or not at all, which ones are kept, and what the daily job does
// when a backup fails or was stopped.
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backupJob,
  backupsPath,
  listBackups,
  makeBackup,
  toKeep,
  type Backup,
} from "./backup.ts";
import { databasePath, openWritable } from "./database.ts";

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

const at = (day: number, hour = 12) => new Date(2026, 8, day, hour);
const backup = (date: Date): Backup => ({
  name: `${String(date.getMonth() + 1)}-${String(date.getDate())}-${String(date.getHours())}`,
  createdAt: date,
});

describe("which backups are kept", () => {
  it("keeps the newest of each of the last 7 days and of the last 4 weeks that had one", () => {
    // September 2026: Mondays on the 7th, 14th, 21st and 28th. Rufi ran on
    // these days (twice on the 29th); it was closed 10th–19th, and the 24th
    // failed, so it has none.
    const made = [
      ...[1, 2, 3, 4, 5, 6, 8, 9, 20, 21, 22, 23, 25, 26, 27, 28, 30].map((d) =>
        backup(at(d)),
      ),
      backup(at(29, 9)),
      backup(at(29, 18)),
    ];
    expect([...toKeep(made)].sort()).toEqual(
      [
        // The last 7 days that had one; the 29th's newest only.
        "9-30-12",
        "9-29-18",
        "9-28-12",
        "9-27-12",
        "9-26-12",
        "9-25-12",
        "9-23-12",
        // The newest of the last 4 weeks that had one: from the 28th (the
        // 30th, kept above), the 21st (the 27th, kept above), the 14th (only
        // Sunday the 20th) and the 7th (the 9th). Not 31 Aug's week.
        "9-20-12",
        "9-9-12",
      ].sort(),
    );
  });

  it("never drops the last good backups however long Rufi was closed", () => {
    const made = [backup(at(1)), backup(at(2))];
    expect([...toKeep(made)].sort()).toEqual(["9-1-12", "9-2-12"]);
  });
});

describe("the daily backup", () => {
  it("makes one at start when there is none, and none when the newest is less than a day old", async () => {
    let now = new Date(2026, 9, 8, 9, 0);
    const job = backupJob(home, () => undefined, { now: () => now });
    await job.start();
    await job.close();
    expect((await listBackups(home)).length).toBe(1);

    now = new Date(2026, 9, 9, 8, 59);
    const again = backupJob(home, () => undefined, { now: () => now });
    await again.start();
    await again.close();
    expect((await listBackups(home)).length).toBe(1);

    now = new Date(2026, 9, 9, 9, 0);
    const later = backupJob(home, () => undefined, { now: () => now });
    await later.start();
    await later.close();
    expect((await listBackups(home)).length).toBe(2);
  });

  it("says why a backup failed, and keeps the last good one", async () => {
    let now = new Date(2026, 9, 1, 9, 0);
    const logged: string[] = [];
    const job = backupJob(home, (event) => logged.push(event), {
      now: () => now,
    });
    const good = await job.backUp();
    now = new Date(2026, 9, 8, 9, 0);
    await chmod(backupsPath(home), 0o500);
    try {
      await expect(job.backUp()).rejects.toThrow();
    } finally {
      await chmod(backupsPath(home), 0o700);
    }
    const status = await job.status();
    expect(status.last?.name).toBe(good.name);
    expect(status.failed).toEqual({
      at: now,
      reason: "the backups folder can't be written",
    });
    expect(logged).toEqual(["backup.made", "backup.failed"]);

    await job.backUp();
    expect((await job.status()).failed).toBeUndefined();
    await job.close();
  });

  it("removes what a stopped backup left at the next start, and never counts it", async () => {
    const half = join(backupsPath(home), ".staging-abc123");
    await mkdir(half, { recursive: true });
    await writeFile(join(half, "rufi.sqlite"), "half a copy");
    expect(await listBackups(home)).toEqual([]);
    const job = backupJob(home, () => undefined);
    await job.start();
    await job.close();
    const names = await readdir(backupsPath(home));
    expect(names.some((name) => name.startsWith(".staging-"))).toBe(false);
    expect(names).toHaveLength(1);
  });
});
