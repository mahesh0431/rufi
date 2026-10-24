// Saving to the record, as the AI does it in Rufi's chat: the real tool
// caller, the real transcripts and a real database file with the fictional
// family. Messages are sent at 10:00 on Sunday 4 Oct 2026 in India.
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { chatCaller, forAgent } from "../tools/tools.ts";

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
const SUNDAY_10AM = "2026-10-04T04:30:00.000Z";

let path: string;
let store: Store;
let reader: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let clock: string;
let said = 0;

beforeEach(async () => {
  path = databasePath(await mkdtemp(join(tmpdir(), "rufi-save-")));
  store = openWritable(path);
  store.db.exec(family);
  reader = openReadOnly(path) as Store;
  clock = SUNDAY_10AM;
  transcripts = openTranscripts(store, () => clock);
  chat = (await transcripts.chat("asha")) as ChatRow;
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
});

/** The user says it in the chat; returns the message's id. */
async function say(text: string, to = chat): Promise<string> {
  const id = `msg-${String(++said)}`;
  await transcripts.addMessage(to, {
    id,
    kind: "message",
    text,
    agentTurnId: "t-1",
  });
  return id;
}

/** The AI calls save_changes in the chat's turn. */
async function save(changes: unknown[], callId = "call-1", to = chat) {
  const answer = await chatCaller(reader, transcripts, () => undefined)(
    to,
    "t-1",
    "person",
  )("save_changes", { changes }, callId);
  return {
    ok: answer.ok,
    body: JSON.parse(answer.text) as Record<string, unknown> & {
      result: {
        receipt: string;
        changes: { kind: string; id: string }[];
        note?: string;
      };
      issues: { path: string; fix: string }[];
    },
  };
}

const row = (table: string, id: string) =>
  store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
const rows = (sql: string) => store.db.prepare(sql).all();
/** A record's current sources, oldest first. */
const sourcesOf = (id: string) =>
  rows(
    `SELECT type, coalesce(entry_id, visit_id, document_id || ' p' || page) AS at FROM record_sources WHERE record_id = '${id}' AND removed_by IS NULL ORDER BY rowid`,
  ).map((source) => {
    const { type, at } = source as { type: string; at: string };
    return type === "message"
      ? { type, entry_id: at }
      : type === "visit"
        ? { type, visit_id: at }
        : { type, page: at };
  });
const receipts = () =>
  rows(
    "SELECT text, turn_id IS NOT NULL AS in_turn FROM transcript_entries WHERE kind = 'receipt' ORDER BY seq",
  ) as { text: string; in_turn: number }[];
/** A receipt as plain lines: without its Markdown marks, list dashes and escapes. */
const lines = (receipt: unknown) =>
  String(receipt)
    .split("\n")
    .map((line) =>
      line
        .replace(/^- /, "")
        .replace(/\\(.)|\*/g, (_, kept?: string) => kept ?? ""),
    )
    .filter((line) => line !== "");
/** Every column of the table unknown: what a record has before any field is given. */
const blank = (table: string) =>
  Object.fromEntries(
    (
      store.db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]
    ).map(({ name }) => [name, null]),
  );

/** Everything a save writes, to check that a refused one wrote nothing. */
const written = () => ({
  operations: rows("SELECT * FROM operations"),
  changes: rows("SELECT * FROM record_changes"),
  receipts: receipts(),
  medicines: rows("SELECT * FROM medicine_uses ORDER BY id"),
  symptoms: rows("SELECT * FROM symptoms"),
  visits: rows("SELECT * FROM visits"),
  sources: rows("SELECT * FROM record_sources ORDER BY rowid"),
  revision: row("chats", chat.id)["revision"],
});

interface KindCase {
  kind: string;
  table: string;
  said: string;
  add: Record<string, unknown>;
  stored: Record<string, unknown>;
  /** The receipt's lines, as plain text. */
  added: string[];
  change?: {
    said: string;
    fields: Record<string, unknown>;
    stored: Record<string, unknown>;
    receipt: string[];
  };
  removed: string[];
}

