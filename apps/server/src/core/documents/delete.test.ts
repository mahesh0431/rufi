// Deleting a document on a real database and real files, with the
// fictional family: what blocks it, what goes and what stays, the chat's
// chips and the brief's sources after it, a shared file, adding the same
// file again, a stale preview, and the bytes a delete leaves when Rufi stops
// between its commit and its removal.
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
import { chatCaller } from "../tools/tools.ts";
import { deletions, StalePreview, sweepFiles } from "./delete.ts";
import { documents, type Documents } from "./documents.ts";
import { fileGate, type FileGate } from "./gate.ts";
import { displayPath, originalPath, pagePath } from "./originals.ts";
import { pages, publisher } from "./pages.ts";
import { readings } from "./reading.ts";

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
  await transcripts.addMessage(chat, { id, kind: "message", text: said });
  const answer = await chatCaller(reader, transcripts, () => undefined)(
    chat,
    "t-1",
    "person",
  )("save_changes", { changes }, `call-${id}`);
  expect(answer.text).not.toContain('"issues"');
  expect(answer.ok).toBe(true);
}

/** Adds a file from the fixtures for a person; returns its new document. */
async function add(personId: string, file: string, name = file) {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, file)));
  const { added } = await docs.add(personId, [{ name, bytes }], true);
  return added[0] ?? "";
}

beforeEach(async () => {
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
});

describe("a document with saved results", () => {
  it("can't be deleted: the preview lists each result not removed, a replaced one too, and a delete changes nothing", async () => {
    // CRP was removed before: it doesn't block.
    store.db.exec("UPDATE results SET removed = 1 WHERE id = 'res-a3'");
    const remover = deleting();

    const preview = await remover.preview("asha", AUG);

    expect(preview?.blocking).toEqual([
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
    ]);
    const before = rows("SELECT * FROM documents");
    await expect(
      remover.remove("asha", AUG, preview?.version ?? ""),
    ).rejects.toBeInstanceOf(StalePreview);
    expect(rows("SELECT * FROM documents")).toEqual(before);
    expect(await there(originalPath(home, AUG_FILE))).toBe(true);
  });

  it("goes once the chat removed them or took the document off them: the history reads, and a result the user also typed stays", async () => {
    // Vitamin D, typed in the chat, was also saved as read from page 2;
    // then the document was taken off it.
    store.db.exec(
      `INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES ('asha', 'result', 'res-a7', 'document_page', '${AUG}', 2)`,
    );
    await save("That report isn't mine: take it off my vitamin D", [
      {
        kind: "result",
        action: "remove_source",
        id: "res-a7",
        source: "That report isn't mine: take it off my vitamin D",
        from: { document: AUG, page: 2 },
      },
    ]);
    await save(
      "And remove the results it gave",
      ["res-a1", "res-a2", "res-a3", "res-a4"].map((id) => ({
        kind: "result",
        action: "remove",
        id,
        source: "And remove the results it gave",
      })),
    );
    const views = recordViews(reader, () => new Date(NOW));
    const history = (await views.detail("asha", "result", "res-a1"))?.history;
    const remover = deleting();
    const preview = await remover.preview("asha", AUG);
    expect(preview?.blocking).toEqual([]);

    await remover.remove("asha", AUG, preview?.version ?? "");

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
    // The record and its history are as they were; the source says deleted.
    const removed = await views.detail("asha", "result", "res-a1");
    expect(removed?.history).toEqual(history);
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
    const call = chatCaller(reader, transcripts, () => undefined)(
      chat,
      "t-1",
      "person",
    );
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
        source: "Undo that for HbA1c",
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
    expect((refused as StalePreview).preview.blocking.map((b) => b.id)).toEqual(
      ["res-a7"],
    );
    expect(rows("SELECT deleted_at FROM documents WHERE id = ?", id)).toEqual([
      { deleted_at: null },
    ]);
    expect(
      rows("SELECT text FROM transcript_entries WHERE kind = 'event'"),
    ).toEqual([]);

    store.db.exec(`DELETE FROM record_sources WHERE document_id = '${id}'`);
    const fresh = await remover.preview("asha", id);
    await remover.remove("asha", id, fresh?.version ?? "");
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

  it("marks the chat's chips of the document and its draft items as deleted, takes Open off its reading's line, and brief sources say so", async () => {
    const id = await add("asha", "ravi-lipid-panel.pdf", "lipid.pdf");
    const [job] = rows("SELECT id FROM jobs WHERE document_id = ?", id);
    store.db
      .exec(`INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at)
      VALUES ('item-1', 'asha', '${id}', 1, 1, '${String(job?.["id"])}', 'lab_result',
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
    expect((await exported).bytes.byteLength).toBeGreaterThan(0);
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
