// Rufi AI and the dose log: read_doses and log_dose as Rufi's chat calls
// them, on the fictional family, with the Mac in India.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { transcripts, type ChatRow } from "../chat/transcript.ts";
import { doseLog, type DoseLog } from "../doses/log.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { turnScope } from "../../../tests/scope.ts";
import { forAgent, rufiCaller } from "./tools.ts";

const TZ = process.env["TZ"];
process.env["TZ"] = "Asia/Kolkata";
afterAll(() => {
  if (TZ === undefined) delete process.env["TZ"];
  else process.env["TZ"] = TZ;
});

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);
/** Asha's Metformin at 08:00 and 21:00; Ravi's Atorvastatin at 22:00. */
const TIMES = `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1 WHERE id = 'med-a1';
  UPDATE medicine_uses SET times = '["22:00"]' WHERE id = 'med-r1';`;
/** 4 Nov, 10:00 in India. */
const NOW = "2026-11-04T04:30:00.000Z";

let clock: string;
let store: Store;
let reader: Store;
let doses: DoseLog;
let chat: ChatRow;

beforeEach(async () => {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-doses-")));
  store = openWritable(path);
  store.db.exec(family);
  store.db.exec(TIMES);
  reader = openReadOnly(path) as Store;
  clock = NOW;
  doses = doseLog(store, () => new Date(clock));
  chat = (await transcripts(store, () => clock).chat("asha")) as ChatRow;
});

/** A tool called in Asha's chat, as the door places a call. */
async function call(name: string, input: unknown, callId = "agent-1/1/c-1") {
  const answer = await rufiCaller(
    reader,
    transcripts(store, () => clock),
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    doses,
  )(turnScope(chat, "t-1"))(name, input, callId);
  return JSON.parse(answer.text) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  };
}

describe("read_doses", () => {
  it("gives the person's logs as they came, in local times, with each medicine's timing as it is now; another person's medicine, or more than 62 days, is refused", async () => {
    store.db
      .exec(`INSERT INTO dose_log (id, person_id, medicine_use_id, dose_at, state, taken_at, logged_at, received_at, logged_by) VALUES
      ('d-1', 'asha', 'med-a1', '2026-11-02T21:00', 'taken', NULL, '2026-11-02T15:32:00.000Z', '2026-11-02T15:32:01.000Z', 'app:app-m1'),
      ('d-2', 'asha', 'med-a1', '2026-11-03T08:00', 'skipped', NULL, '2026-11-03T02:40:00.000Z', '2026-11-03T13:32:00.000Z', 'app:app-m1'),
      ('d-3', 'asha', 'med-a1', '2026-11-03T08:00', 'cleared', NULL, '2026-11-03T03:00:00.000Z', '2026-11-03T03:00:00.000Z', 'mac'),
      ('d-4', 'asha', 'med-a1', '2026-11-03T21:00', 'taken', '2026-11-03T15:45:00.000Z', '2026-11-03T17:10:00.000Z', '2026-11-03T17:10:00.000Z', 'rufi_ai'),
      ('d-5', 'ravi', 'med-r1', '2026-11-03T22:00', 'taken', NULL, '2026-11-03T16:31:00.000Z', '2026-11-03T16:31:00.000Z', 'mac');`);
    // Since then, her Metformin moved to 09:00.
    store.db.exec(
      `UPDATE medicine_uses SET times = '["09:00","21:00"]' WHERE id = 'med-a1'`,
    );

    const read = await call("read_doses", {
      from: "2026-11-02",
      to: "2026-11-03",
    });
    expect(read.result?.["doses"]).toEqual([
      {
        medicine: "med-a1",
        dose_at: "2026-11-02T21:00",
        state: "taken",
        logged_at: "2026-11-02T21:02",
        arrived_at: "2026-11-02T21:02",
        by: "iphone",
      },
      {
        medicine: "med-a1",
        dose_at: "2026-11-03T08:00",
        state: "skipped",
        logged_at: "2026-11-03T08:10",
        arrived_at: "2026-11-03T19:02",
        by: "iphone",
      },
      {
        medicine: "med-a1",
        dose_at: "2026-11-03T08:00",
        state: "cleared",
        logged_at: "2026-11-03T08:30",
        arrived_at: "2026-11-03T08:30",
        by: "mac",
      },
      {
        medicine: "med-a1",
        dose_at: "2026-11-03T21:00",
        state: "taken",
        taken_at: "2026-11-03T21:15",
        logged_at: "2026-11-03T22:40",
        arrived_at: "2026-11-03T22:40",
        by: "rufi_ai",
      },
    ]);
    // Her medicines with times, as they are now; Creatine has none.
    expect(read.result?.["medicines"]).toMatchObject([
      {
        id: "med-a1",
        name: "Metformin",
        strength: "500 mg",
        directions: "twice a day",
        times: ["09:00", "21:00"],
        status: "current",
      },
    ]);
    expect(read.result?.["medicines"]).toHaveLength(1);

    for (const input of [
      { from: "2026-11-02", to: "2026-11-03", medicine: "med-r1" },
      { from: "2026-09-01", to: "2026-11-02" },
      { from: "2026-11-03", to: "2026-11-02" },
    ]) {
      const refused = await call("read_doses", input);
      expect(refused.ok, JSON.stringify(input)).toBe(false);
    }
    expect(
      (
        await call("read_doses", {
          from: "2026-09-01",
          to: "2026-11-01",
          medicine: "med-a2",
        })
      ).result,
    ).toMatchObject({ doses: [], medicines: [{ id: "med-a2" }] });
  });
});