const KIND_CASES: KindCase[] = [
  {
    kind: "medicine_use",
    table: "medicine_uses",
    said: "I started magnesium 200 mg at night last Monday",
    add: {
      name: "Magnesium",
      strength: "200 mg",
      schedule: "at night",
      status: "current",
      started: { date: "2026-09-28", words: "last Monday" },
    },
    stored: {
      name: "Magnesium",
      strength: "200 mg",
      schedule: "at night",
      status: "current",
      started: "2026-09-28",
      started_words: "last Monday",
    },
    added: [
      "Saved",
      'Added medicine use Magnesium 200 mg: schedule at night, current, start 28 Sep 2026 ("last Monday")',
    ],
    change: {
      said: "Sorry, the magnesium is 400 mg",
      fields: { strength: "400 mg" },
      stored: { strength: "400 mg" },
      receipt: [
        "Saved",
        "Changed medicine use Magnesium 400 mg: strength 200 mg → 400 mg",
      ],
    },
    removed: ["Saved", "Removed medicine use Magnesium 400 mg"],
  },
  {
    kind: "visit",
    table: "visits",
    said: "I saw Dr Rao online yesterday about the cough; she said it's viral, rest and fluids",
    add: {
      setting: "online",
      date: { date: "2026-10-03", words: "yesterday" },
      doctor: "Dr Rao",
      reason: "Cough",
      as_written: "Viral cough. Rest and fluids.",
    },
    stored: {
      setting: "online",
      date: "2026-10-03",
      date_words: "yesterday",
      doctor: "Dr Rao",
      reason: "Cough",
      as_written: "Viral cough. Rest and fluids.",
    },
    added: [
      "Saved",
      'Added visit Dr Rao: setting online, date 3 Oct 2026 ("yesterday"), reason Cough, as written Viral cough. Rest and fluids.',
    ],
    change: {
      said: "It was at the Lakeview clinic, not online",
      fields: { setting: "clinic", place: "Lakeview Family Clinic" },
      stored: { setting: "clinic", place: "Lakeview Family Clinic" },
      receipt: [
        "Saved",
        "Changed visit Dr Rao · Lakeview Family Clinic: setting online → clinic; place not given → Lakeview Family Clinic",
      ],
    },
    removed: ["Saved", "Removed visit Dr Rao · Lakeview Family Clinic"],
  },
  {
    kind: "symptom",
    table: "symptoms",
    said: "I've had a headache since yesterday, it comes and goes",
    add: {
      name: "Headache",
      status: "ongoing",
      onset: { date: "2026-10-03", words: "since yesterday" },
      intermittent: true,
    },
    stored: {
      name: "Headache",
      status: "ongoing",
      onset: "2026-10-03",
      onset_words: "since yesterday",
      intermittent: 1,
    },
    added: [
      "Saved",
      'Added symptom Headache: ongoing, onset 3 Oct 2026 ("since yesterday"), comes and goes yes',
    ],
    change: {
      said: "The headache is gone now",
      fields: { status: "resolved" },
      stored: { status: "resolved" },
      receipt: ["Saved", "Changed symptom Headache: status ongoing → resolved"],
    },
    removed: ["Saved", "Removed symptom Headache"],
  },
  {
    kind: "condition",
    table: "conditions",
    said: "I was diagnosed with hypothyroidism in 2019",
    add: {
      name: "Hypothyroidism",
      certainty: "diagnosed",
      recognised: { date: "2019", words: "in 2019" },
    },
    stored: {
      name: "Hypothyroidism",
      certainty: "diagnosed",
      status: "unknown",
      recognised: "2019",
      recognised_words: "in 2019",
    },
    added: [
      "Saved",
      'Added condition Hypothyroidism: certainty diagnosed, recognised 2019 ("in 2019")',
    ],
    change: {
      said: "The hypothyroidism is still ongoing",
      fields: { status: "ongoing" },
      stored: { status: "ongoing" },
      receipt: [
        "Saved",
        "Changed condition Hypothyroidism: status unknown → ongoing",
      ],
    },
    removed: ["Saved", "Removed condition Hypothyroidism"],
  },
  {
    kind: "allergy",
    table: "allergies",
    said: "I'm allergic to sulfa drugs, I got hives in 2015",
    add: {
      substance: "Sulfa drugs",
      reaction: "hives",
      status: "active",
      certainty: "confirmed",
      reacted: { date: "2015", words: "in 2015" },
    },
    stored: {
      substance: "Sulfa drugs",
      reaction: "hives",
      status: "active",
      certainty: "confirmed",
      asserted: "2026-10-04",
      reacted: "2015",
      reacted_words: "in 2015",
    },
    added: [
      "Saved",
      'Added allergy Sulfa drugs: reaction hives, active, certainty confirmed, reaction date 2015 ("in 2015")',
    ],
    change: {
      // An ended reaction is not an inactive allergy: the status stays.
      said: "The hives were in 2016 actually, and they ended long ago",
      fields: { reacted: { date: "2016", words: "in 2016" } },
      stored: { reacted: "2016", reacted_words: "in 2016", status: "active" },
      receipt: [
        "Saved",
        'Changed allergy Sulfa drugs: reaction date 2015 ("in 2015") → 2016 ("in 2016")',
      ],
    },
    removed: ["Saved", "Removed allergy Sulfa drugs"],
  },
  {
    kind: "result",
    table: "results",
    said: "My blood pressure this morning was 128/84",
    add: {
      test: "Blood pressure",
      value: "128/84",
      category: "measurement",
      number: 128,
      second_number: 84,
      unit: "mmHg",
      measured: { date: "2026-10-04", words: "this morning" },
    },
    stored: {
      test_name: "Blood pressure",
      value_text: "128/84",
      category: "measurement",
      value_number: 128,
      second_number: 84,
      unit: "mmHg",
      measured_at: "2026-10-04",
      measured_words: "this morning",
      entered_at: SUNDAY_10AM,
    },
    added: [
      "Saved",
      'Added result Blood pressure 128/84 mmHg: category measurement, measured 4 Oct 2026 ("this morning")',
    ],
    change: {
      said: "Sorry, the blood pressure was 126/84",
      fields: { value: "126/84", number: 126 },
      stored: { value_text: "126/84", value_number: 126 },
      receipt: [
        "Saved",
        "Changed result Blood pressure 126/84 mmHg: value 128/84 → 126/84; number 128 → 126",
      ],
    },
    removed: ["Saved", "Removed result Blood pressure 126/84 mmHg"],
  },
  {
    kind: "care_event",
    table: "care_events",
    said: "I have a tooth extraction planned on 20 Oct",
    add: {
      type: "procedure",
      name: "Tooth extraction",
      status: "planned",
      date: { date: "2026-10-20", words: "on 20 Oct" },
    },
    stored: {
      type: "procedure",
      name: "Tooth extraction",
      status: "planned",
      date: "2026-10-20",
      date_words: "on 20 Oct",
    },
    added: [
      "Saved",
      'Added care event Tooth extraction: type procedure, planned, date 20 Oct 2026 ("on 20 Oct")',
    ],
    change: {
      said: "The extraction moved to 22 Oct",
      fields: { date: { date: "2026-10-22", words: "22 Oct" } },
      stored: { date: "2026-10-22", date_words: "22 Oct" },
      receipt: [
        "Saved",
        'Changed care event Tooth extraction: date 20 Oct 2026 ("on 20 Oct") → 22 Oct 2026 ("22 Oct")',
      ],
    },
    removed: ["Saved", "Removed care event Tooth extraction"],
  },
  {
    kind: "none_known",
    table: "none_known",
    said: "I have no allergies",
    add: { category: "allergies" },
    stored: { category: "allergies", asserted: "2026-10-04" },
    added: ["Saved", "Added no known allergies (as of 4 Oct 2026)"],
    removed: ["Saved", "Removed no known allergies (as of 4 Oct 2026)"],
  },
  {
    kind: "follow_up",
    table: "follow_ups",
    said: "Remind me to recheck HbA1c at the next visit",
    add: {
      title: "Recheck HbA1c",
      due: "next_visit",
      about: { kind: "result", id: "res-a1" },
    },
    stored: {
      title: "Recheck HbA1c",
      due: "next_visit",
      status: "open",
      linked_kind: "result",
      linked_id: "res-a1",
    },
    added: [
      "Saved",
      "Added follow-up Recheck HbA1c: due at the next visit, open, about result HbA1c 6.8 %",
    ],
    change: {
      said: "Done, the HbA1c recheck was 6.5%",
      fields: { status: "done", outcome: "HbA1c 6.5%" },
      stored: { status: "done", outcome: "HbA1c 6.5%" },
      receipt: [
        "Saved",
        "Changed follow-up Recheck HbA1c: status open → done; outcome not given → HbA1c 6.5%",
      ],
    },
    removed: ["Saved", "Removed follow-up Recheck HbA1c"],
  },
];

