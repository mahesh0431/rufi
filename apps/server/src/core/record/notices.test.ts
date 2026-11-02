// The notice claim on a real database: which follow-ups just became due or
// overdue, told once per state and due, per person, as counts only.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { claimNotices } from "./notices.ts";

let store: Store;
let dirname: string;

/** A local time on the Mac. */
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h);

/** A follow-up as a save leaves it (setup only: the claim never writes it). */
function followUp(
  person: string,
  id: string,
  due: string | null,
  status = "open",
): void {
  store.db
    .prepare(
      "INSERT INTO follow_ups (id, person_id, title, due, status) VALUES (?, ?, 'Recheck HbA1c', ?, ?)",
    )
    .run(id, person, due, status);
}

/** A later save's change to a follow-up. */
function change(id: string, set: string, value: string | number): void {
  store.db
    .prepare(`UPDATE follow_ups SET ${set} = ? WHERE id = ?`)
    .run(value, id);
}

const claim = (now: Date) => claimNotices(store.query, now);

beforeEach(async () => {
  dirname = await mkdtemp(join(tmpdir(), "rufi-notices-"));
  store = openWritable(databasePath(dirname));
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')",
  );
});

afterEach(() => {
  store.close();
});

describe("the notice claim", () => {
  it("tells due once, then overdue once, then nothing", async () => {
    followUp("asha", "f1", "2026-12");

    expect(await claim(at(2026, 11, 30))).toEqual([]);
    expect(await claim(at(2026, 12, 1, 0))).toEqual([
      { personId: "asha", due: 1, overdue: 0, medicines: 0 },
    ]);
    expect(await claim(at(2026, 12, 20))).toEqual([]);
    expect(await claim(at(2027, 1, 1, 0))).toEqual([
      { personId: "asha", due: 0, overdue: 1, medicines: 0 },
    ]);
    expect(await claim(at(2027, 3, 1))).toEqual([]);
  });

  it("tells again when the date moves", async () => {
    followUp("asha", "f1", "2026-12-03");
    await claim(at(2026, 12, 3));

    change("f1", "due", "2027-01");

    expect(await claim(at(2026, 12, 20))).toEqual([]);
    expect(await claim(at(2027, 1, 2))).toEqual([
      { personId: "asha", due: 1, overdue: 0, medicines: 0 },
    ]);
  });

  it("never tells a follow-up that is done, dropped or removed before the claim", async () => {
    followUp("asha", "f1", "2026-12");
    followUp("asha", "f2", "2026-12");
    followUp("asha", "f3", "2026-12");
    followUp("asha", "f4", "2026-12", "dropped");
    change("f1", "status", "done");
    change("f2", "removed", 1);

    expect(await claim(at(2027, 2, 1))).toEqual([
      { personId: "asha", due: 0, overdue: 1, medicines: 0 },
    ]);
  });

  it("tells only overdue to a Rufi that starts after the due month", async () => {
    followUp("asha", "f1", "2026-12");

    expect(await claim(at(2027, 1, 3))).toEqual([
      { personId: "asha", due: 0, overdue: 1, medicines: 0 },
    ]);
    expect(await claim(at(2027, 1, 4))).toEqual([]);
  });

  it("never lowers what it told when the clock goes back", async () => {
    followUp("asha", "f1", "2026-12");
    await claim(at(2027, 1, 1));

    expect(await claim(at(2026, 12, 20))).toEqual([]);
    expect(await claim(at(2027, 1, 2))).toEqual([]);
  });

  it('counts each person\'s follow-ups; "at the next visit" and no date are never told', async () => {
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
      followUp("asha", id, "2026-09");
    }
    followUp("asha", "a6", "2026-10-11");
    followUp("asha", "a7", "next_visit");
    followUp("asha", "a8", null);
    followUp("ravi", "r1", "2026-10");

    expect(await claim(at(2026, 10, 11))).toEqual([
      { personId: "asha", due: 1, overdue: 5, medicines: 0 },
      { personId: "ravi", due: 1, overdue: 0, medicines: 0 },
    ]);
  });
});

/** A medicine use as a save left it at `saved` (setup only). */
function medicine(
  person: string,
  id: string,
  fields: Record<string, string | number | null>,
  saved?: string,
): void {
  const row = {
    name: "Amoxicillin",
    status: "current",
    times: '["08:00","21:00"]',
    remind: 1,
    ...fields,
  };
  const names = Object.keys(row);
  store.db
    .prepare(
      `INSERT INTO medicine_uses (id, person_id, ${names.join(", ")}) VALUES (?, ?, ${names.map(() => "?").join(", ")})`,
    )
    .run(id, person, ...Object.values(row));
  if (saved === undefined) return;
  const operation = `op-${id}-${saved}`;
  store.db
    .prepare(
      "INSERT INTO operations (id, seq, person_id, origin, call_id, request, created_at) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM operations), ?, 'settings', ?, '{}', ?)",
    )
    .run(operation, person, operation, saved);
  store.db
    .prepare(
      "INSERT INTO record_changes (operation_id, seq, person_id, kind, record_id, action, after) VALUES (?, 1, ?, 'medicine_use', ?, 'add', '{}')",
    )
    .run(operation, person, id);
}

