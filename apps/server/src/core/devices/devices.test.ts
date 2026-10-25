// Device data on a real database: receive stores first, the converter turns
// each batch into values in one transaction, in arrival order per person
// and system, and a failure holds back only its group. Fictional people:
// Asha (two phones) and Ravi.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import {
  devices,
  MAX_BATCH_BYTES,
  MAX_ENTRIES,
  type Devices,
  type Step,
} from "./devices.ts";

const T0 = "2026-10-22T07:00:00.000Z";
let clock = T0;
const now = () => clock;
const later = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
const DAY = 24 * 60 * 60 * 1000;

let store: Store;
let device: Devices;
let phone: string;
let watch: string;
let ravi: string;

beforeEach(async () => {
  clock = T0;
  const home = await mkdtemp(join(tmpdir(), "rufi-devices-"));
  store = openWritable(databasePath(home));
  store.db.exec(
    `INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')`,
  );
  device = devices(store, now);
  phone = await sourceFor("asha", "Asha's iPhone");
  watch = await sourceFor("asha", "Asha's iPad");
  ravi = await sourceFor("ravi", "Ravi's iPhone");
  return () => {
    store.close();
  };
});

async function sourceFor(personId: string, name: string) {
  const made = await device.addSource({
    name,
    system: "apple_health",
    personId,
  });
  if (!("source" in made)) throw new Error("no source");
  return made.source.id;
}

/** A resting heart rate for a day, as the phone sends it. */
const resting = (
  id: string,
  day: string,
  value: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: "HKQuantityTypeIdentifierRestingHeartRate",
  value,
  unit: "count/min",
  start: `${day}T00:00:00+05:30`,
  end: `${day}T23:59:59+05:30`,
  utc_offset: 330,
  time_zone: "Asia/Kolkata",
  device: "Apple Watch",
  ...extra,
});

const page = (batch: string, values: unknown[], deleted: unknown[] = []) =>
  new TextEncoder().encode(JSON.stringify({ batch, values, deleted }));

async function convertAll(): Promise<Step[]> {
  const steps: Step[] = [];
  for (;;) {
    const step = await device.convertNext();
    if ("idle" in step) return steps;
    steps.push(step);
  }
}

const rows = (query: string, ...args: (string | number)[]) =>
  store.db.prepare(query).all(...args) as Record<string, unknown>[];

const batchRow = (id: string) =>
  rows("SELECT * FROM device_batches WHERE id = ?", id)[0] as Record<
    string,
    unknown
  >;

const valuesOf = () =>
  rows(
    "SELECT external_id, value, start_at, removed_at, batch_id, source_id FROM device_values ORDER BY external_id",
  );

const got = async (sourceId: string, bytes: Uint8Array) => {
  const receipt = await device.receive(sourceId, bytes);
  if (receipt.answer !== "got_it")
    throw new Error(`not got: ${JSON.stringify(receipt)}`);
  return receipt.batch;
};

describe("making a source", () => {
  it("binds it to the only person, or asks for the person when there are several", async () => {
    expect(
      await device.addSource({ name: "A phone", system: "apple_health" }),
    ).toEqual({
      needsPerson: [
        { id: "asha", name: "Asha Fictional" },
        { id: "ravi", name: "Ravi Fictional" },
      ],
    });
    expect(
      await device.addSource({
        name: "A phone",
        system: "apple_health",
        personId: "nobody",
      }),
    ).toHaveProperty("needsPerson");
    expect(
      rows("SELECT name FROM device_sources WHERE name = 'A phone'"),
    ).toEqual([]);

    store.db.exec(
      "DELETE FROM device_sources WHERE person_id = 'ravi'; DELETE FROM people WHERE id = 'ravi'",
    );
    expect(
      await device.addSource({ name: "A phone", system: "apple_health" }),
    ).toMatchObject({
      source: {
        name: "A phone",
        person: { id: "asha", name: "Asha Fictional" },
      },
    });
  });
});

