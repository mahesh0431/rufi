// The notice claim on a real database: which follow-ups just became due or
// overdue, told once per state and due, per person, as counts only.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { claimNotices } from "./notices.ts";

let store: Store;

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
  const home = await mkdtemp(join(tmpdir(), "rufi-notices-"));
  store = openWritable(databasePath(home));
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
      { personId: "asha", due: 1, overdue: 0 },
    ]);
    expect(await claim(at(2026, 12, 20))).toEqual([]);
    expect(await claim(at(2027, 1, 1, 0))).toEqual([
      { personId: "asha", due: 0, overdue: 1 },
    ]);
    expect(await claim(at(2027, 3, 1))).toEqual([]);
  });

  it("tells again when the date moves", async () => {
    followUp("asha", "f1", "2026-12-03");
    await claim(at(2026, 12, 3));

    change("f1", "due", "2027-01");

    expect(await claim(at(2026, 12, 20))).toEqual([]);
    expect(await claim(at(2027, 1, 2))).toEqual([
      { personId: "asha", due: 1, overdue: 0 },
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
      { personId: "asha", due: 0, overdue: 1 },
    ]);
  });

  it("tells only overdue to a Rufi that starts after the due month", async () => {
    followUp("asha", "f1", "2026-12");

    expect(await claim(at(2027, 1, 3))).toEqual([
      { personId: "asha", due: 0, overdue: 1 },
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
      { personId: "asha", due: 1, overdue: 5 },
      { personId: "ravi", due: 1, overdue: 0 },
    ]);
  });
});
