// Deleting a document on a real database and real files, with the
// fictional family: what blocks it, what goes and what stays, the chat's
// chips and the brief's sources after it, a shared file, adding the same
// file again, a stale preview, the bytes a delete leaves when Rufi stops
// between its commit and its removal, and the AI's notes on it.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { familyFiles } from "../../../tests/fixtures/golden.ts";
import { readBrief } from "../briefs/briefs.ts";
import { drafts as openDrafts } from "../chat/drafts.ts";
import { chatQueue } from "../chat/queue.ts";
import { RefRefusal } from "../chat/refs.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../chat/transcript.ts";
import { recordViews } from "../record/views.ts";
import { makeBackup, verifyBackup } from "../store/backup.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { rufiCaller } from "../tools/tools.ts";
import { deletions, NoChoice, StalePreview, sweepFiles } from "./delete.ts";
import { documents, type Documents } from "./documents.ts";
import { fileGate, type FileGate } from "./gate.ts";
import { displayPath, originalPath, pagePath } from "./originals.ts";
import { pages, publisher } from "./pages.ts";
import { readings } from "./reading.ts";
import { sorting } from "./sorting.ts";
import { workPath } from "../store/work.ts";
import { addSent } from "../../../tests/sent.ts";
import { turnScope } from "../../../tests/scope.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);
const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");
const NOW = "2026-10-11T09:00:00.000Z";
/** Asha's August report, and its PDF. */
const AUG = "doc-asha-aug";
const AUG_FILE =
  "7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54";
/** Asha's September photo. */
const SEP_FILE =
  "a2d64c4aa2a3101f1fc2ee893451ca0f43f547ca48ba5a1ce625c42d52e23562";
/** Ravi's lipid panel's PDF. */
const RAVI_FILE =
  "f7d7c195033e1719e2c191970b14e52478e02faf51f1d61e57b517674fbc9c45";

let home: string;
let store: Store;
let reader: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let gate: FileGate;
let docs: Documents;
let stopped: string[];
let logged: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-delete-"));
  store = openWritable(databasePath(home));
  store.db.exec(family);
  await familyFiles(home);
  reader = openReadOnly(databasePath(home)) as Store;
  transcripts = openTranscripts(store, () => NOW);
  chat = (await transcripts.chat("asha")) as ChatRow;
  gate = fileGate();
  docs = documents(
    store,
    home,
    () => NOW,
    readings(store, () => NOW),
    gate,
  );
  stopped = [];
  logged = [];
  return () => {
    reader.close();
    store.close();
  };
});

/** The delete as the core makes it, its event in the person's chat. */
const deleting = (over: { gate?: FileGate } = {}) =>
  deletions({
    store,
    home,
    gate: over.gate ?? gate,
    event: async (personId, event, write) => {
      const to = await transcripts.chat(personId);
      if (!to) throw new Error("No chat.");
      await transcripts.addEvent(to, event, write);
    },
    stopReading: (id) => {
      stopped.push(id);
    },
    changed: () => undefined,
    log: (event) => {
      logged.push(event);
    },
    now: () => NOW,
  });

const rows = (sql: string, ...params: string[]) =>
  store.db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));

const there = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

/** The AI saves in Asha's chat, after the user said `said`. */
async function save(said: string, changes: unknown[]) {
  const id = `msg-${String(Math.random())}`;
  await transcripts.addMessage(chat, {
    id,
    kind: "message",
    text: said,
    agentTurnId: "t-1",
  });
  const answer = await rufiCaller(
    reader,
    transcripts,
    () => undefined,
  )(turnScope(chat, "t-1"))("save_changes", { changes }, `call-${id}`);
  expect(answer.text).not.toContain('"issues"');
  expect(answer.ok).toBe(true);
}

/** Adds a file from the fixtures for a person; returns its new document. */
async function add(personId: string, file: string, name = file) {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, file)));
  const { added } = await addSent(docs, store, personId, [{ name, bytes }]);
  return added[0] ?? "";
}

beforeEach(async () => {
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
});

/** Rufi's notes for the AI that wait in the queue, and their holds. */
const notes = () =>
  rows("SELECT held, text FROM chat_queue WHERE origin = 'rufi'");