describe("receiving a batch", () => {
  it("stores it as it came, waiting, and knows it when it comes again", async () => {
    const bytes = page("p-1", [resting("v-1", "2026-10-20", 54)]);
    const first = await got(phone, bytes);
    const second = await got(phone, page("p-2", []));
    const row = batchRow(first);
    expect(row).toMatchObject({
      person_id: "asha",
      source_id: phone,
      sender_batch_id: "p-1",
      status: "waiting",
      body_bytes: bytes.byteLength,
    });
    expect(new Uint8Array(gunzipSync(row.body as Uint8Array))).toEqual(bytes);
    expect(Number(batchRow(second).seq)).toBe(Number(row.seq) + 1);
    expect(
      rows("SELECT last_batch_at FROM device_sources WHERE id = ?", phone),
    ).toEqual([{ last_batch_at: T0 }]);

    expect(await device.receive(phone, bytes)).toEqual({
      answer: "already_got",
      batch: first,
    });
    // The same page from Asha's other phone is that phone's own.
    expect(await device.receive(watch, bytes)).toMatchObject({
      answer: "got_it",
    });
  });

  it.each([
    [
      "the batch ID again with other bytes",
      () => page("p-1", [resting("v-1", "2026-10-20", 55)]),
      ["batch_id_reused"],
    ],
    [
      "a batch too big",
      () => new Uint8Array(MAX_BATCH_BYTES + 1).fill(32),
      ["too_big"],
    ],
    [
      "text that isn't JSON",
      () => new TextEncoder().encode('{"batch": "p-9", "values": ['),
      ["not_json"],
    ],
    [
      "bytes that aren't text",
      () => new Uint8Array([0xff, 0xfe, 0x7b]),
      ["not_json"],
    ],
    [
      "a list, not a batch",
      () => new TextEncoder().encode("[]"),
      ["no_batch_id", "lists_missing"],
    ],
    [
      "no batch ID and no deletions",
      () => new TextEncoder().encode('{"values": []}'),
      ["no_batch_id", "lists_missing"],
    ],
    [
      "more entries than a batch holds",
      () =>
        page(
          "p-9",
          Array.from({ length: MAX_ENTRIES }, () => ({})),
          [{}],
        ),
      ["too_many_entries"],
    ],
  ])("refuses %s, and stores nothing", async (_case, bytes, problems) => {
    await got(phone, page("p-1", [resting("v-1", "2026-10-20", 54)]));
    expect(await device.receive(phone, bytes())).toEqual({
      answer: "refused",
      problems,
    });
    expect(rows("SELECT sender_batch_id FROM device_batches")).toEqual([
      { sender_batch_id: "p-1" },
    ]);
  });

  it("refuses a source it doesn't have", async () => {
    expect(await device.receive("no-such-source", page("p-1", []))).toEqual({
      answer: "refused",
      problems: ["no_such_source"],
    });
  });
});