describe("saving each kind of record", () => {
  it.each(KIND_CASES)(
    "$kind: adds, changes and removes with only the given fields, each with its receipt and history",
    async (c) => {
      const source = await say(c.said);
      const added = await save([
        { kind: c.kind, action: "add", fields: c.add },
      ]);
      expect(added.body).toMatchObject({ ok: true });
      expect(lines(added.body.result.receipt)).toEqual(c.added);
      const id = added.body.result.changes[0]?.id ?? "";
      const first = row(c.table, id);
      expect(first).toEqual({
        ...blank(c.table),
        id,
        person_id: "asha",
        removed: 0,
        ...(c.table === "symptoms" ||
        c.table === "medicine_uses" ||
        c.table === "care_events"
          ? { status: "unknown" }
          : {}),
        ...(c.table === "visits" ? { setting: "unknown" } : {}),
        ...(c.table === "allergies" || c.table === "conditions"
          ? { status: "unknown", certainty: "unknown" }
          : {}),
        ...c.stored,
      });

      let current = first;
      let calls = 1;
      const expected = [c.added];
      if (c.change) {
        const again = await say(c.change.said);
        const changed = await save(
          [
            {
              kind: c.kind,
              action: "change",
              id,
              fields: c.change.fields,
            },
          ],
          `call-${String(++calls)}`,
        );
        expect(lines(changed.body.result.receipt)).toEqual(c.change.receipt);
        expected.push(c.change.receipt);
        // The rest stays as it was; the new message joins its sources.
        current = { ...first, ...c.change.stored };
        expect(row(c.table, id)).toEqual(current);
        expect(sourcesOf(id)).toEqual([
          { type: "message", entry_id: source },
          { type: "message", entry_id: again },
        ]);
      } else {
        expect(sourcesOf(id)).toEqual([{ type: "message", entry_id: source }]);
      }

      const gone = await save(
        [{ kind: c.kind, action: "remove", id }],
        `call-${String(calls + 1)}`,
      );
      expect(lines(gone.body.result.receipt)).toEqual(c.removed);
      expected.push(c.removed);
      const removed = { ...current, removed: 1 };
      expect(row(c.table, id)).toEqual(removed);

      expect(
        receipts().map(({ text, in_turn }) => [lines(text), in_turn]),
      ).toEqual(expected.map((text) => [text, 1]));
      const history = (
        rows(
          `SELECT action, before, after FROM record_changes WHERE record_id = '${id}' ORDER BY rowid`,
        ) as { action: string; before: string | null; after: string }[]
      ).map((h) => ({
        action: h.action,
        before: h.before && (JSON.parse(h.before) as unknown),
        after: JSON.parse(h.after) as unknown,
      }));
      expect(history).toEqual([
        { action: "add", before: null, after: first },
        ...(c.change
          ? [{ action: "change", before: first, after: current }]
          : []),
        { action: "remove", before: current, after: removed },
      ]);
    },
  );
});

