// The working folder's clean-up on real files, with the fictional family:
// days older than 3 go, the notes on a deleted document go from the days
// that stay, and nothing else is touched, also through a link the AI made.
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { databasePath, openWritable } from "./database.ts";
import { cleanWork, workPath } from "./work.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);

/** Files outside the working folder, for links to point at. */
async function outside(files: Record<string, string>) {
  const folder = await mkdtemp(join(tmpdir(), "rufi-outside-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  return folder;
}

const there = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

it("removes the days older than 3 and a deleted document's notes; the rest stays, and it never goes through a link", async () => {
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
  // Days that are links to folders elsewhere: a recent one, with a deleted
  // document's notes, and an old one.
  const elsewhere = await outside({
    "recent/doc-asha-sep.md": "## Page 1",
    "old/plan.md": "Kept elsewhere",
  });
  await symlink(join(elsewhere, "recent"), join(work, "2026-10-29"));
  await symlink(join(elsewhere, "old"), join(work, "2026-10-20"));

  await cleanWork(store, home, "2026-10-30T09:00:00.000Z");

  // Listed through the recent link too, which Rufi doesn't go through.
  const left = await readdir(work, { recursive: true });
  expect(left.filter((path) => path.endsWith(".md")).sort()).toEqual([
    join("2026-10-27", "plan.md"),
    join("2026-10-29", "doc-asha-sep.md"),
    join("2026-10-30", "doc-asha-aug.md"),
    join("drafts", "old.md"),
  ]);
  // The old link goes, not what it points at; the recent one stays.
  expect(await there(join(work, "2026-10-20"))).toBe(false);
  expect(await there(join(work, "2026-10-29"))).toBe(true);
  for (const path of ["recent/doc-asha-sep.md", "old/plan.md"]) {
    expect(await there(join(elsewhere, path))).toBe(true);
  }

  // The working folder itself a link: nothing it points at goes.
  const linked = await mkdtemp(join(tmpdir(), "rufi-work-"));
  const days = await outside({ "2026-10-25/plan.md": "Kept elsewhere" });
  await mkdir(join(linked, "ai"), { recursive: true });
  await symlink(days, workPath(linked));
  await cleanWork(store, linked, "2026-10-30T09:00:00.000Z");
  expect(await there(join(days, "2026-10-25", "plan.md"))).toBe(true);
  store.close();
});
