// The working folder's clean-up on real files, with the fictional family:
// days older than 3 go, the notes on a deleted document go from the days
// that stay, and nothing else is touched.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { databasePath, openWritable } from "./database.ts";
import { cleanWork, workPath } from "./work.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);

it("removes the days older than 3 and a deleted document's notes; the rest stays", async () => {
  const home = await mkdtemp(join(tmpdir(), "rufi-work-"));
  const store = openWritable(databasePath(home));
  store.db.exec(family);
  store.db.exec(
    "UPDATE documents SET deleted_at = '2026-10-29T10:00:00Z' WHERE id = 'doc-asha-sep'",
  );
  const work = workPath(home);
  const files = {
    "2026-10-26/doc-asha-aug.md": "## Page 1",
    "2026-10-27/plan.md": "A sub-agent's plan",
    "2026-10-30/doc-asha-aug.md": "## Page 1",
    "2026-10-30/doc-asha-sep.md": "## Page 1",
    "drafts/old.md": "Not a day",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), text);
  }

  await cleanWork(store, home, "2026-10-30T09:00:00.000Z");

  const left = await readdir(work, { recursive: true });
  expect(left.filter((path) => path.endsWith(".md")).sort()).toEqual([
    join("2026-10-27", "plan.md"),
    join("2026-10-30", "doc-asha-aug.md"),
    join("drafts", "old.md"),
  ]);
  store.close();
});