describe("a save", () => {
  it("changes two records in one save with one receipt, and its reverse puts them back", async () => {
    const said = "I stopped creatine because of a stomach upset";
    const first = await say(said);
    const before = row("medicine_uses", "med-a2");
    const saved = await save([
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a2",
        fields: { status: "stopped" },
      },
      {
        kind: "symptom",
        action: "add",
        fields: { name: "Stomach upset" },
      },
    ]);
    expect(lines(saved.body.result.receipt)).toEqual([
      "Saved",
      "Changed medicine use Creatine 5 g: status current → stopped",
      "Added symptom Stomach upset",
    ]);
    const symptom = saved.body.result.changes[1]?.id ?? "";
    expect(rows("SELECT * FROM operations")).toHaveLength(1);

    // "Undo that", after the user said yes.
    const yes = await say("Yes, undo that");
    const undone = await save(
      [
        {
          kind: "medicine_use",
          action: "change",
          id: "med-a2",
          fields: { status: "current" },
        },
        { kind: "symptom", action: "remove", id: symptom },
      ],
      "call-2",
    );
    expect(lines(undone.body.result.receipt)).toEqual([
      "Saved",
      "Changed medicine use Creatine 5 g: status stopped → current",
      "Removed symptom Stomach upset",
    ]);
    expect(row("medicine_uses", "med-a2")).toEqual(before);
    expect(sourcesOf("med-a2")).toEqual([
      { type: "message", entry_id: first },
      { type: "message", entry_id: yes },
    ]);
    expect(row("symptoms", symptom)["removed"]).toBe(1);
    expect(receipts()).toHaveLength(2);
  });

  it("says a removed record was put back", async () => {
    await say("Remove my creatine");
    await save([{ kind: "medicine_use", action: "remove", id: "med-a2" }]);
    await say("Put it back");
    const back = await save(
      [{ kind: "medicine_use", action: "restore", id: "med-a2" }],
      "call-2",
    );
    expect(lines(back.body.result.receipt)).toEqual([
      "Saved",
      "Put back medicine use Creatine 5 g",
    ]);
    expect(row("medicine_uses", "med-a2")["removed"]).toBe(0);
  });

  it("shows every changed field and link on the receipt, compared on what was stored", async () => {
    const prefix =
      "Headache after meals, mild pain, lasts about an hour, no nausea, no vision changes;";
    const said = "I get headaches and toothaches, and a sore back";
    await say(said);
    const added = await save([
      {
        kind: "symptom",
        action: "add",
        fields: {
          name: "Headache",
          details: `${prefix} frequency once a week`,
        },
      },
      {
        kind: "symptom",
        action: "add",
        fields: { name: "Toothache" },
      },
      {
        kind: "symptom",
        action: "add",
        fields: { name: "Back pain" },
      },
      {
        kind: "symptom",
        action: "add",
        fields: { name: "Back pain" },
      },
    ]);
    const [headache, toothache, back, otherBack] =
      added.body.result.changes.map((c) => c.id);
    await say("Ask the doctor about my pain");
    const followUp = await save(
      [
        {
          kind: "follow_up",
          action: "add",
          fields: {
            title: "Discuss pain",
            about: { kind: "symptom", id: headache },
          },
        },
      ],
      "call-2",
    );
    const id = followUp.body.result.changes[0]?.id ?? "";
    await say(
      "The headaches come every day now, and the follow-up is about my teeth",
    );
    const changed = await save(
      [
        {
          kind: "symptom",
          action: "change",
          id: headache,
          fields: { details: `${prefix} frequency every day` },
        },
        {
          kind: "follow_up",
          action: "change",
          id,
          fields: { about: { kind: "symptom", id: toothache } },
        },
      ],
      "call-3",
    );
    expect(lines(changed.body.result.receipt)).toEqual([
      "Saved",
      "Changed symptom Headache: details …no vision changes; frequency once a week → …no vision changes; frequency every day",
      "Changed follow-up Discuss pain: about symptom Headache → symptom Toothache",
    ]);
    // Two records with the same name are told apart by their ids.
    await say("No, the follow-up is about my back");
    const backs = await save(
      [
        {
          kind: "follow_up",
          action: "change",
          id,
          fields: { about: { kind: "symptom", id: back } },
        },
      ],
      "call-4",
    );
    await save(
      [
        {
          kind: "follow_up",
          action: "change",
          id,
          fields: { about: { kind: "symptom", id: otherBack } },
        },
      ],
      "call-5",
    );
    expect(backs.ok).toBe(true);
    const last = receipts().at(-1);
    expect(last?.in_turn).toBe(1);
    expect(lines(last?.text)).toEqual([
      "Saved",
      `Changed follow-up Discuss pain: about symptom Back pain (${back ?? ""}) → symptom Back pain (${otherBack ?? ""})`,
    ]);

    // A change inside one long word, such as a link, still shows.
    const report = (version: number) =>
      `Report: https://fictional.example/visit-results/2f1468a43bd09659ce218e5c0a904289704c725dc09d63a5b5eeccf3ae761296?version=${String(version)} reviewed at next visit`;
    await say("The report link is now version 2");
    await save(
      [
        {
          kind: "symptom",
          action: "change",
          id: back,
          fields: { details: report(1) },
        },
      ],
      "call-6",
    );
    const url = await save(
      [
        {
          kind: "symptom",
          action: "change",
          id: back,
          fields: { details: report(2) },
        },
      ],
      "call-7",
    );
    expect(lines(url.body.result.receipt)).toEqual([
      "Saved",
      "Changed symptom Back pain: details …d63a5b5eeccf3ae761296?version=1 reviewed at next visit → …d63a5b5eeccf3ae761296?version=2 reviewed at next visit",
    ]);
  });

  it("writes the receipt as Markdown in which the saved words stay as written", async () => {
    const said =
      "I take **Fish oil** [daily](https://fictional.example) <b>with food</b>\nsince 2019";
    await say(said);
    const saved = await save([
      {
        kind: "medicine_use",
        action: "add",
        fields: {
          name: "**Fish oil**",
          schedule: "[daily](https://fictional.example) <b>with food</b>\nnow",
        },
      },
    ]);
    expect(saved.body.result.receipt).toBe(
      "**Saved**\n\n- Added medicine use **\\*\\*Fish oil\\*\\***: schedule *\\[daily\\](https://fictional.example) \\<b\\>with food\\</b\\> now*",
    );
  });

  it("saves nothing when one change is wrong, and says exactly what", async () => {
    await say("I started magnesium and stopped creatine on 30 Feb");
    const before = written();
    const refused = await save([
      {
        kind: "medicine_use",
        action: "add",
        fields: { name: "Magnesium" },
      },
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a2",
        fields: {
          status: "stopped",
          ended: { date: "2026-02-30", words: "on 30 Feb" },
        },
      },
    ]);
    expect(refused.ok).toBe(false);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.1.fields.ended.date",
        got: '"2026-02-30"',
        fix: "2026-02-30 isn't a real date.",
      },
    ]);
    expect(written()).toEqual(before);
  });

  it.each([
    {
      name: "a kind Rufi doesn't keep",
      change: { kind: "diet", action: "add", fields: {} },
      path: "changes.0",
    },
    {
      name: "a field the kind doesn't have",
      change: {
        kind: "symptom",
        action: "add",
        fields: { name: "Headache", colour: "red" },
      },
      path: "changes.0.fields.colour",
    },
    {
      name: "an add without its required field",
      change: {
        kind: "symptom",
        action: "add",
        fields: {},
      },
      path: "changes.0.fields.name",
    },
    {
      name: "a change without an id",
      change: {
        kind: "symptom",
        action: "change",
        fields: { status: "resolved" },
      },
      path: "changes.0.id",
    },
    {
      name: "a status left unknown with null",
      change: {
        kind: "medicine_use",
        action: "change",
        id: "med-a1",
        fields: { status: null },
      },
      path: "changes.0.fields.status",
    },
    {
      name: "a status the kind doesn't have",
      change: {
        kind: "medicine_use",
        action: "change",
        id: "med-a1",
        fields: { status: "finished" },
      },
      path: "changes.0.fields.status",
    },
  ])("refuses $name, naming the problem", async ({ change, path }) => {
    await say("I have a headache");
    const before = written();
    const refused = await save([change]);
    expect(refused.ok).toBe(false);
    expect(refused.body.issues.map((issue) => issue.path)).toContain(path);
    expect(written()).toEqual(before);
  });

  it("is saved once when the same call comes again, and a reused call id with other changes is refused", async () => {
    await say("I have a headache");
    const change = {
      kind: "symptom",
      action: "add",
      fields: { name: "Headache" },
    };
    const first = await save([change], "call-7");
    const again = await save([change], "call-7");
    expect(again.body.result).toEqual({
      ...first.body.result,
      note: "This call was already saved.",
    });
    expect(rows("SELECT * FROM symptoms")).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
    const other = await save(
      [{ ...change, fields: { name: "Migraine" } }],
      "call-7",
    );
    expect(other.body["error"]).toBe(
      "This call was already used for another save, so nothing was saved. Make a new call.",
    );
    expect(rows("SELECT * FROM symptoms")).toHaveLength(1);
  });

  it("refuses another person's record, and nothing is saved", async () => {
    await say("Stop my atorvastatin, and I have a toothache");
    const before = written();
    const refused = await save([
      {
        kind: "medicine_use",
        action: "change",
        id: "med-r1",
        fields: { status: "stopped" },
      },
      { kind: "symptom", action: "add", fields: { name: "Toothache" } },
    ]);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.0.id",
        got: '"med-r1"',
        fix: "No medicine use with this id is in this person's record.",
      },
    ]);
    expect(row("medicine_uses", "med-r1")["status"]).toBe("current");
    expect(written()).toEqual(before);
  });

  it("can't be made outside Rufi's chat", async () => {
    const answer = await forAgent(
      () => ({ store: reader, personId: "asha", callId: "call-1" }),
      () => undefined,
    ).forTurn()(
      "save_changes",
      {
        changes: [
          {
            kind: "symptom",
            action: "add",
            fields: { name: "X" },
          },
        ],
      },
      "call-1",
    );
    expect(JSON.parse(answer.text)).toMatchObject({
      ok: false,
      error: "Changes can be saved only in Rufi's own chat.",
    });
  });
});

