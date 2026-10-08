// The demo reset on real files: the record is replaced with the golden data
// set and the sign-in's registration stays; a folder that isn't the demo
// folder, or one Rufi runs on, is left as it was.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { transcripts, type ChatRow } from "../src/core/chat/transcript.ts";
import { databasePath, openWritable } from "../src/core/store/database.ts";
import { holdRufiLock } from "../src/platform/files.ts";
import { demoFolder, resetDemo } from "./demo-folder.ts";

const TODAY = new Date("2026-10-08T12:00:00Z");
const REGISTRATION = '{"hostId":"urn:uuid:fictional"}\n';

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rufi-demo-"));
  folder = demoFolder(root);
});

/** A demo folder after a run: signed in, with its own changes and files. */
async function used() {
  await resetDemo(folder, {}, TODAY);
  await writeFile(join(folder, "chatgpt.json"), REGISTRATION);
  const store = openWritable(databasePath(folder));
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('old', 'Old Fictional')",
  );
  store.close();
  for (const made of ["backups", "logs", "codex", "workspace"]) {
    await mkdir(join(folder, made));
    await writeFile(join(folder, made, "left.txt"), "from the last run");
  }
  await writeFile(join(folder, "models.json"), '{"models":["fictional"]}');
}

const people = (home: string) => {
  const store = openWritable(databasePath(home));
  try {
    return store.db
      .prepare("SELECT display_name FROM people ORDER BY display_name")
      .all()
      .map((row) => row["display_name"]);
  } finally {
    store.close();
  }
};

describe("pnpm demo's reset", () => {
  it("replaces the record and everything from the last run, and keeps the sign-in's registration", async () => {
    await used();

    await resetDemo(folder, {}, TODAY);

    expect((await readdir(folder)).sort()).toEqual([
      "chatgpt.json",
      "demo.json",
      "installed.json",
      "rufi.sqlite",
    ]);
    expect(await readFile(join(folder, "chatgpt.json"), "utf8")).toBe(
      REGISTRATION,
    );
    expect(people(folder)).toEqual(["Asha Fictional", "Ravi Fictional"]);
  });

  it("opens past first run, with the emergency region set and Asha's chat over three days, one change saved with its receipt", async () => {
    await resetDemo(folder, { RUFI_HOME: folder }, TODAY);

    const store = openWritable(databasePath(folder));
    try {
      const chats = transcripts(store);
      expect(await chats.setting("first_run.done")).toBeDefined();
      expect(await chats.setting("emergency_region")).toBe("IN");
      const chat = (await chats.chat("asha")) as ChatRow;
      const { entries, turns } = await chats.page(chat);
      expect(
        entries
          .filter((entry) => entry.kind === "message")
          .map((entry) => entry.text),
      ).toEqual([
        "What did my August blood test show?",
        "I started magnesium 200 mg at night two days ago",
        "Yes, save it",
        "Is my TSH something to worry about?",
      ]);
      const days = new Set(
        entries.map((entry) => new Date(entry.createdAt).toDateString()),
      );
      expect(days.size).toBe(3);
      expect(turns.map((turn) => turn.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
      expect(turns[0]?.used.map((read) => read.title)).toEqual([
        "Read your overview",
      ]);
      expect(turns[0]?.how).toContain("Sunrise Labs");

      const receipts = entries.filter((entry) => entry.kind === "receipt");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.text).toContain("Magnesium");
      const saved = store.db
        .prepare(
          "SELECT name, started, started_words, source_entry_id FROM medicine_uses WHERE person_id = 'asha' AND name = 'Magnesium'",
        )
        .get();
      const said = entries.find((entry) =>
        entry.text.startsWith("I started magnesium"),
      );
      expect(saved).toEqual({
        name: "Magnesium",
        started: "2026-10-03",
        started_words: "two days ago",
        source_entry_id: said?.id,
      });
    } finally {
      store.close();
    }
  });

  it("refuses when RUFI_HOME names another folder, and changes nothing", async () => {
    const other = join(root, "other");

    await expect(
      resetDemo(folder, { RUFI_HOME: other }, TODAY),
    ).rejects.toThrow(
      `pnpm demo uses only its own folder, ${folder}, and RUFI_HOME is ${other}.`,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a folder that holds files but isn't a demo folder, and leaves them", async () => {
    await mkdir(folder);
    await writeFile(join(folder, "rufi.sqlite"), "someone's record");

    await expect(resetDemo(folder, {}, TODAY)).rejects.toThrow(
      `${folder} isn't a demo folder`,
    );
    expect(await readdir(folder)).toEqual(["rufi.sqlite"]);
    expect(await readFile(join(folder, "rufi.sqlite"), "utf8")).toBe(
      "someone's record",
    );
  });

  it("refuses while Rufi runs on the demo folder, and leaves its record", async () => {
    await used();
    const release = await holdRufiLock(folder, () => undefined);
    try {
      await expect(resetDemo(folder, {}, TODAY)).rejects.toThrow(
        "Rufi is already running with this data folder",
      );
    } finally {
      await release();
    }
    expect(people(folder)).toEqual([
      "Asha Fictional",
      "Old Fictional",
      "Ravi Fictional",
    ]);
  });
});