describe("a document with saved results", () => {
  it("lists each one not removed, a replaced one too; a delete with no choice changes nothing; Delete file keeps them, and the AI hears at once they stay", async () => {
    // CRP was removed before: it isn't listed. The paper was also saved as
    // a visit, and the creatine was saved from that visit: the list has the
    // visit, not the creatine, and Delete file keeps both.
    store.db.exec(`
      UPDATE results SET removed = 1 WHERE id = 'res-a3';
      INSERT INTO visits (id, person_id, setting, date, doctor, place, as_written) VALUES
        ('visit-aug', 'asha', 'clinic', '2026-08-12', 'Dr Rao', 'Lakeview Family Clinic', 'Creatine 5 g every morning');
      INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page, visit_id) VALUES
        ('asha', 'visit', 'visit-aug', 'document_page', '${AUG}', 1, NULL),
        ('asha', 'medicine_use', 'med-a2', 'visit', NULL, NULL, 'visit-aug');
    `);
    const remover = deleting();

    const preview = await remover.preview("asha", AUG);

    expect(preview?.saved).toEqual([
      {
        kind: "result",
        id: "res-a1",
        label: "HbA1c 6.8 %",
        date: "12 Aug 2026",
        replaced: false,
      },
      {
        kind: "result",
        id: "res-a2",
        label: "Glucose 118 mg/dL",
        date: "12 Aug 2026",
        replaced: false,
      },
      {
        kind: "result",
        id: "res-a4",
        label: "TSH 2.1 mIU/L",
        date: "12 Aug 2026",
        replaced: true,
      },
      {
        kind: "visit",
        id: "visit-aug",
        label: "Dr Rao · Lakeview Family Clinic",
        date: "12 Aug 2026",
        replaced: false,
      },
    ]);
    const before = rows("SELECT * FROM documents");
    await expect(
      remover.remove("asha", AUG, preview?.version ?? ""),
    ).rejects.toBeInstanceOf(NoChoice);
    expect(rows("SELECT * FROM documents")).toEqual(before);
    expect(notes()).toEqual([]);
    expect(await there(originalPath(home, AUG_FILE))).toBe(true);

    await remover.remove("asha", AUG, preview?.version ?? "", "keep");

    expect(rows("SELECT deleted_at FROM documents WHERE id = ?", AUG)).toEqual([
      { deleted_at: NOW },
    ]);
    expect(await there(originalPath(home, AUG_FILE))).toBe(false);
    const kept = await recordViews(reader, () => new Date(NOW)).detail(
      "asha",
      "result",
      "res-a1",
    );
    expect(kept?.removed).toBe(false);
    const creatine = await recordViews(reader, () => new Date(NOW)).detail(
      "asha",
      "medicine_use",
      "med-a2",
    );
    expect([creatine?.removed, creatine?.sources]).toEqual([
      false,
      [
        {
          type: "visit",
          visit: "visit-aug",
          label: "Dr Rao · Lakeview Family Clinic · 12 Aug 2026",
          removed: false,
        },
      ],
    ]);
    expect(kept?.sources).toEqual([
      {
        type: "document",
        document: AUG,
        page: 1,
        file: "Sunrise Labs August.pdf",
        deleted: true,
      },
    ]);
    // Not held for the person's next message: it goes in its turn.
    expect(notes()).toEqual([
      {
        held: null,
        text: expect.stringContaining(
          `The user deleted document ${AUG} (Sunrise Labs August.pdf), the file only. These records saved from it stay in the record, valid:
- result res-a1: HbA1c 6.8 %, 12 Aug 2026
- result res-a2: Glucose 118 mg/dL, 12 Aug 2026
- result res-a4: TSH 2.1 mIU/L, 12 Aug 2026 (replaced by an amendment)
- visit visit-aug: Dr Rao · Lakeview Family Clinic, 12 Aug 2026
`,
        ) as unknown,
      },
    ]);
  });

  it("with its results: the AI hears at once which to go through; after the delete, it removes them on a yes, and takes the document off one the user also typed", async () => {
    // Vitamin D, typed in the chat, was also saved as read from page 2.
    store.db.exec(
      `INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES ('asha', 'result', 'res-a7', 'document_page', '${AUG}', 2)`,
    );
    const views = recordViews(reader, () => new Date(NOW));
    const history = (await views.detail("asha", "result", "res-a1"))?.history;
    const remover = deleting();
    const preview = await remover.preview("asha", AUG);
    expect(preview?.saved.map((r) => r.id)).toEqual([
      "res-a1",
      "res-a2",
      "res-a3",
      "res-a4",
      "res-a7",
    ]);

    await remover.remove("asha", AUG, preview?.version ?? "", "remove");

    // The delete changed nothing in the record or its history.
    expect((await views.detail("asha", "result", "res-a1"))?.history).toEqual(
      history,
    );
    const [note] = notes();
    expect(note?.held).toBeNull();
    expect(note?.text).toContain(
      `The user deleted document ${AUG} (Sunrise Labs August.pdf) and asked to remove the records saved from it:
- result res-a1: HbA1c 6.8 %, 12 Aug 2026
`,
    );
    expect(note?.text).toContain("- result res-a7: Vitamin D");
    expect(note?.text).toContain("this note isn't their yes");
    // The user's yes, in the chat.
    await save("That report isn't mine: take it off my vitamin D", [
      {
        kind: "result",
        action: "remove_source",
        id: "res-a7",
        from: [{ document: AUG, page: 2 }],
      },
    ]);
    await save(
      "And remove the results it gave",
      ["res-a1", "res-a2", "res-a3", "res-a4"].map((id) => ({
        kind: "result",
        action: "remove",
        id,
      })),
    );
    expect(
      rows("SELECT text FROM transcript_entries WHERE kind = 'receipt'"),
    ).toHaveLength(2);

    // A tombstone: its name and pages, no file, nothing of the reader's.
    expect(
      rows(
        "SELECT deleted_at, kind, date, reader_note FROM documents WHERE id = ?",
        AUG,
      ),
    ).toEqual([{ deleted_at: NOW, kind: null, date: null, reader_note: null }]);
    expect(
      rows(
        "SELECT position, file_id, file_name, entry, state FROM document_pages WHERE document_id = ? ORDER BY position",
        AUG,
      ),
    ).toEqual(
      [1, 2].map((position) => ({
        position,
        file_id: null,
        file_name: "Sunrise Labs August.pdf",
        entry: null,
        state: null,
      })),
    );
    expect(rows("SELECT id FROM files WHERE id = ?", AUG_FILE)).toEqual([]);
    expect(await there(originalPath(home, AUG_FILE))).toBe(false);
    expect((await docs.list("asha")).map((d) => d.id)).not.toContain(AUG);
    // Removed on the yes; its source says deleted.
    const removed = await views.detail("asha", "result", "res-a1");
    expect(removed?.removed).toBe(true);
    expect(removed?.sources).toEqual([
      {
        type: "document",
        document: AUG,
        page: 1,
        file: "Sunrise Labs August.pdf",
        deleted: true,
      },
    ]);
    const typed = await views.detail("asha", "result", "res-a7");
    expect(typed?.removed).toBe(false);
    expect(typed?.sources).toEqual([]);
    // The AI's fresh reads can't get it; the chat says it went.
    const call = rufiCaller(
      reader,
      transcripts,
      () => undefined,
    )(turnScope(chat, "t-1"));
    const list = await call("get_documents", {}, "call-list");
    expect(list.text).not.toContain(AUG);
    const overview = JSON.parse(
      (await call("get_overview", {}, "call-overview")).text,
    ) as { result: { documents: number; reports: number } };
    // Only September's report is left; both reports stay in the record.
    expect(overview.result).toMatchObject({ documents: 1, reports: 2 });
    const one = await call("get_documents", { document: AUG }, "call-one");
    expect(one.ok).toBe(false);
    expect(one.text).toContain("deleted this document");
    expect(
      rows(
        "SELECT text FROM transcript_entries WHERE kind = 'event' ORDER BY seq",
      ),
    ).toEqual([{ text: "Deleted Sunrise Labs August.pdf" }]);
    // Restoring a removed result still works; its source still says deleted.
    await save("Undo that for HbA1c", [
      {
        kind: "result",
        action: "restore",
        id: "res-a1",
      },
    ]);
    const restored = await views.detail("asha", "result", "res-a1");
    expect(restored?.removed).toBe(false);
    expect(restored?.sources).toEqual(removed?.sources);
  });
});

