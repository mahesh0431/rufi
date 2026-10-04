// The built screens (apps/web/dist), served by the core on its own port. Only
// files inside that folder are served; a page path that isn't a file gets the
// app, which routes it; a missing file with an extension stays a 404.
import { readFile } from "node:fs/promises";
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
  const root = resolve(folder);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined; // a malformed path is not a file
  }
  const file = resolve(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  const extension = extname(file);
  if (extension !== "") {
    const type = TYPES[extension];
    if (type === undefined) return undefined;
    const body = await read(file);
    return (
      body && { body, type, immutable: file.includes(`${sep}assets${sep}`) }
    );
  }
  // A page: the app routes it.
  const index = await read(join(root, "index.html"));
  return index && { body: index, type: TYPES[".html"] ?? "", immutable: false };
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