describe("converting a batch", () => {
  it("turns it into values with their link, and the batch done with its counts, in one go", async () => {
    const batch = await got(
      phone,
      page("p-1", [
        resting("v-1", "2026-10-20", 54),
        resting("v-2", "2026-10-21", 56),
        resting("v-3", "2026-10-21", 99, { unit: "count/s" }),
      ]),
    );
    expect(await convertAll()).toEqual([{ done: batch }]);
    expect(
      rows("SELECT * FROM device_values WHERE external_id = 'v-1'"),
    ).toEqual([
      {
        person_id: "asha",
        system: "apple_health",
        external_id: "v-1",
        source_id: phone,
        type: "resting_heart_rate",
        value: 54,
        start_at: "2026-10-19T18:30:00.000Z",
        end_at: "2026-10-20T18:29:59.000Z",
        utc_offset: 330,
        time_zone: "Asia/Kolkata",
        device: "Apple Watch",
        context: null,
        series: null,
        batch_id: batch,
        removed_at: null,
      },
    ]);
    expect(batchRow(batch)).toMatchObject({
      status: "done",
      done_at: T0,
      reason: null,
    });
    expect(JSON.parse(batchRow(batch).counts as string)).toEqual({
      added: 2,
      changed: 0,
      already_had: 0,
      removed: 0,
      unknown_removal: 0,
      skipped: 1,
      older_than_kept: 0,
    });
    expect(JSON.parse(batchRow(batch).skipped as string)).toEqual([
      { id: "v-3", reason: "unit_not_accepted" },
    ]);
  });

  it.each([
    ["an empty batch", () => page("p-1", []), 0],
    [
      "a batch that starts with a UTF-8 byte order mark",
      () =>
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...page("p-1", [resting("v-1", "2026-10-20", 54)]),
        ]),
      1,
    ],
  ])("converts %s to done", async (_case, bytes, values) => {
    const batch = await got(phone, bytes());
    const next = await got(phone, page("p-2", []));
    expect(await convertAll()).toEqual([{ done: batch }, { done: next }]);
    expect(batchRow(batch)).toMatchObject({ status: "done", skipped: null });
    expect(valuesOf()).toHaveLength(values);
  });

  it("writes nothing when the conversion fails part way, and marks the batch failed to try again", async () => {
    store.db
      .exec(`CREATE TRIGGER boom BEFORE INSERT ON device_values WHEN NEW.external_id = 'v-2'
      BEGIN SELECT RAISE(ABORT, 'a test failure'); END`);
    const batch = await got(
      phone,
      page("p-1", [
        resting("v-1", "2026-10-20", 54),
        resting("v-2", "2026-10-21", 56),
      ]),
    );
    expect(await device.convertNext()).toEqual({
      failed: batch,
      reason: "error:1811",
    });
    expect(valuesOf()).toEqual([]);
    expect(batchRow(batch)).toMatchObject({
      status: "failed",
      tries: 1,
      done_at: null,
      counts: null,
      retry_at: "2026-10-22T07:00:30.000Z",
    });
  });

  it("names a full disk as such", async () => {
    const batch = await got(
      phone,
      page(
        "p-1",
        Array.from({ length: 400 }, (_, n) =>
          resting(`v-${String(n)}`, "2026-10-20", 54),
        ),
      ),
    );
    const pages = store.db.prepare("PRAGMA page_count").get() as {
      page_count: number;
    };
    store.db.exec(`PRAGMA max_page_count = ${String(pages.page_count)}`);
    expect(await device.convertNext()).toEqual({
      failed: batch,
      reason: "disk_full",
    });
    expect(valuesOf()).toEqual([]);
  });

  it("leaves the batch as it was when even its failure can't be written", async () => {
    store.db.exec(`
      CREATE TRIGGER boom BEFORE INSERT ON device_values BEGIN SELECT RAISE(ABORT, 'a test failure'); END;
      CREATE TRIGGER stuck BEFORE UPDATE ON device_batches WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'a test failure'); END;`);
    const batch = await got(
      phone,
      page("p-1", [resting("v-1", "2026-10-20", 54)]),
    );
    await expect(device.convertNext()).rejects.toThrow();
    expect(batchRow(batch)).toMatchObject({ status: "waiting", tries: 0 });
    store.db.exec("DROP TRIGGER boom; DROP TRIGGER stuck");
    expect(await convertAll()).toEqual([{ done: batch }]);
  });
});