const minute = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min);

describe("medicine reminders", () => {
  // Saved Sunday 1 Nov at 18:10, from tonight 21:00 to 6 Nov 08:00.
  const course = {
    started: "2026-11-01T21:00",
    until: "2026-11-06T08:00",
  };
  const saved = minute(2026, 11, 1, 18, 10).toISOString();

  it("tells a new course's first dose at its time, once, also after a restart", async () => {
    medicine("asha", "amox", course, saved);

    expect(await claim(minute(2026, 11, 1, 20, 59))).toEqual([]);
    expect(await claim(minute(2026, 11, 1, 21, 0))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "21:00",
        show: "count",
      },
    ]);
    expect(await claim(minute(2026, 11, 1, 21, 1))).toEqual([]);
    // Rufi restarted: the marker is in the record.
    store.close();
    store = openWritable(databasePath(dirname));
    expect(await claim(minute(2026, 11, 1, 21, 30))).toEqual([]);
    expect(await claim(minute(2026, 11, 2, 8, 0))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "08:00",
        show: "count",
      },
    ]);
  });

  it("tells a dose up to 60 minutes late, and passes over one later than that", async () => {
    medicine("asha", "late", course, saved);
    expect(await claim(minute(2026, 11, 1, 21, 20))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "21:00",
        show: "count",
      },
    ]);
    medicine("ravi", "later", course, saved);
    expect(await claim(minute(2026, 11, 1, 22, 30))).toEqual([]);
    // The passed-over dose isn't told later; the next one is.
    expect(await claim(minute(2026, 11, 2, 8, 0))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "08:00",
        show: "count",
      },
      {
        personId: "ravi",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "08:00",
        show: "count",
      },
    ]);
  });

  it("never tells a stopped, paused or removed medicine, or one with reminders off", async () => {
    medicine("asha", "stopped", { ...course, status: "stopped" }, saved);
    medicine("asha", "paused", { ...course, status: "paused" }, saved);
    medicine("asha", "removed", { ...course, removed: 1 }, saved);
    medicine("asha", "off", { ...course, remind: 0 }, saved);
    expect(await claim(minute(2026, 11, 1, 21, 0))).toEqual([]);
  });

  it("tells nothing again when the clock goes back", async () => {
    medicine("asha", "amox", course, saved);
    expect(await claim(minute(2026, 11, 2, 8, 0))).toHaveLength(1);
    expect(await claim(minute(2026, 11, 1, 21, 5))).toEqual([]);
    expect(await claim(minute(2026, 11, 2, 8, 10))).toEqual([]);
  });

  it("tells on the Mac only where the person chose it, passing over a dose rung on their iPhone; names medicines only at Which ones", async () => {
    medicine(
      "asha",
      "amox",
      { ...course, strength: "500 mg", amount: "1 capsule" },
      saved,
    );
    medicine(
      "asha",
      "iron",
      { ...course, name: "Iron", strength: null, amount: null },
      saved,
    );
    medicine("ravi", "r1", course, saved);
    // Asha paired her iPhone: her reminders ring there.
    store.db
      .exec(`INSERT INTO paired_apps (id, person_id, kind, name, key_sha256, paired_at)
      VALUES ('app-1', 'asha', 'iphone', 'Asha''s iPhone', 'k1', '2026-11-01T10:00:00Z')`);
    expect(await claim(minute(2026, 11, 1, 21, 0))).toEqual([
      {
        personId: "ravi",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "21:00",
        show: "count",
      },
    ]);
    // Both, and which ones: the next dose rings on the Mac too, with names.
    store.db.exec(
      "INSERT INTO reminder_settings (person_id, show, ring) VALUES ('asha', 'names', 'both'), ('ravi', 'time', NULL)",
    );
    expect(await claim(minute(2026, 11, 2, 8, 0))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 2,
        at: "08:00",
        show: "names",
        names: ["Amoxicillin 500 mg · 1 capsule", "Iron"],
      },
      {
        personId: "ravi",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "08:00",
        show: "time",
      },
    ]);
    // Her iPhone unpaired: the Mac again, whatever she chose before.
    store.db.exec(
      "UPDATE paired_apps SET revoked_at = '2026-11-02T10:00:00Z'; UPDATE reminder_settings SET ring = 'iphone' WHERE person_id = 'asha'",
    );
    expect(await claim(minute(2026, 11, 2, 21, 0))).toMatchObject([
      { personId: "asha", medicines: 2 },
      { personId: "ravi", medicines: 1 },
    ]);
  });

  it("counts each person's own, with the time when they share one", async () => {
    medicine("asha", "a1", { times: '["08:00"]' }, saved);
    medicine("asha", "a2", { times: '["08:00","20:00"]' }, saved);
    medicine("ravi", "r1", { times: '["07:30"]' }, saved);
    expect(await claim(minute(2026, 11, 2, 8, 0))).toEqual([
      {
        personId: "asha",
        due: 0,
        overdue: 0,
        medicines: 2,
        at: "08:00",
        show: "count",
      },
      {
        personId: "ravi",
        due: 0,
        overdue: 0,
        medicines: 1,
        at: "07:30",
        show: "count",
      },
    ]);
  });
});
