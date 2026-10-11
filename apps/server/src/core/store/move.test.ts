// Moving the data folder, in a scratch Mac home: a full move keeps the whole
// record and retires the old folder; refusals change nothing; a move that
// stopped at any step is refused at start and ends with --finish or --cancel.
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySecrets } from "../../../tests/fakes.ts";
import { status } from "../../agent/chatgpt/session.ts";
import { holdRufiLock, writePrivateJson } from "../../platform/files.ts";
import { documents } from "../documents/documents.ts";
import { backupsPath, makeBackup } from "./backup.ts";
import {
  findDataFolder,
  locationRoot,
  MOVED_TO,
  MOVING_IN,
  MOVING_OUT,
} from "./data-folder.ts";
import { databasePath, openWritable } from "./database.ts";
import { cancelMove, finishMove, moveData } from "./move.ts";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");
const HOST = "urn:uuid:0b6f2c3e-1f1a-4c55-9a43-0d6c1f3f9e10";

let userHome: string;
let root: string;
let from: string;
let to: string;
const place = (env: NodeJS.ProcessEnv = {}) => ({ env, userHome });
const secrets = memorySecrets();
const releases: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) await release();
});

/**
 * A data folder as Rufi leaves it: a person and her chat on an AI thread, a
 * document's original, a backup, the sign-in, the AI's and workspace files,
 * a log, and a running Rufi's address; Amir was saved last, still in the
 * database's WAL, as a crash leaves it.
 */
beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "rufi-move-"));
  root = locationRoot(userHome);
  from = (await findDataFolder(place())).path;
  to = join(userHome, "Rufi data");
  const db = new DatabaseSync(databasePath(from));
  db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, thread_id, thread_provider, thread_model, thread_tools, created_at)
      VALUES ('chat-asha', 'asha', 'thread-1', 'codex', 'gpt-5.5', 'tools-1', '2026-10-01T09:00:00Z');
  `);
  db.close();
  const name = "sunrise-labs-august.pdf";
  const store = openWritable(databasePath(from));
  await documents(store, from).add(
    "asha",
    [{ name, bytes: new Uint8Array(await readFile(join(FIXTURES, name))) }],
    true,
  );
  store.close();
  await makeBackup(from, new Date("2026-10-08T09:14:03Z"));
  await writePrivateJson(join(from, "chatgpt.json"), {
    hostId: HOST,
    clientId: "oaiapp_fictional",
    subject: "user-fictional",
    email: "asha@example.com",
  });
  secrets.values.set(
    HOST,
    JSON.stringify({
      clientId: "oaiapp_fictional",
      subject: "user-fictional",
      scopes: ["openid"],
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  for (const [path, text] of [
    ["workspace/notes.md", "fictional notes"],
    ["logs/rufi.log", '{"event":"core.started"}\n'],
    ["codex/sessions/rollout.jsonl", "{}"],
    ["core.json", '{"port":1}'],
  ] as const) {
    await mkdir(join(from, path, ".."), { recursive: true });
    await writeFile(join(from, path), text);
  }
  await saveInWal(
    from,
    "INSERT INTO people (id, display_name) VALUES ('amir', 'Amir Fictional')",
  );
});

/** Runs `sql` and leaves it only in the WAL, as a crashed Rufi does. */
async function saveInWal(folder: string, sql: string): Promise<void> {
  const db = new DatabaseSync(databasePath(folder));
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec(sql);
  const crashed = await mkdtemp(join(tmpdir(), "rufi-crashed-"));
  for (const suffix of ["", "-wal"]) {
    await copyFile(databasePath(folder) + suffix, join(crashed, `db${suffix}`));
  }
  db.close();
  for (const suffix of ["", "-wal"]) {
    await copyFile(join(crashed, `db${suffix}`), databasePath(folder) + suffix);
  }
}

const people = (folder: string) => {
  const db = new DatabaseSync(databasePath(folder), { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM people ORDER BY id")
      .all()
      .map((row) => row["id"]);
  } finally {
    db.close();
  }
};
const location = async () =>
  JSON.parse(await readFile(join(root, "location.json"), "utf8")) as unknown;

describe("a move", () => {
  it("keeps the whole record, the sign-in and the backups, and retires the old folder", async () => {
    await moveData(place(), to);

    expect(await findDataFolder(place())).toEqual({
      path: to,
      source: "moved",
    });
    expect(await location()).toEqual({ version: 1, dataFolder: to });
    // Amir was only in the WAL: the copy has him, and no WAL of its own.
    expect(people(to)).toEqual(["amir", "asha"]);
    expect(await readdir(to)).not.toContain("rufi.sqlite-wal");
    expect(await readdir(join(to, "files"))).toEqual(
      await readdir(join(from, "files")),
    );
    expect(await readdir(backupsPath(to))).toEqual(
      await readdir(backupsPath(from)),
    );
    expect(await readFile(join(to, "workspace/notes.md"), "utf8")).toBe(
      "fictional notes",
    );
    expect(await readdir(join(to, "logs"))).toEqual(["rufi.log"]);
    // Still signed in: the Keychain entry is under the host id, not the folder.
    const now = await status({
      home: to,
      secrets,
      issuer: "",
      sleep: () => Promise.resolve(),
    });
    expect(now).toMatchObject({ signedIn: true, email: "asha@example.com" });
    // The AI's own files and the old Rufi's address stay behind; the chat
    // goes on in a fresh AI thread.
    expect(await readdir(to)).not.toContain("codex");
    expect(await readdir(to)).not.toContain("core.json");
    const db = new DatabaseSync(databasePath(to), { readOnly: true });
    expect(
      db.prepare("SELECT thread_id, thread_model FROM chats").all(),
    ).toEqual([{ thread_id: null, thread_model: null }]);
    db.close();
    // The old folder is kept, and won't open.
    expect(people(from)).toEqual(["amir", "asha"]);
    await expect(findDataFolder(place({ RUFI_HOME: from }))).rejects.toThrow(
      `Rufi's data moved from ${from} to ${to}`,
    );
    await expect(finishMove(place())).rejects.toThrow(
      `There's no move to finish: Rufi uses ${to}`,
    );
    await expect(cancelMove(place())).rejects.toThrow(
      `There's no move to cancel: Rufi uses ${to}`,
    );
  });

  it.each([
    [
      "while Rufi runs",
      async () => void releases.push(await holdRufiLock(from, () => undefined)),
      "already running",
    ],
    [
      "into a folder that isn't empty",
      async () => {
        await mkdir(to);
        await writeFile(join(to, "mine.txt"), "mine");
      },
      "isn't empty",
    ],
    [
      "into itself",
      () => Promise.resolve(void (to = join(from, "inside"))),
      "Choose a folder outside it",
    ],
    [
      "into iCloud Drive",
      () =>
        Promise.resolve(
          void (to = join(
            userHome,
            "Library/Mobile Documents/com~apple~CloudDocs/Rufi",
          )),
        ),
      "is in iCloud Drive or a cloud folder",
    ],
    [
      "into a cloud folder",
      () =>
        Promise.resolve(
          void (to = join(userHome, "Library/CloudStorage/Dropbox/Rufi")),
        ),
      "is in iCloud Drive or a cloud folder",
    ],
  ])("is refused %s, and changes nothing", async (_when, arrange, says) => {
    await arrange();

    await expect(moveData(place(), to)).rejects.toThrow(says);

    expect(await location()).toEqual({ version: 1, dataFolder: from });
    expect(await readdir(from)).not.toContain(MOVING_OUT);
  });

  it("is refused with RUFI_HOME set, the demo's folder too", async () => {
    await expect(moveData(place({ RUFI_HOME: from }), to)).rejects.toThrow(
      "Unset RUFI_HOME",
    );
    await expect(finishMove(place({ RUFI_HOME: from }))).rejects.toThrow(
      "Unset RUFI_HOME",
    );
  });

  it("that fails while copying keeps the old folder in use and the new one closed", async () => {
    await symlink("/etc/hosts", join(from, "workspace", "link"));

    await expect(moveData(place(), to)).rejects.toThrow(
      `Rufi didn't move your data, and still uses ${from}. Rufi can't move ${join(from, "workspace/link")}: it's a link`,
    );

    expect(await findDataFolder(place())).toEqual({
      path: from,
      source: "default",
    });
    await expect(findDataFolder(place({ RUFI_HOME: to }))).rejects.toThrow(
      "a cancelled move",
    );
  });
});