describe("the same value again, and deletions", () => {
  it("keeps one row per source ID, applies deletions after values, and never brings a removed value back", async () => {
    await got(
      phone,
      page("p-1", [
        resting("v-1", "2026-10-20", 54),
        resting("v-2", "2026-10-21", 56),
      ]),
    );
    const second = await got(
      phone,
      page(
        "p-2",
        [
          resting("v-1", "2026-10-20", 54), // the same: already had
          resting("v-2", "2026-10-21", 57), // other content: changed
          resting("v-3", "2026-10-22", 58), // added, then deleted in the same batch
          resting("v-4", "2026-10-22", 60),
          resting("v-4", "2026-10-22", 61), // twice in one batch: the last wins
        ],
        [{ id: "v-3" }, { id: "v-1" }, { id: "never-had" }],
      ),
    );
    const third = await got(
      watch,
      page(
        "p-3",
        [resting("v-1", "2026-10-20", 54), resting("v-2", "2026-10-21", 59)],
        [{ id: "v-1" }],
      ),
    );
    await convertAll();

    expect(JSON.parse(batchRow(second).counts as string)).toEqual({
      added: 2,
      changed: 2,
      already_had: 1,
      removed: 2,
      unknown_removal: 1,
      skipped: 0,
      older_than_kept: 0,
    });
    expect(JSON.parse(batchRow(third).counts as string)).toMatchObject({
      already_had: 2,
      changed: 1,
      added: 0,
      removed: 0,
    });
    expect(valuesOf()).toEqual([
      {
        external_id: "v-1",
        value: 54,
        start_at: "2026-10-19T18:30:00.000Z",
        removed_at: T0,
        batch_id: second,
        source_id: phone,
      },
      {
        external_id: "v-2",
        value: 59,
        start_at: "2026-10-20T18:30:00.000Z",
        removed_at: null,
        // Changed by the other phone: its link moves, its source stays.
        batch_id: third,
        source_id: phone,
      },
      {
        external_id: "v-3",
        value: 58,
        start_at: "2026-10-21T18:30:00.000Z",
        removed_at: T0,
        batch_id: second,
        source_id: phone,
      },
      {
        external_id: "v-4",
        value: 61,
        start_at: "2026-10-21T18:30:00.000Z",
        removed_at: null,
        batch_id: second,
        source_id: phone,
      },
    ]);
  });

  it("keeps the same source ID apart for two people", async () => {
    await got(phone, page("p-1", [resting("v-1", "2026-10-20", 54)]));
    await got(ravi, page("p-1", [resting("v-1", "2026-10-20", 70)], []));
    await convertAll();
    expect(
      rows("SELECT person_id, value FROM device_values ORDER BY person_id"),
    ).toEqual([
      { person_id: "asha", value: 54 },
      { person_id: "ravi", value: 70 },
    ]);
  });
});

describe("order and failure", () => {
  it("holds back the failed batch's group only, and tries it again after 30 s, 1 min, 2 min, then hourly", async () => {
    store.db
      .exec(`CREATE TRIGGER boom BEFORE INSERT ON device_values WHEN NEW.external_id = 'v-bad'
      BEGIN SELECT RAISE(ABORT, 'a test failure'); END`);
    const stuck = await got(
      phone,
      page("p-1", [resting("v-bad", "2026-10-20", 54)]),
    );
    const behind = await got(watch, page("p-2", [], [{ id: "v-bad" }]));
    const other = await got(
      ravi,
      page("p-3", [resting("v-r", "2026-10-20", 70)]),
    );

    expect(await convertAll()).toEqual([
      { failed: stuck, reason: "error:1811" },
      { done: other },
    ]);
    expect(await device.convertNext()).toEqual({
      idle: true,
      wake: "2026-10-22T07:00:30.000Z",
    });
    expect(batchRow(behind)).toMatchObject({ status: "waiting" });

    const summary = await device.sources();
    expect(summary.find((one) => one.id === phone)).toMatchObject({
      waiting: 1,
      failed: { reason: "error:1811", tries: 1 },
      waitsBehind: null,
    });
    expect(summary.find((one) => one.id === watch)).toMatchObject({
      waiting: 1,
      failed: null,
      waitsBehind: "Asha's iPhone",
    });
    expect(summary.find((one) => one.id === ravi)).toMatchObject({
      waiting: 0,
      values: 1,
      failed: null,
      waitsBehind: null,
    });

    const retries: string[] = [];
    for (const wait of [30_000, 60_000, 120_000, 3_600_000, 3_600_000]) {
      later(wait - 1);
      expect(await device.convertNext()).toMatchObject({ idle: true });
      later(1);
      expect(await device.convertNext()).toEqual({
        failed: stuck,
        reason: "error:1811",
      });
      retries.push(batchRow(stuck).retry_at as string);
    }
    expect(Number(batchRow(stuck).tries)).toBe(6);

    store.db.exec("DROP TRIGGER boom");
    await device.retryFailedNow();
    expect(await convertAll()).toEqual([{ done: stuck }, { done: behind }]);
    expect(valuesOf()).toMatchObject([
      { external_id: "v-bad", removed_at: clock },
      { external_id: "v-r" },
    ]);
  });
});