describe("the health rules", () => {
  it("stops only the use it names when two uses of one medicine coexist", async () => {
    await say("I also take metformin 500 mg at night");
    const night = await save([
      {
        kind: "medicine_use",
        action: "add",
        fields: {
          name: "Metformin",
          strength: "500 mg",
          schedule: "at night",
          status: "current",
        },
      },
    ]);
    const id = night.body.result.changes[0]?.id ?? "";
    await say("I stopped the night metformin");
    await save(
      [
        {
          kind: "medicine_use",
          action: "change",
          id,
          fields: { status: "stopped" },
        },
      ],
      "call-2",
    );
    expect(row("medicine_uses", id)["status"]).toBe("stopped");
    expect(row("medicine_uses", "med-a1")["status"]).toBe("current");
  });

  it("never keeps 'no known allergies' current beside an allergy that isn't inactive", async () => {
    await say("I have no allergies");
    const statement = await save([
      {
        kind: "none_known",
        action: "add",
        fields: { category: "allergies" },
      },
    ]);
    const statementId = statement.body.result.changes[0]?.id ?? "";
    await say("I'm allergic to penicillin");
    const allergy = {
      kind: "allergy",
      action: "add",
      fields: { substance: "Penicillin" },
    };
    const refused = await save([allergy], "call-2");
    expect(refused.body.issues[0]?.fix).toBe(
      "'No known allergies' can't be current beside an allergy that isn't inactive. In the same save, remove the statement, or remove the allergy or make it inactive, as the user said.",
    );
    expect(rows("SELECT * FROM allergies WHERE person_id = 'asha'")).toEqual(
      [],
    );

    // Removing the statement in the same save is the way.
    const both = await save(
      [
        allergy,
        {
          kind: "none_known",
          action: "remove",
          id: statementId,
        },
      ],
      "call-3",
    );
    expect(lines(both.body.result.receipt)).toEqual([
      "Saved",
      "Added allergy Penicillin",
      "Removed no known allergies (as of 4 Oct 2026)",
    ]);
    // A save of another kind isn't held up by them.
    store.db.exec(
      "INSERT INTO none_known (id, person_id, category) VALUES ('nk-old', 'asha', 'allergies')",
    );
    await say("I have a headache");
    const other = await save(
      [
        {
          kind: "symptom",
          action: "add",
          fields: { name: "Headache" },
        },
      ],
      "call-5",
    );
    expect(other.ok).toBe(true);
    store.db.exec("DELETE FROM none_known WHERE id = 'nk-old'");

    // And the statement can't come back beside it.
    const back = await save(
      [
        {
          kind: "none_known",
          action: "restore",
          id: statementId,
        },
      ],
      "call-4",
    );
    expect(back.ok).toBe(false);
    expect(row("none_known", statementId)["removed"]).toBe(1);
  });

  it("changes a result read from a document only by amendment", async () => {
    await say("The lab corrected my HbA1c to 6.6");
    const refused = await save([
      {
        kind: "result",
        action: "change",
        id: "res-a1",
        fields: { value: "6.6" },
      },
    ]);
    expect(refused.body.issues.map((issue) => issue.fix)).toEqual([
      "This result was read from a document, so what it prints and its date change only by amendment: add a new result with replaces set to this id. Only its category changes in place, in a change of its own.",
    ]);
    const amended = await save(
      [
        {
          kind: "result",
          action: "add",
          fields: {
            test: "HbA1c",
            value: "6.6",
            unit: "%",
            replaces: "res-a1",
          },
        },
      ],
      "call-2",
    );
    expect(amended.ok).toBe(true);
    expect(row("results", "res-a1")["value_text"]).toBe("6.8");
    const overview = JSON.parse(
      (
        await forAgent(
          () => ({ store: reader, personId: "asha" }),
          () => undefined,
        ).forTurn()("get_overview", {})
      ).text,
    ) as {
      result: {
        latest_results: { test: string; value: string; amended?: boolean }[];
      };
    };
    expect(
      overview.result.latest_results.filter((r) => r.test === "HbA1c"),
    ).toMatchObject([{ value: "6.6", amended: true }]);

    // Undoing the amendment brings back the result it replaced, which can
    // then be amended again; the undone amendment can't come back beside it.
    const amendment = amended.body.result.changes[0]?.id ?? "";
    await say("Undo that, the lab was wrong, it is 6.5");
    const undone = await save(
      [
        {
          kind: "result",
          action: "remove",
          id: amendment,
        },
      ],
      "call-3",
    );
    expect(undone.ok).toBe(true);
    const hba1c = async () =>
      (
        JSON.parse(
          (
            await forAgent(
              () => ({ store: reader, personId: "asha" }),
              () => undefined,
            ).forTurn()("get_overview", {})
          ).text,
        ) as {
          result: {
            latest_results: {
              id: string;
              test: string;
              value: string;
              amended?: boolean;
            }[];
          };
        }
      ).result.latest_results.filter((r) => r.test === "HbA1c");
    expect(await hba1c()).toEqual([
      expect.objectContaining({ id: "res-a1", value: "6.8" }),
    ]);
    expect((await hba1c())[0]?.amended).toBeUndefined();
    const again = await save(
      [
        {
          kind: "result",
          action: "add",
          fields: {
            test: "HbA1c",
            value: "6.5",
            unit: "%",
            replaces: "res-a1",
          },
        },
      ],
      "call-4",
    );
    expect(again.ok).toBe(true);
    expect(await hba1c()).toMatchObject([{ value: "6.5", amended: true }]);
    const back = await save(
      [
        {
          kind: "result",
          action: "restore",
          id: amendment,
        },
      ],
      "call-5",
    );
    expect(back.body.issues[0]?.fix).toBe(
      "This save would leave more than one current amendment of this result. Ask the user which value is right, then save only that amendment; remove any other current amendment in the same save.",
    );
  });

  it("needs a result's category on an add; an amended result keeps the one it replaces unless the save gives one", async () => {
    await say(
      "My clinic HbA1c was 6.9 on 3 Oct, the lab amended my HbA1c to 6.6, and that weight was 61 kg",
    );
    const none = await save([
      {
        kind: "result",
        action: "add",
        fields: { test: "HbA1c", value: "6.9" },
      },
    ]);
    expect(none.ok).toBe(false);
    expect(JSON.stringify(none.body.issues)).toContain(
      "Give category when adding a result.",
    );
    const saved = await save(
      [
        {
          kind: "result",
          action: "add",
          fields: { test: "HbA1c", value: "6.6", replaces: "res-a1" },
        },
        {
          kind: "result",
          action: "add",
          fields: { test: "Weight", value: "61", replaces: "res-a10" },
        },
        {
          kind: "result",
          action: "add",
          fields: {
            test: "Glucose",
            value: "6.9",
            replaces: "res-a2",
            category: "measurement",
          },
        },
      ],
      "call-2",
    );
    expect(saved.ok).toBe(true);
    expect(
      saved.body.result.changes.map((c) => row("results", c.id)["category"]),
    ).toEqual(["lab", "measurement", "measurement"]);
  });

  it("moves a result read from a document to the other category in place, and back; a move with a printed value is refused whole", async () => {
    const sources = sourcesOf("res-a1");
    const printed = { ...row("results", "res-a1") };
    await say("That HbA1c is a measurement, not a lab result");
    const moved = await save([
      {
        kind: "result",
        action: "change",
        id: "res-a1",
        fields: { category: "measurement" },
      },
    ]);
    expect(moved.ok).toBe(true);
    expect(lines(moved.body.result.receipt)).toEqual([
      "Saved",
      "Changed result HbA1c 6.8 %: category lab → measurement",
    ]);
    expect(row("results", "res-a1")).toEqual({
      ...printed,
      category: "measurement",
    });

    await say("Move it back and make it 6.6");
    const before = { ...written(), results: rows("SELECT * FROM results") };
    const mixed = await save(
      [
        {
          kind: "result",
          action: "change",
          id: "res-a1",
          fields: { category: "lab", value: "6.6" },
        },
      ],
      "call-2",
    );
    expect(mixed.ok).toBe(false);
    expect({ ...written(), results: rows("SELECT * FROM results") }).toEqual(
      before,
    );

    const undo = await say("Undo that");
    const back = await save(
      [
        {
          kind: "result",
          action: "change",
          id: "res-a1",
          fields: { category: "lab" },
        },
      ],
      "call-3",
    );
    expect(back.ok).toBe(true);
    expect(row("results", "res-a1")).toEqual(printed);
    // Each move rests on the user's words; the report's page stays a source.
    expect(sourcesOf("res-a1").slice(0, sources.length)).toEqual(sources);
    expect(
      rows(
        "SELECT action FROM record_changes WHERE record_id = 'res-a1' ORDER BY rowid",
      ),
    ).toEqual([{ action: "change" }, { action: "change" }]);
  });

  describe("one current amendment of a result", () => {
    const source = "The lab amended my HbA1c";
    const add = (value: string) => ({
      kind: "result",
      action: "add",
      fields: { test: "HbA1c", value, unit: "%", replaces: "res-a1" },
    });
    const change = (action: string, id: string) => ({
      kind: "result",
      action,
      id,
    });
    let first: string;
    let second: string;
    beforeEach(async () => {
      await say(source);
      const a = await save([add("6.6")], "first");
      expect(a.ok).toBe(true);
      first = a.body.result.changes[0]?.id ?? "";
      expect((await save([change("remove", first)], "remove-first")).ok).toBe(
        true,
      );
      const b = await save([add("6.5")], "second");
      expect(b.ok).toBe(true);
      second = b.body.result.changes[0]?.id ?? "";
      expect((await save([change("remove", second)], "remove-second")).ok).toBe(
        true,
      );
    });
    const resultRows = () => rows("SELECT * FROM results ORDER BY id");

    it.each(["add/add", "restore/add", "add/restore", "restore/restore"])(
      "refuses %s together, with a specific reason and nothing saved",
      async (actions) => {
        const before = { ...written(), results: resultRows() };
        const changes = actions
          .split("/")
          .map((action, i) =>
            action === "add"
              ? add(i === 0 ? "6.4" : "6.3")
              : change("restore", i === 0 ? first : second),
          );
        const answer = await save(changes, "conflicting");
        expect(answer.ok).toBe(false);
        expect(answer.body.issues).toEqual([
          {
            path: "changes",
            got: "res-a1",
            fix: "This save would leave more than one current amendment of this result. Ask the user which value is right, then save only that amendment; remove any other current amendment in the same save.",
          },
        ]);
        expect({ ...written(), results: resultRows() }).toEqual(before);
      },
    );

    it.each(["remove/add", "add/remove", "remove/restore", "restore/remove"])(
      "allows %s together, with one current amendment and one receipt",
      async (actions) => {
        expect((await save([change("restore", first)], "current")).ok).toBe(
          true,
        );
        const before = receipts().length;
        const answer = await save(
          actions
            .split("/")
            .map((action) =>
              action === "add"
                ? add("6.4")
                : change(action, action === "remove" ? first : second),
            ),
          "replace-current",
        );
        expect(answer.ok).toBe(true);
        const current = rows(
          "SELECT value_text FROM results WHERE replaces_id = 'res-a1' AND removed = 0",
        );
        expect(current).toEqual([
          { value_text: actions.includes("add") ? "6.4" : "6.5" },
        ]);
        expect(row("results", "res-a1")["value_text"]).toBe("6.8");
        expect(row("results", first)["removed"]).toBe(1);
        expect(receipts()).toHaveLength(before + 1);
        expect(answer.body.result.changes).toHaveLength(2);
      },
    );
  });
});