describe("a delete", () => {
  it("is refused with a fresh preview when something changed since its preview, and goes on the fresh one", async () => {
    const id = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    const remover = deleting();
    const first = await remover.preview("asha", id);
    // Another tab: a save rests a result on it after this preview.
    store.db.exec(
      `INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES ('asha', 'result', 'res-a7', 'document_page', '${id}', 1)`,
    );

    const refused = await remover
      .remove("asha", id, first?.version ?? "")
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(StalePreview);
    expect((refused as StalePreview).preview.saved.map((r) => r.id)).toEqual([
      "res-a7",
    ]);
    expect(rows("SELECT deleted_at FROM documents WHERE id = ?", id)).toEqual([
      { deleted_at: null },
    ]);
    expect(
      rows("SELECT text FROM transcript_entries WHERE kind = 'event'"),
    ).toEqual([]);

    const fresh = await remover.preview("asha", id);
    await remover.remove("asha", id, fresh?.version ?? "", "keep");
    expect(rows("SELECT deleted_at FROM documents WHERE id = ?", id)).toEqual([
      { deleted_at: NOW },
    ]);
  });

  it("keeps a file another person's document uses, and the same file can be added again", async () => {
    // Asha adds Ravi's lipid panel by mistake: the same bytes as his.
    const mistake = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    const remover = deleting();

    await remover.remove(
      "asha",
      mistake,
      (await remover.preview("asha", mistake))?.version ?? "",
    );

    expect(rows("SELECT id FROM files WHERE id = ?", RAVI_FILE)).toHaveLength(
      1,
    );
    expect(await there(originalPath(home, RAVI_FILE))).toBe(true);
    const ravis = await pages(store, home, gate).page(
      "ravi",
      "doc-ravi-jul",
      1,
    );
    expect(ravis?.ok).toBe(true);
    expect(await pages(store, home, gate).page("asha", mistake, 1)).toBe(
      undefined,
    );

    const again = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    expect(again).not.toBe(mistake);
    expect((await docs.list("asha")).map((d) => d.id)).toContain(again);
  });

  it("takes the reader's copies of its own pages with its readings; another document's copies stay", async () => {
    const id = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    // A reader that copies read it, and Asha's September photo.
    store.db.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at) VALUES
        ('job-copy-lipid', 'asha', 'document_read', '${id}', 'done', 1, '[1]', '${NOW}'),
        ('job-copy-sep', 'asha', 'document_read', 'doc-asha-sep', 'done', 1, '[1]', '${NOW}');
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at) VALUES
        ('asha', '${RAVI_FILE}', 1, 'job-copy-lipid', 1, 'read', '# Lipid panel', '${NOW}'),
        ('asha', '${SEP_FILE}', 1, 'job-copy-sep', 1, 'read', '# Thyroid recheck', '${NOW}');
    `);
    const remover = deleting();

    await remover.remove(
      "asha",
      id,
      (await remover.preview("asha", id))?.version ?? "",
    );

    expect(rows("SELECT job_id, copy FROM page_copies")).toEqual([
      { job_id: "job-copy-sep", copy: "# Thyroid recheck" },
    ]);
    expect(
      rows("SELECT id FROM jobs WHERE id LIKE 'job-copy-%' ORDER BY id"),
    ).toEqual([{ id: "job-copy-sep" }]);
  });

  it("marks the chat's chips of the document and its draft items as deleted, takes Open off its reading's line, and brief sources say so", async () => {
    const id = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    store.db.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
        VALUES ('job-lipid', 'asha', 'document_read', '${id}', 'done', 1, '[1]', '${NOW}', '${NOW}');
      INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at)
      VALUES ('item-1', 'asha', '${id}', 1, 1, 'job-lipid', 'lab_result',
        '{"test_name":"LDL cholesterol","value_text":"162","unit":"mg/dL"}',
        '{"test_name":"LDL cholesterol","value_text":"162","unit":"mg/dL"}', '${NOW}')`);
    const chips = await transcripts.chips("asha", [
      { type: "document", id },
      { type: "draft_item", id: "item-1" },
      { type: "record", kind: "result", id: "res-a7" },
    ]);
    await transcripts.addMessage(chat, {
      id: "msg-sent",
      kind: "message",
      text: "What does this say?",
      refs: chips,
    });
    const queue = chatQueue(store, () => NOW);
    await queue.accept(
      chat,
      "0199d000-0000-7000-8000-000000000001",
      "And this?",
      [{ type: "document", id }],
    );
    await transcripts.addEvent(chat, {
      kind: "document_read",
      line: "Lab report · 1 result read",
      facts: { document: id, action: "open", results: 1, unsure: 0 },
    });
    // A brief that cites Asha's HbA1c, read from the August report.
    store.db
      .exec(`UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug';
      INSERT INTO transcript_entries (id, person_id, chat_id, seq, kind, text, revision, created_at, updated_at)
        VALUES ('brief-1', 'asha', 'c-asha', 900, 'brief', 'Visit brief', 0, '${NOW}', '${NOW}');
      INSERT INTO briefs (id, person_id, chat_id, call_id, markdown, record_version, cited, created_at)
        VALUES ('brief-1', 'asha', 'c-asha', 'call-brief', 'HbA1c 6.8 %', 0, '[{"kind":"result","id":"res-a1","version":null}]', '${NOW}')`);
    const remover = deleting();

    for (const document of [id, AUG]) {
      await remover.remove(
        "asha",
        document,
        (await remover.preview("asha", document))?.version ?? "",
      );
    }

    const page = await transcripts.page(chat);
    const sent = page.entries.find((e) => e.id === "msg-sent");
    expect(sent?.refs?.map((c) => [c.label, c.deleted])).toEqual([
      ["lipid.pdf", true],
      ["LDL cholesterol 162 mg/dL", true],
      ["Vitamin D 22 ng/mL · May 2026", undefined],
    ]);
    const line = page.entries.find((e) => e.text.startsWith("Lab report"));
    expect(line?.link).toBeUndefined();
    const [waiting] = (await queue.list(chat)).items;
    expect(waiting?.refs.map((c) => c.deleted)).toEqual([true]);
    // In the box, it is refused, saying why.
    const box = openDrafts(store, () => NOW);
    await expect(
      box.save(chat, "Again", [{ type: "document", id }]),
    ).rejects.toThrow(
      new RefRefusal(
        "A document added to this message was deleted. Take it out of the message.",
      ),
    );
    const brief = await readBrief(store.query, "asha", "brief-1");
    expect(brief?.sources[0]?.from).toBe(
      "Sunrise Labs report, collected 12 Aug 2026 · Document deleted (Sunrise Labs August.pdf, page 1)",
    );
    expect(stopped).toEqual([id, AUG]);
  });
});

