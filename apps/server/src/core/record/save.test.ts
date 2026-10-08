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
  await transcripts.addMessage(to, { id, kind: "message", text });
  return id;
}

/** The AI calls save_changes in the chat's turn. */
async function save(changes: unknown[], callId = "call-1", to = chat) {
  const answer = await chatCaller(
    reader,
    transcripts,
    () => undefined,
  )(to, "t-1")("save_changes", { changes }, callId);
  return {
    ok: answer.ok,
    body: JSON.parse(answer.text) as Record<string, unknown> & {
      result: { receipt: string; changes: { kind: string; id: string }[] };
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
    kind: "prescription",
    table: "prescriptions",
    said: "Dr Rao prescribed amoxicillin 500 mg three times a day for 5 days on 2 Oct",
    add: {
      item: "Amoxicillin",
      strength: "500 mg",
      schedule: "three times a day",
      period: "for 5 days",
      prescriber: "Dr Rao",
      issued: { date: "2026-10-02", words: "on 2 Oct" },
    },
    stored: {
      item: "Amoxicillin",
      strength: "500 mg",
      schedule: "three times a day",
      period: "for 5 days",
      prescriber: "Dr Rao",
      issued: "2026-10-02",
      issued_words: "on 2 Oct",
    },
    added: [
      "Saved",
      'Added prescription Amoxicillin 500 mg: schedule three times a day, period for 5 days, prescriber Dr Rao, issued 2 Oct 2026 ("on 2 Oct")',
    ],
    change: {
      said: "It was Dr Mehta, not Dr Rao",
      fields: { prescriber: "Dr Mehta" },
      stored: { prescriber: "Dr Mehta" },
      receipt: [
        "Saved",
        "Changed prescription Amoxicillin 500 mg: prescriber Dr Rao → Dr Mehta",
      ],
    },
    removed: ["Saved", "Removed prescription Amoxicillin 500 mg"],
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
      number: 128,
      second_number: 84,
      unit: "mmHg",
      measured: { date: "2026-10-04", words: "this morning" },
    },
    stored: {
      test_name: "Blood pressure",
      value_text: "128/84",
      value_number: 128,
      second_number: 84,
      unit: "mmHg",
      measured_at: "2026-10-04",
      measured_words: "this morning",
      entered_at: SUNDAY_10AM,
    },
    added: [
      "Saved",
      'Added result Blood pressure 128/84 mmHg: measured 4 Oct 2026 ("this morning")',
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
    said: "I have a dentist visit planned on 20 Oct",
    add: {
      type: "visit",
      name: "Dentist",
      status: "planned",
      date: { date: "2026-10-20", words: "on 20 Oct" },
    },
    stored: {
      type: "visit",
      name: "Dentist",
      status: "planned",
      date: "2026-10-20",
      date_words: "on 20 Oct",
    },
    added: [
      "Saved",
      'Added care event Dentist: type visit, planned, date 20 Oct 2026 ("on 20 Oct")',
    ],
    change: {
      said: "The dentist visit moved to 22 Oct",
      fields: { date: { date: "2026-10-22", words: "22 Oct" } },
      stored: { date: "2026-10-22", date_words: "22 Oct" },
      receipt: [
        "Saved",
        'Changed care event Dentist: date 20 Oct 2026 ("on 20 Oct") → 22 Oct 2026 ("22 Oct")',
      ],
    },
    removed: ["Saved", "Removed care event Dentist"],
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
        { kind: c.kind, action: "add", source: c.said, fields: c.add },
      ]);
      expect(added.body).toMatchObject({ ok: true });
      expect(lines(added.body.result.receipt)).toEqual(c.added);
      const id = added.body.result.changes[0]?.id ?? "";
      const first = row(c.table, id);
      expect(first).toEqual({
        ...blank(c.table),
        id,
        person_id: "asha",
        source_entry_id: source,
        removed: 0,
        ...(c.table === "symptoms" ||
        c.table === "medicine_uses" ||
        c.table === "care_events"
          ? { status: "unknown" }
          : {}),
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
              source: c.change.said,
              fields: c.change.fields,
            },
          ],
          `call-${String(++calls)}`,
        );
        expect(lines(changed.body.result.receipt)).toEqual(c.change.receipt);
        expected.push(c.change.receipt);
        // The rest stays as it was.
        current = { ...first, ...c.change.stored, source_entry_id: again };
        expect(row(c.table, id)).toEqual(current);
      }

      const gone = await save(
        [{ kind: c.kind, action: "remove", id, source: c.said }],
        `call-${String(calls + 1)}`,
      );
      expect(lines(gone.body.result.receipt)).toEqual(c.removed);
      expected.push(c.removed);
      const removed = { ...current, removed: 1, source_entry_id: source };
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
    await say(said);
    const before = row("medicine_uses", "med-a2");
    const saved = await save([
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a2",
        source: said,
        fields: { status: "stopped" },
      },
      {
        kind: "symptom",
        action: "add",
        source: "stomach upset",
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
          source: "undo that",
          fields: { status: "current" },
        },
        { kind: "symptom", action: "remove", id: symptom, source: "undo that" },
      ],
      "call-2",
    );
    expect(lines(undone.body.result.receipt)).toEqual([
      "Saved",
      "Changed medicine use Creatine 5 g: status stopped → current",
      "Removed symptom Stomach upset",
    ]);
    expect(row("medicine_uses", "med-a2")).toEqual({
      ...before,
      source_entry_id: yes,
    });
    expect(row("symptoms", symptom)["removed"]).toBe(1);
    expect(receipts()).toHaveLength(2);
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
        source: "headaches",
        fields: {
          name: "Headache",
          details: `${prefix} frequency once a week`,
        },
      },
      {
        kind: "symptom",
        action: "add",
        source: "toothaches",
        fields: { name: "Toothache" },
      },
      {
        kind: "symptom",
        action: "add",
        source: "sore back",
        fields: { name: "Back pain" },
      },
      {
        kind: "symptom",
        action: "add",
        source: "sore back",
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
          source: "Ask the doctor about my pain",
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
          source: "every day now",
          fields: { details: `${prefix} frequency every day` },
        },
        {
          kind: "follow_up",
          action: "change",
          id,
          source: "about my teeth",
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
          source: "about my back",
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
          source: "about my back",
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
          source: "report link",
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
          source: "version 2",
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
        source: "since 2019",
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
        source: "I started magnesium",
        fields: { name: "Magnesium" },
      },
      {
        kind: "medicine_use",
        action: "change",
        id: "med-a2",
        source: "stopped creatine",
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
      change: { kind: "diet", action: "add", source: "x", fields: {} },
      path: "changes.0",
    },
    {
      name: "a field the kind doesn't have",
      change: {
        kind: "symptom",
        action: "add",
        source: "headache",
        fields: { name: "Headache", colour: "red" },
      },
      path: "changes.0.fields.colour",
    },
    {
      name: "an add without its required field",
      change: {
        kind: "symptom",
        action: "add",
        source: "headache",
        fields: {},
      },
      path: "changes.0.fields.name",
    },
    {
      name: "a change without an id",
      change: {
        kind: "symptom",
        action: "change",
        source: "headache",
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
        source: "headache",
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
        source: "headache",
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
      source: "I have a headache",
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

  it("refuses another person's record, and words the user didn't say in this chat", async () => {
    await say("Stop my atorvastatin");
    await say(
      "I have a toothache",
      (await transcripts.chat("ravi")) as ChatRow,
    );
    const before = written();
    const refused = await save([
      {
        kind: "medicine_use",
        action: "change",
        id: "med-r1",
        source: "Stop my atorvastatin",
        fields: { status: "stopped" },
      },
      {
        kind: "symptom",
        action: "add",
        source: "I have a toothache",
        fields: { name: "Toothache" },
      },
      {
        kind: "symptom",
        action: "add",
        source: "the AI's own idea",
        fields: { name: "Fatigue" },
      },
    ]);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.0.id",
        got: '"med-r1"',
        fix: "No medicine use with this id is in this person's record.",
      },
      ...[1, 2].map((i) => ({
        path: `changes.${String(i)}.source`,
        got: expect.any(String) as string,
        fix: "No message of the user's in this chat has these words. Copy the user's own words exactly from the message this change rests on.",
      })),
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
            source: "x",
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
  it("never makes a medicine use from a prescription", async () => {
    await say("Dr Rao prescribed amoxicillin");
    const medicines = rows("SELECT * FROM medicine_uses");
    await save([
      {
        kind: "prescription",
        action: "add",
        source: "Dr Rao prescribed amoxicillin",
        fields: { item: "Amoxicillin", prescriber: "Dr Rao" },
      },
    ]);
    expect(rows("SELECT * FROM prescriptions")).toHaveLength(1);
    expect(rows("SELECT * FROM medicine_uses")).toEqual(medicines);
  });

  it("stops only the use it names when two uses of one medicine coexist", async () => {
    await say("I also take metformin 500 mg at night");
    const night = await save([
      {
        kind: "medicine_use",
        action: "add",
        source: "metformin 500 mg at night",
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
          source: "stopped the night metformin",
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
        source: "no allergies",
        fields: { category: "allergies" },
      },
    ]);
    const statementId = statement.body.result.changes[0]?.id ?? "";
    await say("I'm allergic to penicillin");
    const allergy = {
      kind: "allergy",
      action: "add",
      source: "allergic to penicillin",
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
          source: "allergic to penicillin",
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
          source: "I have a headache",
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
          source: "I have no allergies",
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
        source: "corrected my HbA1c",
        fields: { value: "6.6" },
      },
      {
        kind: "result",
        action: "remove",
        id: "res-a2",
        source: "corrected my HbA1c",
      },
    ]);
    expect(refused.body.issues.map((issue) => issue.fix)).toEqual([
      "This result was read from a document, so it changes only by amendment: add a new result with replaces set to this id.",
      "This result was read from a document, so it changes only by amendment: add a new result with replaces set to this id.",
    ]);
    const amended = await save(
      [
        {
          kind: "result",
          action: "add",
          source: "corrected my HbA1c to 6.6",
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
          source: "Undo that",
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
          source: "it is 6.5",
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
          source: "Undo that",
        },
      ],
      "call-5",
    );
    expect(back.body.issues[0]?.fix).toBe(
      "The result it amends was amended again since: amend the newest version instead.",
    );
  });

  it("keeps planned care apart from done care: done care has happened by the time the user says so", async () => {
    await say("I have a dentist visit on 20 Oct");
    const planned = await save([
      {
        kind: "care_event",
        action: "add",
        source: "dentist visit on 20 Oct",
        fields: {
          type: "visit",
          name: "Dentist",
          status: "planned",
          date: { date: "2026-10-20", words: "on 20 Oct" },
        },
      },
    ]);
    expect(planned.ok).toBe(true);
    const id = planned.body.result.changes[0]?.id ?? "";
    await say("I went to the dentist");
    const done = await save(
      [
        {
          kind: "care_event",
          action: "change",
          id,
          source: "I went to the dentist",
          fields: { status: "done" },
        },
      ],
      "call-2",
    );
    expect(done.body.issues).toEqual([
      {
        path: "changes.0.fields.date.date",
        got: '"2026-10-20"',
        fix: "20 Oct 2026 is after the user said it (4 Oct 2026 10:00). Count relative dates from when the message was sent.",
      },
    ]);
    expect(row("care_events", id)["status"]).toBe("planned");
  });
});

