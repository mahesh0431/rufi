// Which data folder Rufi opens. Every case runs in a scratch home folder
// under the temp folder: the real ~/.rufi is never touched.
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findDataFolder,
  locationRoot,
  MOVED_TO,
  MOVING_IN,
  MOVING_OUT,
} from "./data-folder.ts";
import { databasePath, openWritable } from "./database.ts";
import { markerPath, openRecord } from "./install.ts";
import { cancelMove, finishMove, moveData } from "./move.ts";

let userHome: string;
let root: string;
let data: string;
const place = (env: NodeJS.ProcessEnv = {}) => ({ env, userHome });

beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "rufi-place-"));
  root = locationRoot(userHome);
  data = join(root, "data");
});

const location = async () =>
  JSON.parse(await readFile(join(root, "location.json"), "utf8")) as unknown;

describe("the first start", () => {
  it("makes the default folder with its record, private, then remembers it", async () => {
    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });

    expect((await readdir(data)).sort()).toEqual(
      expect.arrayContaining(["installed.json", "rufi.sqlite"]),
    );
    expect((await stat(data)).mode & 0o777).toBe(0o700);
    expect(await location()).toEqual({ version: 1, dataFolder: data });
  });

  it("opens the same folder and record at the next start", async () => {
    await findDataFolder(place());
    const made = await readFile(markerPath(data), "utf8");

    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });
    expect(await readFile(markerPath(data), "utf8")).toBe(made);
  });

  it.each([
    ["before the folder was made", () => Promise.resolve()],
    [
      "after the folder was made, with its lock left",
      async () => {
        await mkdir(join(data, "rufi.lock"), { recursive: true });
        // A crashed process's lock: stale after 10 s.
        const old = new Date(Date.now() - 60_000);
        await utimes(join(data, "rufi.lock"), old, old);
      },
    ],
    [
      "after the database was made, before its marker",
      async () => {
        await mkdir(data, { recursive: true });
        openWritable(databasePath(data)).close();
      },
    ],
  ])("goes on when a first start stopped %s", async (_when, leave) => {
    await leave();

    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });
    expect(await location()).toEqual({ version: 1, dataFolder: data });
    expect(await readdir(data)).toContain("installed.json");
  });

  it("remembers the default record again when only the location file was lost", async () => {
    await findDataFolder(place());
    await rm(join(root, "location.json"));

    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });
    expect(await location()).toEqual({ version: 1, dataFolder: data });
  });

  it("makes nothing in a default folder that holds other files", async () => {
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "notes.txt"), "mine");

    await expect(findDataFolder(place())).rejects.toThrow(
      `${data} holds files but no Rufi record`,
    );
    expect(await readdir(data)).toEqual(["notes.txt"]);
    expect(await readdir(root)).not.toContain("location.json");
  });

  it("makes nothing in a default folder whose record was lost", async () => {
    await findDataFolder(place());
    await rm(join(root, "location.json"));
    await rm(databasePath(data));

    await expect(findDataFolder(place())).rejects.toThrow("no Rufi record");
    expect(await readdir(data)).not.toContain("rufi.sqlite");
  });

  it.each(["default", "RUFI_HOME"] as const)(
    "resumes an owned %s first start after bootstrap filesystem interruptions",
    async (source) => {
      const chosen = source === "default" ? data : join(userHome, "chosen");
      const env = source === "default" ? {} : { RUFI_HOME: chosen };
      for (const point of [
        "creating temp file",
        "empty database",
        "schema transaction",
        "installed temp file",
        "installed marker",
      ]) {
        // Each case is a new first start. Only this child stops at a real
        // filesystem boundary; the resolver and opener are unchanged.
        await rm(root, { recursive: true, force: true });
        await rm(chosen, { recursive: true, force: true });
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          import { basename } from "node:path";
          import { DatabaseSync } from "node:sqlite";
          import { dirname } from "node:path";
          const point = process.argv[3];
          const die = () => process.kill(process.pid, "SIGKILL");
          let creationFolder, installedFolder;
          let creatingDurable = false, installedDurable = false;
          const write = fs.writeFileSync;
          fs.writeFileSync = function(path, ...args) {
            const result = write.call(this, path, ...args);
            if (basename(path) === "rufi.sqlite" && args[0] === "") {
              if (!creatingDurable) throw new Error("Database made before ownership was durable.");
              if (point === "empty database") die();
            }
            return result;
          };
          const open = fs.promises.open;
          const exec = DatabaseSync.prototype.exec;
          DatabaseSync.prototype.exec = function(sql) {
            if (point === "schema transaction" && sql.startsWith("BEGIN; ")) {
              exec.call(this, "PRAGMA cache_size = 1");
              exec.call(this, sql.replace(/COMMIT;$/, ""));
              die();
            }
            return exec.call(this, sql);
          };
          const remove = fs.promises.rm;
          fs.promises.rm = async function(path, ...args) {
            if (basename(path) === "creating.json") {
              if (!installedDurable) throw new Error("Ownership removed before installation was durable.");
              if (point === "installed marker") die();
            }
            return remove.call(this, path, ...args);
          };
          fs.promises.open = async function(path, ...args) {
            const handle = await open.call(this, path, ...args);
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              await sync();
              if (/^creating\\.json\\.[\\w-]+\\.tmp$/.test(basename(path))) creationFolder = dirname(path);
              if (/^installed\\.json\\.[\\w-]+\\.tmp$/.test(basename(path))) installedFolder = dirname(path);
              if (path === creationFolder) creatingDurable = true;
              if (path === installedFolder) installedDurable = true;
              if (point === "creating temp file" && /^creating\\.json\\.[\\w-]+\\.tmp$/.test(basename(path))) die();
              if (point === "installed temp file" && /^installed\\.json\\.[\\w-]+\\.tmp$/.test(basename(path))) die();
            };
            return handle;
          };
          syncBuiltinESMExports();
          const { findDataFolder } = await import(process.argv[1]);
          const { openRecord } = await import(process.argv[2]);
          const { holdRufiLock } = await import(process.argv[4]);
          const folder = await findDataFolder({ env: process.env, userHome: process.env.HOME });
          const release = await holdRufiLock(folder.path, () => {});
          (await openRecord(folder.path)).close();
          await release();
          throw new Error("The first start ended without its crash.");
        `,
            new URL("data-folder.ts", import.meta.url).href,
            new URL("install.ts", import.meta.url).href,
            point,
            new URL("../../platform/files.ts", import.meta.url).href,
          ],
          {
            env: {
              ...process.env,
              HOME: userHome,
              RUFI_HOME: source === "default" ? "" : chosen,
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(child.signal, `${point}: ${child.stderr}`).toBe("SIGKILL");
        if (point === "creating temp file") {
          expect(await readdir(chosen)).not.toContain("rufi.sqlite");
        } else {
          expect(
            await readFile(join(chosen, "creating.json"), "utf8"),
          ).toContain('"version": 1');
        }
        if (point === "installed marker")
          expect(await readdir(chosen)).toContain("installed.json");
        else expect(await readdir(chosen)).not.toContain("installed.json");
        if (point === "schema transaction")
          expect(await readdir(chosen)).toContain("rufi.sqlite-journal");
        if (point === "installed temp file") {
          expect(
            (await readdir(chosen)).some((name) =>
              name.startsWith("installed.json."),
            ),
          ).toBe(true);
        }
        // The crashed process's locks must age before another start owns them.
        const old = new Date(Date.now() - 60_000);
        for (const lock of [
          join(root, "location.lock"),
          join(chosen, "rufi.lock"),
        ]) {
          await utimes(lock, old, old).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
        const folder = await findDataFolder(place(env));
        expect(folder).toEqual({ path: chosen, source });
        const record = await openRecord(chosen);
        expect(
          record.db.prepare("SELECT count(*) AS n FROM people").get(),
        ).toEqual({ n: 0 });
        record.close();
        expect(await readdir(chosen)).not.toContain("creating.json");
        expect(
          (await readdir(chosen)).some((name) =>
            /^(installed|creating)\.json\..+\.tmp$/.test(name),
          ),
        ).toBe(false);
        if (source === "default")
          expect(await location()).toEqual({ version: 1, dataFolder: data });
        else await expect(stat(root)).rejects.toThrow("ENOENT");
      }
    },
    30_000,
  );

  it.each(["unknown", "installed empty", "installed missing", "unowned empty"])(
    "doesn't resume an %s record, also through RUFI_HOME",
    async (state) => {
      await mkdir(data, { recursive: true });
      if (state !== "unowned empty")
        await writeFile(join(data, "creating.json"), '{"version":1}');
      if (state === "unknown") {
        const db = openWritable(databasePath(data));
        db.db.exec(
          "PRAGMA journal_mode = DELETE; CREATE TABLE unknown (id TEXT)",
        );
        db.close();
      } else if (state !== "installed missing")
        await writeFile(databasePath(data), "");
      if (state.startsWith("installed"))
        await writeFile(markerPath(data), "{}");
      const before = (await readdir(data)).sort();
      const database =
        state === "installed missing"
          ? undefined
          : await readFile(databasePath(data));

      const selected = await findDataFolder(place({ RUFI_HOME: data }));
      const refusal =
        state === "unknown"
          ? "isn't a record this Rufi knows"
          : state === "installed missing"
            ? "Rufi's record is missing"
            : "the record is empty";
      await expect(openRecord(selected.path)).rejects.toThrow(refusal);
      await expect(
        findDataFolder(place()).then(async (folder) => {
          (await openRecord(folder.path)).close();
        }),
      ).rejects.toThrow(
        state === "installed missing" ? "no Rufi record" : refusal,
      );
      expect((await readdir(data)).sort()).toEqual(before);
      if (database !== undefined)
        expect(await readFile(databasePath(data))).toEqual(database);
      else expect(await readdir(data)).not.toContain("rufi.sqlite");
    },
  );
});

describe("an older Rufi app's ~/.rufi", () => {
  it("stops the first start and changes nothing in it", async () => {
    const old = join(userHome, ".rufi");
    await mkdir(join(old, "records"), { recursive: true });
    await writeFile(join(old, "rufi.db"), "the older app's");
    // A misplaced guard cannot take even a temporary location.lock here.
    await chmod(old, 0o500);

    await expect(findDataFolder(place())).rejects.toThrow(
      `${old} holds files that aren't this Rufi's home, perhaps from an older Rufi app. Rufi changed nothing there. Move that folder away (for example to ${old}-old)`,
    );
    await expect(
      moveData(place(), join(userHome, "new"), () =>
        Promise.resolve("/dev/disk3s1s1 on / (apfs, local, journaled)\n"),
      ),
    ).rejects.toThrow("aren't this Rufi's home");
    await expect(finishMove(place())).rejects.toThrow(
      "aren't this Rufi's home",
    );
    await expect(cancelMove(place())).rejects.toThrow(
      "aren't this Rufi's home",
    );
    expect((await readdir(old)).sort()).toEqual(["records", "rufi.db"]);
    expect((await stat(old)).mode & 0o777).toBe(0o500);
  });

  it.each(["direct", "alias"])(
    "refuses a %s RUFI_HOME inside the foreign home before reading marks",
    async (kind) => {
      await mkdir(join(root, "records"), { recursive: true });
      await writeFile(join(root, "rufi.db"), "the older app's");
      // Reading any mark would throw a different error.
      await writeFile(join(root, MOVING_OUT), "{");
      const alias = join(userHome, "alias");
      await symlink(root, alias);
      const chosen = kind === "direct" ? root : alias;
      for (const path of [
        chosen,
        join(chosen, "records"),
        join(chosen, "new"),
      ]) {
        await expect(
          findDataFolder(place({ RUFI_HOME: path })),
        ).rejects.toThrow("aren't this Rufi's home");
      }
      expect((await readdir(root)).sort()).toEqual([
        MOVING_OUT,
        "records",
        "rufi.db",
      ]);
      expect(await readFile(join(root, MOVING_OUT), "utf8")).toBe("{");
    },
  );

  it("trusts its location file: what's put beside it later isn't looked at", async () => {
    await findDataFolder(place());
    // The older app run again after this Rufi's first start.
    await writeFile(join(root, "rufi.db"), "the older app's");

    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });
    expect(await readFile(join(root, "rufi.db"), "utf8")).toBe(
      "the older app's",
    );
  });

  it("isn't stopped by the .DS_Store Finder leaves", async () => {
    await mkdir(root);
    await writeFile(join(root, ".DS_Store"), "");

    expect(await findDataFolder(place())).toEqual({
      path: data,
      source: "default",
    });
  });
});

describe("a remembered folder", () => {
  it("that is gone stops Rufi, and nothing is made in its place", async () => {
    await findDataFolder(place());
    // A disk that isn't connected, or a folder deleted.
    await rename(data, join(userHome, "elsewhere"));

    await expect(findDataFolder(place())).rejects.toThrow(
      `Rufi's data folder isn't there: ${data}. If it's on a disk, connect the disk`,
    );
    expect(await readdir(root)).not.toContain("data");
  });

  it("that no longer holds a record stops Rufi", async () => {
    await findDataFolder(place());
    await rm(data, { recursive: true });
    // An empty folder where the disk used to be.
    await mkdir(data);

    await expect(findDataFolder(place())).rejects.toThrow(
      `${data} isn't Rufi's data folder any more`,
    );
    expect(await readdir(data)).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["not a location", JSON.stringify({ version: 2, dataFolder: "/x" })],
    ["a relative folder", JSON.stringify({ version: 1, dataFolder: "x" })],
  ])("in a damaged location file (%s) stops Rufi", async (_what, text) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "location.json"), text);

    await expect(findDataFolder(place())).rejects.toThrow(
      `${join(root, "location.json")} is damaged`,
    );
    expect(await readdir(root)).not.toContain("data");
  });
});

