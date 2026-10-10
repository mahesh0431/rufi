// A private JSON file is replaced in one step, also when one Rufi writes it
// twice at the same time: each write has its own temp file.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readJson, writePrivateJson } from "./files.ts";

it("two writes of the same file at the same time both succeed, and the file holds one of them", async () => {
  const folder = await mkdtemp(join(tmpdir(), "rufi-files-"));
  const path = join(folder, "models.json");

  await Promise.all([
    writePrivateJson(path, { model: "first" }),
    writePrivateJson(path, { model: "second" }),
  ]);

  expect([{ model: "first" }, { model: "second" }]).toContainEqual(
    await readJson(path),
  );
  expect(await readdir(folder)).toEqual(["models.json"]);
});
