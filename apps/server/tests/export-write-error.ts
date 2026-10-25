// An export in a process of its own, on a disk that fails a write while
// an original is being read, as a full disk would. Prints what the export
// said and what it left; if the failure ended the process, nothing prints.
// Usage: node export-write-error.ts <data folder with a document>
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { exportZip } from "../src/core/store/export.ts";

const [home = ""] = process.argv.slice(2);
const { write, writev, open } = fs;
type Done = (error: Error | null, written?: number) => void;
const full = Object.assign(new Error("fictional disk full"), {
  code: "ENOSPC",
});
let failed = false;
// The first write fails, later, as the disk answers.
fs.write = ((...args: unknown[]) => {
  const done = args.at(-1) as Done;
  if (failed) {
    (write as (...a: unknown[]) => void)(...args);
    return;
  }
  failed = true;
  setImmediate(() => {
    done(full);
  });
}) as typeof fs.write;
fs.writev = ((...args: unknown[]) => {
  const done = args.at(-1) as Done;
  if (failed) {
    (writev as (...a: unknown[]) => void)(...args);
    return;
  }
  failed = true;
  setImmediate(() => {
    done(full);
  });
}) as typeof fs.writev;
// An original opens slowly, so the failure comes while it is awaited.
fs.open = ((path: fs.PathLike, ...rest: unknown[]) => {
  const done = rest.at(-1) as (error: Error | null, fd: number) => void;
  const opening = rest.slice(0, -1);
  if (!String(path).includes("/files/")) {
    (open as (...a: unknown[]) => void)(path, ...rest);
    return;
  }
  (open as (...a: unknown[]) => void)(
    path,
    ...opening,
    (error: Error | null, fd: number) => {
      setTimeout(() => {
        done(error, fd);
      }, 100);
    },
  );
}) as typeof fs.open;

const said = await exportZip(home, new Date()).then(
  () => "made",
  (error: unknown) => (error as { code?: string }).code ?? String(error),
);
const left = (await readdir(home)).filter((name) =>
  name.startsWith(".export-"),
);
process.stdout.write(`${JSON.stringify({ said, left })}\n`);