describe("RUFI_HOME", () => {
  it("picks its folder without reading or writing the location file", async () => {
    const chosen = join(userHome, "test-folder");
    // A damaged location file would stop a start that read it.
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "location.json"), "{");

    expect(await findDataFolder(place({ RUFI_HOME: ` ${chosen} ` }))).toEqual({
      path: chosen,
      source: "RUFI_HOME",
    });
    expect(await readdir(root)).toEqual(["location.json"]);
    expect(await readFile(join(root, "location.json"), "utf8")).toBe("{");
  });

  it("when blank is the same as not set", async () => {
    expect(await findDataFolder(place({ RUFI_HOME: "  " }))).toEqual({
      path: data,
      source: "default",
    });
  });
});

describe("a folder a move left", () => {
  const mark = (folder: string, name: string, value: unknown) =>
    writeFile(join(folder, name), JSON.stringify(value));

  it.each([
    [MOVING_OUT, { folder: "/new" }, "the move didn't finish", "didn't finish"],
    [
      MOVED_TO,
      { folder: "/new" },
      "the move didn't finish",
      "Rufi uses that folder now",
    ],
    [MOVING_IN, { folder: "/old" }, "that didn't finish", "that didn't finish"],
    [
      MOVING_IN,
      { folder: "/old", cancelled: true },
      "a cancelled move",
      "a cancelled move",
    ],
  ])(
    "with %s %j is refused, remembered or through RUFI_HOME",
    async (name, value, remembered, chosen) => {
      await findDataFolder(place());
      await mark(data, name, value);

      await expect(findDataFolder(place())).rejects.toThrow(remembered);
      await expect(findDataFolder(place({ RUFI_HOME: data }))).rejects.toThrow(
        chosen,
      );
    },
  );
});