describe("dates", () => {
  it("keeps a date at the precision and in the words the user said it", async () => {
    await say("I've had asthma since 2019");
    const saved = await save([
      {
        kind: "condition",
        action: "add",
        fields: {
          name: "Asthma",
          recognised: { date: "2019", words: "since 2019" },
        },
      },
    ]);
    const stored = row("conditions", saved.body.result.changes[0]?.id ?? "");
    expect([stored["recognised"], stored["recognised_words"]]).toEqual([
      "2019",
      "since 2019",
    ]);
  });

  it("keeps a date's words as given, in any language, also when the message doesn't have them", async () => {
    await say("हाँ, सेव करो");
    const saved = await save([
      {
        kind: "follow_up",
        action: "add",
        fields: {
          title: "Recheck haemoglobin",
          due: { date: "2026-12", words: "दिसंबर" },
        },
      },
      {
        kind: "medicine_use",
        action: "add",
        fields: {
          name: "Magnesium",
          started: { date: "2026-09-28", words: "last Monday" },
        },
      },
    ]);
    expect(saved.ok).toBe(true);
    const [due, started] = saved.body.result.changes.map((c) => c.id);
    expect([
      row("follow_ups", due ?? "")["due_words"],
      row("medicine_uses", started ?? "")["started_words"],
    ]).toEqual(["दिसंबर", "last Monday"]);
  });
});