describe("the bytes", () => {
  it("left by a delete Rufi stopped before removing them go at the next start: the original and both caches; another's stay", async () => {
    store.db.exec(
      "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug'",
    );
    const heic = await add("asha", "sideways.heic", "sideways.heic");
    const [{ file_id: heicFile = "" } = {}] = rows(
      "SELECT file_id FROM document_pages WHERE document_id = ?",
      heic,
    ) as { file_id?: string }[];
    const service = pages(store, home, gate);
    await service.page("asha", AUG, 1);
    await service.page("ravi", "doc-ravi-jul", 1);
    expect(await there(pagePath(home, AUG_FILE, 1))).toBe(true);
    expect(await there(displayPath(home, heicFile))).toBe(true);
    await writeFile(
      join(
        home,
        "files",
        `${AUG_FILE}.0199d000-0000-7000-8000-000000000002.tmp`,
      ),
      "half",
    );
    await writeFile(join(home, "files", "notes.txt"), "not Rufi's");
    // Rufi stops between the commit and the removal.
    const stopping: FileGate = {
      ...fileGate(),
      exclusive: () => Promise.reject(new Error("Rufi stopped.")),
    };
    const remover = deleting({ gate: stopping });
    for (const document of [AUG, heic]) {
      await remover.remove(
        "asha",
        document,
        (await remover.preview("asha", document))?.version ?? "",
      );
    }
    expect(logged).toEqual([
      "documents.cleanup_failed",
      "documents.cleanup_failed",
    ]);
    expect(await there(originalPath(home, AUG_FILE))).toBe(true);

    await sweepFiles(store, home);

    for (const path of [
      originalPath(home, AUG_FILE),
      pagePath(home, AUG_FILE, 1),
      originalPath(home, heicFile),
      displayPath(home, heicFile),
    ]) {
      expect(await there(path)).toBe(false);
    }
    expect(await there(originalPath(home, RAVI_FILE))).toBe(true);
    expect(await there(pagePath(home, RAVI_FILE, 1))).toBe(true);
    expect((await readdir(join(home, "files"))).sort()).toEqual(
      [SEP_FILE, RAVI_FILE, "notes.txt"].sort(),
    );
  });

  it("a backup and an export made beside a delete both pass their checks; a backup after it holds none of its bytes", async () => {
    store.db.exec(
      "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug'",
    );
    const remover = deleting();
    const version = (await remover.preview("asha", AUG))?.version ?? "";
    const { exportZip } = await import("../store/export.ts");
    let copying: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      copying = resolve;
    });
    const { backup } = await import("node:sqlite");

    // The backup has its copy of the database when the delete commits.
    const during = makeBackup(home, new Date(NOW), {
      gate,
      copy: async (...args) => {
        const made = await backup(...args);
        copying();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return made;
      },
    });
    await slow;
    const exported = exportZip(home, new Date(NOW), gate);
    await remover.remove("asha", AUG, version);

    const made = await during;
    await verifyBackup(join(home, "backups", made.name));
    const zip = await exported;
    expect(zip.size).toBeGreaterThan(0);
    await zip.remove();
    const after = await makeBackup(home, new Date("2026-10-12T09:00:00Z"), {
      gate,
    });
    expect(
      await readdir(join(home, "backups", after.name, "files")),
    ).not.toContain(AUG_FILE);
  });

  it("a backup under way holds up neither an add nor a drawn page", async () => {
    let copied: () => void = () => undefined;
    const copying = new Promise<void>((resolve) => {
      copied = resolve;
    });
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { backup } = await import("node:sqlite");
    const during = makeBackup(home, new Date(NOW), {
      gate,
      copy: async (...args) => {
        const made = await backup(...args);
        copied();
        await held;
        return made;
      },
    });
    await copying;

    const added = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    const drawn = await pages(store, home, gate).page("asha", AUG, 2);

    expect((await docs.list("asha")).map((d) => d.id)).toContain(added);
    expect(drawn?.ok).toBe(true);
    expect(await there(pagePath(home, AUG_FILE, 2))).toBe(true);
    finish();
    const made = await during;
    await verifyBackup(join(home, "backups", made.name));
  });

  it("a file added again by another person while a delete waits stays, and its backup reads", async () => {
    store.db.exec(
      "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug'",
    );
    const remover = deleting();
    const version = (await remover.preview("asha", AUG))?.version ?? "";
    // Another removal holds the gate, so Ravi's add of the same bytes waits,
    // and the delete's removal waits behind it.
    let free: () => void = () => undefined;
    const busy = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          free = resolve;
        }),
    );
    const ravis = add("ravi", "sunrise-labs-august.pdf", "from Asha.pdf");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleted = remover.remove("asha", AUG, version);
    await new Promise((resolve) => setTimeout(resolve, 20));
    free();
    await busy;
    const ravisDocument = await ravis;
    await deleted;

    expect(await there(originalPath(home, AUG_FILE))).toBe(true);
    expect(
      (await pages(store, home, gate).page("ravi", ravisDocument, 1))?.ok,
    ).toBe(true);
    const made = await makeBackup(home, new Date(NOW), { gate });
    await verifyBackup(join(home, "backups", made.name));
  });

  it("a page drawn from a file a delete removed meanwhile is not kept", async () => {
    store.db.exec(
      "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug'",
    );
    const remover = deleting();
    await remover.remove(
      "asha",
      AUG,
      (await remover.preview("asha", AUG))?.version ?? "",
    );
    const kept: string[] = [];
    const publish = publisher(store, gate);

    // A render that started before the delete ends after it.
    await publish(AUG_FILE, async () => {
      kept.push(AUG_FILE);
      await mkdir(join(home, "cache"), { recursive: true });
    });
    await publish(RAVI_FILE, () => {
      kept.push(RAVI_FILE);
      return Promise.resolve();
    });

    expect(kept).toEqual([RAVI_FILE]);
  });
});