describe("a move that stopped", () => {
  /** A finished move, taken back to the state a crash at an earlier step leaves. */
  async function stoppedAt(step: "copying" | "switching"): Promise<void> {
    await moveData(place(), to);
    await writePrivateJson(join(root, "location.json"), {
      version: 1,
      dataFolder: from,
    });
    if (step === "copying") {
      await rename(join(from, MOVED_TO), join(from, MOVING_OUT));
      await writePrivateJson(join(to, MOVING_IN), { folder: from });
    }
  }

  it.each(["copying", "switching"] as const)(
    "while %s is refused at start, also through RUFI_HOME",
    async (step) => {
      await stoppedAt(step);

      await expect(findDataFolder(place())).rejects.toThrow(
        "pnpm rufi move-data --finish",
      );
      await expect(findDataFolder(place({ RUFI_HOME: from }))).rejects.toThrow(
        step === "copying" ? "--finish" : "Rufi uses that folder now",
      );
      if (step === "copying") {
        await expect(findDataFolder(place({ RUFI_HOME: to }))).rejects.toThrow(
          "--finish",
        );
      }
    },
  );

  it.each(["copying", "switching"] as const)(
    "while %s finishes with --finish once the copy checks again",
    async (step) => {
      await stoppedAt(step);

      await expect(finishMove(place())).resolves.toEqual({ from, to });

      expect(await findDataFolder(place())).toEqual({
        path: to,
        source: "moved",
      });
      await expect(findDataFolder(place({ RUFI_HOME: from }))).rejects.toThrow(
        "Rufi uses that folder now",
      );
    },
  );

  it.each(["copying", "switching"] as const)(
    "while %s goes back to the old folder with --cancel, keeping both",
    async (step) => {
      await stoppedAt(step);

      await expect(cancelMove(place())).resolves.toEqual({ from, to });

      expect(await findDataFolder(place())).toEqual({
        path: from,
        source: "default",
      });
      expect(people(from)).toEqual(["amir", "asha"]);
      await expect(findDataFolder(place({ RUFI_HOME: to }))).rejects.toThrow(
        "a cancelled move",
      );
      expect(people(to)).toEqual(["amir", "asha"]);
      await expect(finishMove(place())).rejects.toThrow(
        `There's no move to finish: Rufi uses ${from}`,
      );
    },
  );

  it("before the copy was complete can't be finished, only cancelled", async () => {
    await stoppedAt("copying");
    const [original] = await readdir(join(to, "files"));
    await rm(join(to, "files", original ?? ""));
    await rm(join(to, "workspace", "notes.md"));

    await expect(finishMove(place())).rejects.toThrow(
      `The copy in ${to} isn't complete, so Rufi can't finish the move.`,
    );
    expect(await location()).toEqual({ version: 1, dataFolder: from });

    await cancelMove(place());
    expect(await findDataFolder(place())).toEqual({
      path: from,
      source: "default",
    });
  });
});