describe("where a change comes from", () => {
  const seqOf = (id: string) =>
    (
      store.db
        .prepare("SELECT seq FROM transcript_entries WHERE id = ?")
        .get(id) as { seq: number }
    ).seq;
  const headache = (source?: number) => ({
    kind: "symptom",
    action: "add",
    ...(source !== undefined && { source }),
    fields: { name: "Headache" },
  });

  it("is the user's newest message or steer in this turn when no position is given, never an earlier turn's", async () => {
    await transcripts.addMessage(chat, {
      id: "before",
      kind: "message",
      text: "I have a headache",
    });
    await say("Can you add it?");
    await transcripts.addMessage(chat, {
      id: "steer",
      kind: "steer",
      text: "ok, do it",
      agentTurnId: "t-1",
    });
    const saved = await save([headache()]);
    expect(sourcesOf(saved.body.result.changes[0]?.id ?? "")).toEqual([
      { type: "message", entry_id: "steer" },
    ]);
    expect(rows("SELECT source_entry_id FROM record_changes")).toEqual([
      { source_entry_id: "steer" },
    ]);
  });

  it("is an earlier message of the user's, by its position in this chat", async () => {
    const earlier = await say("I have a headache since this morning");
    await transcripts.appendReply(chat, "t-1", "r-1", "Shall I add it?");
    await say("Yes");
    const saved = await save([headache(seqOf(earlier))]);
    expect(sourcesOf(saved.body.result.changes[0]?.id ?? "")).toEqual([
      { type: "message", entry_id: earlier },
    ]);
  });

  it("refuses a position that isn't one of the user's messages in this chat, and saves nothing", async () => {
    await say("I have a headache");
    await transcripts.appendReply(chat, "t-1", "r-1", "Shall I add it?");
    const reply = seqOf(
      (
        store.db
          .prepare("SELECT id FROM transcript_entries WHERE kind = 'reply'")
          .get() as { id: string }
      ).id,
    );
    // Ravi's chat has entries beyond this chat's last position.
    const ravis = (await transcripts.chat("ravi")) as ChatRow;
    for (let i = 0; i < reply + 2; i++) await say(`Ravi ${String(i)}`, ravis);
    const before = written();
    const refused = await save([headache(reply), headache(reply + 2)]);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.0.source",
        got: String(reply),
        fix: `Position ${String(reply)} is your reply, not a message of the user's. Give the position of their message as read_chat shows it, or leave source out for their message in this turn.`,
      },
      {
        path: "changes.1.source",
        got: String(reply + 2),
        fix: `Nothing in this chat is at position ${String(reply + 2)}. Give the position of the user's message as read_chat shows it, or leave source out for their message in this turn.`,
      },
    ]);
    expect(written()).toEqual(before);
  });

  it("resolves a position only within this chat, when another chat has a message there too", async () => {
    const ravis = (await transcripts.chat("ravi")) as ChatRow;
    await say("Ravi's headache", ravis);
    const mine = await say("I have a headache");
    expect(seqOf(mine)).toBe(1);
    const saved = await save([headache(1)]);
    expect(sourcesOf(saved.body.result.changes[0]?.id ?? "")).toEqual([
      { type: "message", entry_id: mine },
    ]);
  });

  it("is refused with a fix when this turn has no message of the user's and no position is given", async () => {
    await transcripts.addMessage(chat, {
      id: "before",
      kind: "message",
      text: "I have a headache",
    });
    const refused = await save([headache()]);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.0.source",
        got: "nothing",
        fix: "This turn has no message of the user's. Give source: the position of the user's message this rests on, as read_chat shows it.",
      },
    ]);
  });
});

describe("the AI's view of the record", () => {
  it("shows the latest saves with what each changed, so the AI can save the reverse", async () => {
    await say("I stopped creatine");
    await save([
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a2",
        fields: { status: "stopped" },
      },
    ]);
    const answer = JSON.parse(
      (
        await forAgent(
          () => ({ store: reader, personId: "asha" }),
          () => undefined,
        ).forTurn()("get_overview", {})
      ).text,
    ) as { result: Record<string, unknown> };
    expect(answer.result["record"]).toMatchObject({
      medicine_use: { items: [{ id: "med-a2", status: "stopped" }, {}] },
    });
    expect(answer.result["latest_saves"]).toEqual([
      {
        at: SUNDAY_10AM,
        receipt:
          "**Saved**\n\n- Changed medicine use **Creatine 5 g**: status *current* → *stopped*",
        changes: [
          {
            kind: "medicine_use",
            id: "med-a2",
            action: "change",
            before: { status: "current" },
            after: { status: "stopped" },
          },
        ],
      },
    ]);
  });
});