describe("a document Rufi AI split from an add", () => {
  /** pile.pdf, two pages, split in two by Rufi AI's sort. */
  async function split() {
    store.db.exec(`
      INSERT INTO files (id, size, media_type, created_at) VALUES ('f-pile', 1, 'application/pdf', '${NOW}');
      INSERT INTO documents (id, person_id, added_at, added_from, version, sent_at) VALUES ('pile', 'asha', '${NOW}', 'documents_page', 1, '${NOW}');
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
        VALUES ('job-pile', 'asha', 'document_read', 'pile', 'done', 1, '[1,2]', '${NOW}', '${NOW}');
      INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name, state, entry_job_id, entry_attempt) VALUES
        ('asha', 'pile', 1, 'f-pile', 1, 'pile.pdf', 'read', 'job-pile', 1),
        ('asha', 'pile', 2, 'f-pile', 2, 'pile.pdf', 'read', 'job-pile', 1);
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at) VALUES
        ('asha', 'f-pile', 1, 'job-pile', 1, 'read', '| HbA1c | 6.9 | % |', '${NOW}'),
        ('asha', 'f-pile', 2, 'job-pile', 1, 'read', '| TSH | 2.3 | mIU/L |', '${NOW}');
    `);
    await sorting(store, () => NOW).sort(
      {
        personId: "asha",
        chatId: "c-asha",
        agentTurnId: "t-1",
        callId: "call-split",
      },
      {
        document: "pile",
        documents: [
          { id: "pile", pages: [1], kind: "lab_report" },
          { pages: [2], kind: "lab_report" },
        ],
        drafts: [
          {
            page: 1,
            reading: "job-pile",
            test_name: "HbA1c",
            value_text: "6.9",
            quote: "HbA1c | 6.9",
          },
          {
            page: 2,
            reading: "job-pile",
            test_name: "TSH",
            value_text: "2.3",
            quote: "TSH | 2.3",
          },
        ],
      },
    );
    const child = String(
      rows("SELECT id FROM documents WHERE from_document = 'pile'")[0]?.["id"],
    );
    return { child };
  }
  const left = () => ({
    documents: rows(
      "SELECT id, deleted_at IS NOT NULL AS deleted FROM documents WHERE id = 'pile' OR from_document = 'pile' ORDER BY rowid",
    ),
    pages: rows(
      "SELECT document_id, position FROM document_pages WHERE file_name = 'pile.pdf' AND file_id IS NOT NULL ORDER BY position",
    ),
    drafts: rows(
      "SELECT document_id, json_extract(fields, '$.test_name') AS test FROM draft_items WHERE job_id = 'job-pile' ORDER BY page",
    ),
    copies: rows(
      "SELECT page_in_file FROM page_copies WHERE job_id = 'job-pile' ORDER BY page_in_file",
    ),
    readings: rows("SELECT id FROM jobs WHERE id = 'job-pile'"),
  });

  it.each(["the split one first", "the add first"])(
    "deleted one at a time, %s: the other stays whole with its page, draft and copy, until it goes too",
    async (order) => {
      const { child } = await split();
      const [first, second] =
        order === "the add first" ? ["pile", child] : [child, "pile"];
      const remover = deleting();
      const preview = await remover.preview("asha", first);
      // The file stays while the other document uses it.
      expect(preview).toMatchObject({
        place: `page ${first === "pile" ? "1" : "2"} of 2`,
        others: 1,
      });
      await remover.remove("asha", first, preview?.version ?? "");
      const stays = second === "pile" ? 1 : 2;
      const kept = left();
      expect(kept.pages).toEqual([{ document_id: second, position: stays }]);
      expect(kept.drafts).toEqual([
        { document_id: second, test: stays === 1 ? "HbA1c" : "TSH" },
      ]);
      expect(kept.copies).toEqual([{ page_in_file: stays }]);
      expect(kept.readings).toEqual([{ id: "job-pile" }]);
      expect((await docs.list("asha")).filter((d) => d.id === second)).toEqual([
        expect.objectContaining({ status: "done", notSorted: false }),
      ]);

      expect(await remover.preview("asha", second)).toMatchObject({
        place: `page ${String(stays)} of 2`,
        others: 0,
      });
      await remover.remove(
        "asha",
        second,
        (await remover.preview("asha", second))?.version ?? "",
      );
      expect(left()).toMatchObject({
        pages: [],
        drafts: [],
        copies: [],
        readings: [],
      });
      expect(
        (await docs.list("asha")).filter(
          (d) => d.id === "pile" || d.id === child,
        ),
      ).toEqual([]);
    },
  );

  it("takes the AI's notes on it and on its add, from every day; another document's stay", async () => {
    const { child } = await split();
    const notes = [
      `2026-10-10/pile.md`,
      `2026-10-11/pile.md`,
      `2026-10-11/${child}.md`,
      "2026-10-11/doc-asha-sep.md",
    ];
    for (const path of notes) {
      await mkdir(join(workPath(home), path, ".."), { recursive: true });
      await writeFile(join(workPath(home), path), "## Page 1");
    }
    const remover = deleting();

    await remover.remove(
      "asha",
      child,
      (await remover.preview("asha", child))?.version ?? "",
    );

    for (const path of notes) {
      expect(await there(join(workPath(home), path))).toBe(
        path.endsWith("doc-asha-sep.md"),
      );
    }
  });
});