describe("how long values are kept", () => {
  it("doesn't store what is older than kept, and cleans the rest when the time is shortened", async () => {
    await got(
      phone,
      page("p-1", [
        resting("v-old", "2026-08-01", 50),
        resting("v-gone", "2026-08-02", 51),
        resting("v-new", "2026-10-20", 54),
      ]),
    );
    await got(phone, page("p-gone", [], [{ id: "v-gone" }]));
    await convertAll();
    expect(await device.keep()).toBe("forever");
    // What the clean-up deletes, a removed value too.
    expect(await device.preview("30d")).toEqual({
      values: 2,
      before: "2026-09-22T07:00:00.000Z",
    });

    await device.setKeep("30d");
    expect(await device.cleanUp()).toEqual({ values: 2, batches: 0 });
    expect(valuesOf().map((row) => row.external_id)).toEqual(["v-new"]);

    const again = await got(
      phone,
      page("p-2", [resting("v-old", "2026-08-01", 50)]),
    );
    await convertAll();
    expect(JSON.parse(batchRow(again).counts as string)).toMatchObject({
      older_than_kept: 1,
      added: 0,
    });
    expect(valuesOf().map((row) => row.external_id)).toEqual(["v-new"]);
  });

  it("lets other work run between its chunks", async () => {
    store.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
      INSERT INTO device_values (person_id, system, external_id, source_id, type, value, start_at, end_at)
        SELECT 'asha', 'apple_health', 'old-' || i, '${phone}', 'resting_heart_rate', 54,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM n`);
    await device.setKeep("30d");
    // Turns of the event loop that pass while it runs: none if it never yields.
    const turns = { count: 0, counting: true };
    const counting = (async () => {
      while (turns.counting) {
        await new Promise((resolve) => setImmediate(resolve));
        turns.count++;
      }
    })();
    expect(await device.cleanUp()).toEqual({ values: 12_000, batches: 0 });
    const during = turns.count;
    turns.counting = false;
    await counting;
    expect(during).toBeGreaterThanOrEqual(3);
  });

  it("deletes done batches after 30 days, but keeps those with skipped items, and waiting and failed ones", async () => {
    const plain = await got(
      phone,
      page("p-1", [resting("v-1", "2026-10-20", 54)]),
    );
    const withSkip = await got(
      phone,
      page("p-2", [resting("v-2", "2026-10-20", 54, { unit: "bpm" })]),
    );
    await convertAll();
    later(30 * DAY);
    const newer = await got(
      phone,
      page("p-3", [resting("v-1", "2026-10-20", 55)]),
    );
    store.db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON device_values BEGIN SELECT RAISE(ABORT, 'a test failure'); END`,
    );
    const failed = await got(
      ravi,
      page("p-4", [resting("v-r", "2026-10-20", 70)]),
    );
    await convertAll();
    const waiting = await got(phone, page("p-5", []));

    expect(await device.cleanUp()).toEqual({ values: 0, batches: 0 });
    later(1);
    expect(await device.cleanUp()).toEqual({ values: 0, batches: 1 });
    expect(
      rows("SELECT id FROM device_batches ORDER BY seq").map((row) => row.id),
    ).toEqual([withSkip, newer, failed, waiting]);
    expect(rows("SELECT id FROM device_batches WHERE id = ?", plain)).toEqual(
      [],
    );
    // The value v-1 now links to the newer batch, which stays.
    expect(valuesOf()).toMatchObject([{ external_id: "v-1", batch_id: newer }]);

    later(30 * DAY);
    expect(await device.cleanUp()).toEqual({ values: 0, batches: 1 });
    expect(valuesOf()).toMatchObject([
      { external_id: "v-1", batch_id: null, value: 55 },
    ]);
  });
});

