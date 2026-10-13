// The files a reply shows (docs/adr/0016): pictures and pages the AI made,
// from two places only, the AI's folder (where a relative path resolves) and
// the subtree where Codex saves the images it generates. The screens ask for
// a file by the path the reply holds and get a short-lived address for that
// one file; the file route takes only such an address, and checks the file
// again on every request: inside a root as the disk resolves it (links
// followed), a regular file, a type Rufi shows. Nothing is copied: a reply
// shows the file as it is now.
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

/** How long an address for a file works; the screens ask again after. */
const FILE_URL_MS = 10 * 60_000;

/** The types Rufi shows: pictures inline, pages in a locked frame. */
const TYPES: Record<string, { type: string; shape: Shape }> = {
  ".png": { type: "image/png", shape: "picture" },
  ".jpg": { type: "image/jpeg", shape: "picture" },
  ".jpeg": { type: "image/jpeg", shape: "picture" },
  ".gif": { type: "image/gif", shape: "picture" },
  ".webp": { type: "image/webp", shape: "picture" },
  ".html": { type: "text/html; charset=utf-8", shape: "page" },
  ".htm": { type: "text/html; charset=utf-8", shape: "page" },
};

type Shape = "picture" | "page";

/** A file a reply may show, as the disk has it now. */
interface ShownFile {
  /** The file as the disk resolves it. */
  path: string;
  /** Its name, as the reply wrote it. */
  name: string;
  type: string;
  shape: Shape;
}

/**
 * found; missing: inside a root, but not there (any more); refused: outside
 * both roots, a link leading out, not a regular file, or a type Rufi doesn't
 * show.
 */
type Lookup =
  | { found: ShownFile }
  | { missing: true; path: string }
  | { refused: true };

export interface AiFiles {
  /** The file a reply's path names, checked now. */
  find: (path: string) => Promise<Lookup>;
  /** An address for that one file, for a while; undefined unless found now. */
  grant: (
    path: string,
  ) => Promise<
    { token: string; file: ShownFile } | Exclude<Lookup, { found: ShownFile }>
  >;
  /** The file an address names, checked again; undefined: no such address. */
  open: (token: string) => Promise<Lookup | undefined>;
}

/** The longest path a reply may name. */
const MAX_PATH = 4096;

export function aiFiles(options: {
  /** The AI's folder. */
  folder: string;
  /** Where Codex saves generated images. */
  generated: string;
  now?: () => number;
}): AiFiles {
  const now = options.now ?? Date.now;
  const roots = [resolve(options.folder), resolve(options.generated)];
  const grants = new Map<string, { path: string; expires: number }>();

  /** The path as an absolute one; undefined: not a path Rufi takes. */
  const absolute = (path: string): string | undefined => {
    if (path === "" || path.length > MAX_PATH || path.includes("\0")) {
      return undefined;
    }
    if (path.startsWith("file:")) {
      try {
        return resolve(fileURLToPath(path));
      } catch {
        return undefined; // not a file address
      }
    }
    // Any other scheme (http:, data:, sandbox:) isn't a file here.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
    return isAbsolute(path) ? resolve(path) : resolve(roots[0] ?? "", path);
  };

  const find = async (path: string): Promise<Lookup> => {
    const asked = absolute(path);
    if (asked === undefined) return { refused: true };
    // Named inside a root, as written or as the disk resolves the root.
    const real = await Promise.all(roots.map(resolved));
    const within = [...roots, ...real].filter(
      (root): root is string => root !== undefined && under(root, asked),
    );
    if (within.length === 0) return { refused: true };
    const file = await resolved(asked);
    if (file === undefined) {
      // No file to resolve: keep its normalized name under the real root,
      // so a native picture and its Markdown alias share one gone card.
      const index = roots.findIndex((root) => under(root, asked));
      const root = roots[index];
      const actual = real[index];
      return {
        missing: true,
        path:
          root !== undefined && actual !== undefined
            ? resolve(actual, relative(root, asked))
            : asked,
      };
    }
    if (!real.some((root) => root !== undefined && under(root, file))) {
      return { refused: true };
    }
    const found = TYPES[extname(file).toLowerCase()];
    const info = await stat(file).catch(() => undefined);
    if (info === undefined) return { missing: true, path: file };
    if (!info.isFile() || found === undefined) return { refused: true };
    return { found: { path: file, name: basename(asked), ...found } };
  };

  return {
    find,
    grant: async (path) => {
      const found = await find(path);
      if (!("found" in found)) return found;
      const at = now();
      for (const [token, grant] of grants) {
        if (grant.expires <= at) grants.delete(token);
      }
      const token = randomBytes(32).toString("base64url");
      grants.set(token, {
        path: found.found.path,
        expires: at + FILE_URL_MS,
      });
      return { token, file: found.found };
    },
    open: async (token) => {
      const grant = grants.get(token);
      if (!grant || grant.expires <= now()) return undefined;
      return find(grant.path);
    },
  };
}

const under = (root: string, path: string) => path.startsWith(root + sep);

/** The path as the disk resolves it (links followed); undefined when missing. */
async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new Error("Couldn't resolve a file the AI made", { cause: error });
  }
}
