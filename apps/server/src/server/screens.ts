// The built screens (apps/web/dist), served by the core on its own port. Only
// files inside that folder are served; a page path that isn't a file gets the
// app, which routes it; a missing file with an extension stays a 404. Paths
// are checked as the disk resolves them, so a link can't lead outside.
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export interface Screen {
  body: Buffer;
  type: string;
  /** Built files carry a content hash in their name and never change. */
  immutable: boolean;
}

/** The file for a page path, or undefined when there is none to serve. */
export async function screen(
  folder: string,
  path: string,
): Promise<Screen | undefined> {
  const root = await real(resolve(folder));
  if (root === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined; // a malformed path is not a file
  }
  const asked = resolve(join(root, decoded));
  const extension = extname(asked);
  if (extension !== "") {
    const type = TYPES[extension];
    const file = await inside(root, asked);
    if (type === undefined || file === undefined) return undefined;
    const body = await read(file);
    return (
      body && {
        body,
        type,
        immutable: file.startsWith(join(root, "assets") + sep),
      }
    );
  }
  // A page: the app routes it.
  const page = await inside(root, join(root, "index.html"));
  const index = page === undefined ? undefined : await read(page);
  return index && { body: index, type: TYPES[".html"] ?? "", immutable: false };
}

/** `path` as the disk resolves it, when that is inside `root`. */
async function inside(root: string, path: string): Promise<string | undefined> {
  const file = await real(path);
  return file?.startsWith(root + sep) ? file : undefined;
}

/** The path as the disk resolves it (links followed); undefined when missing. */
async function real(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new Error(`Couldn't resolve ${path}`, { cause: error });
  }
}

async function read(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw new Error(`Couldn't read ${file}`, { cause: error });
  }
}