describe("Asha's fictional 60 days", () => {
  it("converts to 60 values in their places: a travel day, the clock change, a day without its place, a rewrite, an odd unit", async () => {
    const file = await readFile(
      join(
        import.meta.dirname,
        "../../../tests/fixtures/device/asha-resting-heart-rate.jsonl",
      ),
      "utf8",
    );
    for (const line of file.trim().split("\n"))
      await got(phone, new TextEncoder().encode(line));
    await convertAll();

    expect(
      (await device.sources()).find((one) => one.id === phone),
    ).toMatchObject({ values: 60, skipped: 1, waiting: 0 });
    const day = (id: string) =>
      rows(
        "SELECT start_at, end_at, utc_offset, time_zone, removed_at FROM device_values WHERE external_id = ?",
        id,
      )[0];
    // 27 Aug in Kolkata.
    expect(day("5A1E0001-0000-4000-8000-000000000001")).toEqual({
      start_at: "2026-08-26T18:30:00.000Z",
      end_at: "2026-08-27T18:29:59.000Z",
      utc_offset: 330,
      time_zone: "Asia/Kolkata",
      removed_at: null,
    });
    // 15 Sep, sent without its place: its local day is unknown.
    expect(day("5A1E0020-0000-4000-8000-000000000020")).toMatchObject({
      utc_offset: null,
      time_zone: null,
    });
    // 25 Oct in London: 25 hours, as the clocks went back.
    expect(day("5A1E0060-0000-4000-8000-000000000060")).toMatchObject({
      start_at: "2026-10-24T23:00:00.000Z",
      end_at: "2026-10-25T23:59:59.000Z",
      time_zone: "Europe/London",
      removed_at: T0,
    });
    expect(day("5A1E0061-0000-4000-8000-000000000061")).toMatchObject({
      start_at: "2026-10-24T23:00:00.000Z",
      removed_at: null,
    });
  });
});

describe("Asha's fictional heart rate", () => {
  it("keeps each reading's motion context, and a walk's three unequal values with their intervals, removed whole", async () => {
    const file = await readFile(
      join(
        import.meta.dirname,
        "../../../tests/fixtures/device/asha-heart-rate.jsonl",
      ),
      "utf8",
    );
    const [first, second] = file.trim().split("\n");
    await got(watch, new TextEncoder().encode(first ?? ""));
    await convertAll();
    expect(
      (await device.sources()).find((one) => one.id === watch),
    ).toMatchObject({ values: 21, skipped: 0 });
    const walk = () =>
      rows(
        "SELECT type, value, start_at, end_at, context, series, removed_at FROM device_values WHERE external_id = ?",
        "4EA70099-0000-4000-8000-000000000099",
      )[0];
    expect(walk()).toEqual({
      type: "heart_rate",
      value: 125,
      start_at: "2026-10-21T06:10:00.000Z",
      end_at: "2026-10-21T06:16:00.000Z",
      context: '{"HKMetadataKeyHeartRateMotionContext":2}',
      series:
        '[{"start_at":"2026-10-21T06:10:00.000Z","end_at":"2026-10-21T06:11:30.000Z","value":118},' +
        '{"start_at":"2026-10-21T06:11:30.000Z","end_at":"2026-10-21T06:14:00.000Z","value":131},' +
        '{"start_at":"2026-10-21T06:14:00.000Z","end_at":"2026-10-21T06:16:00.000Z","value":127}]',
      removed_at: null,
    });

    await got(watch, new TextEncoder().encode(second ?? ""));
    await convertAll();
    expect(walk()).toMatchObject({ removed_at: T0 });
    expect(
      (await device.sources()).find((one) => one.id === watch),
    ).toMatchObject({ values: 20 });
  });
});