describe("log_dose", () => {
  it("logs what the user told for the turn's person, by Rufi AI, its taken time from the Mac's day; the same call again logs nothing more, and open screens hear once", async () => {
    let told = 0;
    doses.subscribe("asha", () => (told += 1));
    const night = {
      medicine: "med-a1",
      dose_at: "2026-11-03T21:00",
      state: "taken",
      taken_at: "2026-11-03T21:15",
    };
    const logged = await call("log_dose", night);
    expect(logged).toEqual({
      ok: true,
      result: {
        logged: {
          medicine: { id: "med-a1", name: "Metformin", strength: "500 mg" },
          dose_at: "2026-11-03T21:00",
          state: "taken",
          taken_at: "2026-11-03T21:15",
          logged_at: "2026-11-04T10:00",
        },
      },
    });
    // The provider sends the same call again, a moment later.
    clock = "2026-11-04T04:30:05.000Z";
    expect(await call("log_dose", night)).toEqual({
      ok: true,
      result: { ...logged.result, already: true },
    });
    expect(told).toBe(1);

    const stored = await doses.list("asha", "2026-11-03", "2026-11-03");
    expect(stored).toEqual([
      {
        id: "agent-1/1/c-1",
        medicine: { id: "med-a1", name: "Metformin", strength: "500 mg" },
        doseAt: "2026-11-03T21:00",
        state: "taken",
        takenAt: "2026-11-03T15:45:00.000Z",
        loggedAt: NOW,
        receivedAt: NOW,
        by: "rufi_ai",
      },
    ]);
  });

  it("refuses another person's medicine, a call already used for another log, and taken_at without taken; nothing is logged", async () => {
    for (const [input, callId] of [
      [
        { medicine: "med-r1", dose_at: "2026-11-03T22:00", state: "taken" },
        "agent-1/1/c-2",
      ],
      [
        {
          medicine: "med-a1",
          dose_at: "2026-11-03T21:00",
          state: "skipped",
          taken_at: "2026-11-03T21:15",
        },
        "agent-1/1/c-3",
      ],
    ] as const) {
      expect((await call("log_dose", input, callId)).ok).toBe(false);
    }
    await call("log_dose", {
      medicine: "med-a1",
      dose_at: "2026-11-03T21:00",
      state: "taken",
    });
    expect(
      (
        await call("log_dose", {
          medicine: "med-a1",
          dose_at: "2026-11-03T21:00",
          state: "skipped",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await doses.list("asha", "2026-11-03", "2026-11-03")).map(
        (d) => d.state,
      ),
    ).toEqual(["taken"]);
    expect(await doses.list("ravi", "2026-11-03", "2026-11-03")).toEqual([]);

    // Outside Rufi's chat, there is no one's word to log.
    const answer = await forAgent(
      () => ({ store: reader, personId: "asha" }),
      () => undefined,
    ).call("log_dose", {
      medicine: "med-a1",
      dose_at: "2026-11-04T08:00",
      state: "taken",
    });
    expect(answer.ok).toBe(false);
  });
});