describe("a visit and the records saved from it", () => {
  /** The AI's view of the record, as get_overview gives it. */
  const overview = async () =>
    (
      JSON.parse(
        (
          await forAgent(
            () => ({ store: reader, personId: "asha" }),
            () => undefined,
          ).forTurn()("get_overview", {})
        ).text,
      ) as {
        result: { latest_saves: { changes: Record<string, unknown>[] }[] };
      }
    ).result;

  it("saves a visit from its page and the records citing it in one save, and the reverse saves set every record back", async () => {
    const metformin = row("medicine_uses", "med-a1");
    const creatine = row("medicine_uses", "med-a2");
    await say(
      "Yes: I take the iron now, the metformin goes up to 1000 mg, and I keep the creatine",
    );
    const visit = { visit: { ref: "v1" } };
    const saved = await save([
      {
        kind: "visit",
        action: "add",
        ref: "v1",
        from: [{ document: "doc-asha-sep", page: 1 }],
        fields: {
          setting: "clinic",
          date: { date: "2026-10-02", words: "02/10/2026" },
          doctor: "Dr A. Fictional",
          place: "Lakeview Family Clinic",
          reason: "Iron deficiency anaemia",
          as_written:
            "**Diagnosis:** Iron deficiency anaemia\n\n**Rx**\n1. Ferrous sulfate 200 mg once daily\n2. Metformin 1000 mg twice a day\n3. Creatine, continue",
        },
      },
      {
        kind: "medicine_use",
        action: "add",
        from: [visit],
        fields: {
          name: "Ferrous sulfate",
          strength: "200 mg",
          status: "current",
        },
      },
      { kind: "medicine_use", action: "link", id: "med-a2", from: [visit] },
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a1",
        from: [visit],
        fields: {
          status: "stopped",
          ended: { date: "2026-10-02", words: "02/10/2026" },
        },
      },
      {
        kind: "medicine_use",
        action: "add",
        from: [visit],
        fields: { name: "Metformin", strength: "1000 mg", status: "current" },
      },
    ]);
    expect(saved.ok).toBe(true);
    const [visitId, ironId, , , newDoseId] = saved.body.result.changes.map(
      (change) => change.id,
    );
    expect(lines(saved.body.result.receipt)).toEqual([
      "Saved",
      'Added visit Dr A. Fictional · Lakeview Family Clinic: setting clinic, date 2 Oct 2026 ("02/10/2026"), reason Iron deficiency anaemia, as written **Diagnosis:** Iron deficiency anaemia **Rx** 1. Ferrous sulfate 200 mg once d… · from thyroid recheck.jpg, page 1',
      "Added medicine use Ferrous sulfate 200 mg: current · from visit Dr A. Fictional · Lakeview Family Clinic · 2 Oct 2026",
      "Added a source to medicine use Creatine 5 g: visit Dr A. Fictional · Lakeview Family Clinic · 2 Oct 2026 (its values stay as they are)",
      'Changed medicine use Metformin 500 mg: status current → stopped; end not given → 2 Oct 2026 ("02/10/2026") · from visit Dr A. Fictional · Lakeview Family Clinic · 2 Oct 2026',
      "Added medicine use Metformin 1000 mg: current · from visit Dr A. Fictional · Lakeview Family Clinic · 2 Oct 2026",
    ]);
    // The visit rests on its page; the records from it on the visit. The
    // yes is no source of either.
    expect(sourcesOf(visitId ?? "")).toEqual([
      { type: "document_page", page: "doc-asha-sep p1" },
    ]);
    for (const id of [ironId, "med-a2", "med-a1", newDoseId]) {
      expect(sourcesOf(id ?? "")).toEqual([
        { type: "visit", visit_id: visitId },
      ]);
    }
    expect(row("medicine_uses", "med-a2")).toEqual(creatine);

    // "Undo that": the AI saves the reverse of what latest saves show.
    const [latest] = (await overview()).latest_saves;
    expect(latest?.changes).toEqual([
      { kind: "visit", id: visitId, action: "add", fields: expect.any(Object) },
      {
        kind: "medicine_use",
        id: ironId,
        action: "add",
        fields: {
          name: "Ferrous sulfate",
          strength: "200 mg",
          status: "current",
        },
      },
      {
        kind: "medicine_use",
        id: "med-a2",
        action: "link",
        from: [{ visit: visitId }],
      },
      {
        kind: "medicine_use",
        id: "med-a1",
        action: "change",
        from: [{ visit: visitId }],
        before: { status: "current" },
        after: {
          status: "stopped",
          ended: { date: "2026-10-02", words: "02/10/2026" },
        },
      },
      {
        kind: "medicine_use",
        id: newDoseId,
        action: "add",
        fields: { name: "Metformin", strength: "1000 mg", status: "current" },
      },
    ]);
    const undo = await say("Undo that");
    const back = await save(
      [
        { kind: "visit", action: "remove", id: visitId },
        { kind: "medicine_use", action: "remove", id: ironId },
        { kind: "medicine_use", action: "remove", id: newDoseId },
        {
          kind: "medicine_use",
          action: "remove_source",
          id: "med-a2",
          from: [{ visit: visitId }],
        },
        {
          kind: "medicine_use",
          action: "change",
          id: "med-a1",
          fields: { status: "current", ended: null },
        },
      ],
      "call-2",
    );
    expect(back.ok).toBe(true);
    // One save changes a record once: the old dose's source comes off next.
    const off = await save(
      [
        {
          kind: "medicine_use",
          action: "remove_source",
          id: "med-a1",
          from: [{ visit: visitId }],
        },
      ],
      "call-3",
    );
    expect(off.ok).toBe(true);
    expect(row("medicine_uses", "med-a1")).toEqual(metformin);
    expect(row("medicine_uses", "med-a2")).toEqual(creatine);
    for (const [table, id] of [
      ["visits", visitId],
      ["medicine_uses", ironId],
      ["medicine_uses", newDoseId],
    ]) {
      expect(row(table ?? "", id ?? "")["removed"]).toBe(1);
    }
    expect(sourcesOf("med-a2")).toEqual([]);
    // The change back rests on the user's "undo that".
    expect(sourcesOf("med-a1")).toEqual([{ type: "message", entry_id: undo }]);
  });

  it("refuses a source that isn't this person's live page or visit, or a ref no earlier change adds, and saves nothing", async () => {
    store.db.exec(`
      INSERT INTO visits (id, person_id, as_written) VALUES ('visit-ravi', 'ravi', 'Checkup');
      UPDATE documents SET deleted_at = '2026-10-03T09:00:00Z' WHERE id = 'doc-asha-aug';
    `);
    await say("Save the visit and the iron");
    const before = written();
    const refused = await save([
      {
        kind: "medicine_use",
        action: "add",
        from: [{ visit: { ref: "v1" } }],
        fields: { name: "Ferrous sulfate" },
      },
      {
        kind: "visit",
        action: "add",
        ref: "v1",
        from: [
          { document: "doc-ravi-jul", page: 1 },
          { document: "doc-asha-aug", page: 1 },
        ],
        fields: { as_written: "Ferrous sulfate 200 mg" },
      },
      {
        kind: "medicine_use",
        action: "link",
        id: "med-a2",
        from: [{ visit: "visit-ravi" }],
      },
    ]);
    expect(refused.ok).toBe(false);
    expect(refused.body.issues.map(({ path, fix }) => [path, fix])).toEqual([
      [
        "changes.0.from.0",
        "No earlier change of this save adds a record with ref v1: add the visit first, with that ref.",
      ],
      [
        "changes.1.from.0",
        "No page of this person's documents is at this document and page: read them with get_documents.",
      ],
      [
        "changes.1.from.1",
        "This document was deleted, so its page can't be a source.",
      ],
      ["changes.2.from.0", "No visit with this id is in this person's record."],
    ]);
    expect(written()).toEqual(before);
  });
});

describe("a crash during a save", () => {
  it.each(["before", "after"] as const)(
    "%s its commit leaves the records and the receipt together, or neither",
    async (when) => {
      await say("I have a headache");
      store.close();
      reader.close();
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "../../../tests/save-process.ts"),
          path,
          chat.id,
          when,
        ],
        { stdio: "inherit" },
      );
      const signal = await new Promise((resolve) =>
        child.on("exit", (_code, signal) => {
          resolve(signal);
        }),
      );
      expect(signal).toBe("SIGKILL");
      store = openWritable(path);
      reader = openReadOnly(path) as Store;
      const found = [
        rows("SELECT name FROM symptoms"),
        rows("SELECT id FROM operations").length,
        rows("SELECT seq FROM record_changes").length,
        receipts().length,
      ];
      expect(found).toEqual(
        when === "before" ? [[], 0, 0, 0] : [[{ name: "Headache" }], 1, 1, 1],
      );
    },
  );
});
