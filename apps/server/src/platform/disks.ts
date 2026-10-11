// The disks mounted on this Mac, as `mount` lists them: Rufi's data folder
// must not be on a network disk, where SQLite's locks aren't safe.
import { execFile } from "node:child_process";
import { sep } from "node:path";
import { promisify } from "node:util";

/** How long the list may take. */
const MOUNT_MS = 10_000;

/** File systems on a network. */
const NETWORK = /^(smbfs|afpfs|nfs|nfs4|webdav|cifs|smb3|ftp)$/;

/**
 * The list `mount` prints. On the Mac, /sbin/mount; elsewhere (the CI's
 * Linux) the `mount` on PATH, whose lines the parser reads too. A failure
 * is thrown, never taken as "not a network disk".
 */
export async function mountList(): Promise<string> {
  const command = process.platform === "darwin" ? "/sbin/mount" : "mount";
  const { stdout } = await promisify(execFile)(command, [], {
    timeout: MOUNT_MS,
  });
  return stdout;
}

/**
 * Whether `path`, a real path, is on a network disk: the type of the
 * deepest mount that holds it. The Mac's lines are
 * `<device> on <folder> (<type>, <options>)`; Linux's
 * `<device> on <folder> type <type> (<options>)`.
 */
export function onNetworkDisk(path: string, list: string): boolean {
  let best = { at: "", type: "" };
  for (const line of list.split("\n")) {
    const found = /^.+? on (.+?) (?:type (\S+) \(|\(([^,)]+))/.exec(line);
    const at = found?.[1];
    const type = found?.[2] ?? found?.[3];
    if (at === undefined || type === undefined) continue;
    const inside = at === "/" || path === at || path.startsWith(at + sep);
    if (inside && at.length > best.at.length) best = { at, type };
  }
  return NETWORK.test(best.type);
}
