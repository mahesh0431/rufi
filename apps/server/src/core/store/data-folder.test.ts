// Which data folder Rufi opens. Every case runs in a scratch home folder
// under the temp folder: the real ~/.rufi is never touched.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
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
import { markerPath } from "./install.ts";
import { moveData } from "./move.ts";

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
});

describe("an older Rufi app's ~/.rufi", () => {
  it("stops the first start and changes nothing in it", async () => {
    const old = join(userHome, ".rufi");
    await mkdir(join(old, "records"), { recursive: true });
    await writeFile(join(old, "rufi.db"), "the older app's");

    await expect(findDataFolder(place())).rejects.toThrow(
      `${old} holds files that aren't this Rufi's home, perhaps from an older Rufi app. Rufi changed nothing there. Move that folder away (for example to ${old}-old)`,
    );
    await expect(moveData(place(), join(userHome, "new"))).rejects.toThrow(
      "aren't this Rufi's home",
    );
    expect((await readdir(old)).sort()).toEqual(["records", "rufi.db"]);
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