describe("dates", () => {
  it("keeps a date at the precision and in the words the user said it", async () => {
    await say("I've had asthma since 2019");
    const saved = await save([
      {
        kind: "condition",
        action: "add",
        source: "asthma since 2019",
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

  it("refuses a date whose words aren't in the source message, or that is later than it was said", async () => {
    await say("I started magnesium");
    // Said on Sunday 4 Oct at 10:00 in India; read days later.
    clock = "2026-10-12T04:30:00.000Z";
    await say("yes");
    const refused = await save([
      {
        kind: "medicine_use",
        action: "add",
        source: "I started magnesium",
        fields: {
          name: "Magnesium",
          started: { date: "2026-09-28", words: "last Monday" },
        },
      },
      {
        kind: "symptom",
        action: "add",
        source: "I started magnesium",
        fields: {
          name: "Cramp",
          onset: { date: "2026-10-04T10:31", words: "magnesium" },
        },
      },
    ]);
    expect(refused.body.issues).toEqual([
      {
        path: "changes.0.fields.started.words",
        got: '"last Monday"',
        fix: "These words aren't in the source message. Give the user's own words for the date from the message you quote in source, or leave the date out if they didn't say one.",
      },
      {
        path: "changes.1.fields.onset.date",
        got: '"2026-10-04T10:31"',
        fix: "4 Oct 2026 10:31 is after the user said it (4 Oct 2026 10:00). Count relative dates from when the message was sent.",
      },
    ]);
    // The minute it was said, in the Mac's time zone, is not later.
    const same = await save(
      [
        {
          kind: "symptom",
          action: "add",
          source: "I started magnesium",
          fields: {
            name: "Cramp",
            onset: { date: "2026-10-04T10:00", words: "magnesium" },
          },
        },
      ],
      "call-2",
    );
    expect(same.ok).toBe(true);
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
        source: "I stopped creatine",
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
