// Ending app-server and everything it started. Codex starts each command in a
// new session, so killing app-server's own process group isn't enough.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * Ends `rootPid`, its descendants, and every process in their process groups
 * or in `knownGroups` (groups seen earlier, whose processes may have been
 * re-parented since): TERM, then KILL for whatever is still running after
 * `graceMs`. A program that deliberately detaches (double fork, nohup) can
 * still escape; see PLAN.md §4.
 */
export async function killTree(
  rootPid: number | undefined,
  knownGroups: Iterable<number> = [],
  graceMs = 2_000,
): Promise<void> {
  if (rootPid !== undefined && rootPid <= 1) {
    throw new Error(`Refusing to end process ${String(rootPid)} and below.`);
  }
  const table = await processTable();
  const tree = rootPid === undefined ? [] : descendants(table, rootPid);
  const own = table.find((row) => row.pid === process.pid)?.pgid;
  const groups = new Set(
    [...tree.map((row) => row.pgid), ...knownGroups].filter(
      (pgid) => pgid > 1 && pgid !== own,
    ),
  );
  const pids = table
    .filter((row) => tree.includes(row) || groups.has(row.pgid))
    .map((row) => row.pid);
  signal(groups, pids, "SIGTERM");
  await waitUntilGone(pids, graceMs);
  signal(groups, pids, "SIGKILL");
  // KILL can't be refused, but the process still takes a moment to go.
  await waitUntilGone(pids, 1_000);
}

/**
 * Adds the process groups of `rootPid`'s descendants (other than its own
 * group) to `groups`, and drops groups that no longer have any process, so a
 * group id the system has reused later is unlikely to be in the set.
 */
export async function trackGroups(
  rootPid: number,
  groups: Set<number>,
): Promise<void> {
  const table = await processTable();
  const tree = descendants(table, rootPid);
  const own = tree.find((row) => row.pid === rootPid)?.pgid;
  for (const row of tree) {
    if (row.pgid !== own && row.pgid > 1) groups.add(row.pgid);
  }
  const alive = new Set(table.map((row) => row.pgid));
  for (const group of groups) if (!alive.has(group)) groups.delete(group);
}

async function waitUntilGone(pids: readonly number[], ms: number) {
  const deadline = Date.now() + ms;
  while (pids.some(isRunning) && Date.now() < deadline) await sleep(20);
}

/** `rootPid` and every process below it (empty if it has already ended). */
function descendants(table: readonly Row[], rootPid: number): Row[] {
  const found = table.filter((row) => row.pid === rootPid);
  for (let i = 0; i < found.length; i++) {
    const parent = found[i]?.pid;
    found.push(...table.filter((row) => row.ppid === parent));
  }
  return found;
}

async function processTable(): Promise<Row[]> {
  const { stdout } = await promisify(execFile)(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid="],
    { timeout: 5_000 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length === 3 && cols.every(Number.isInteger))
    .map(([pid = 0, ppid = 0, pgid = 0]) => ({ pid, ppid, pgid }));
}

function signal(
  groups: ReadonlySet<number>,
  pids: readonly number[],
  name: NodeJS.Signals,
): void {
  for (const pgid of groups) send(-pgid, name);
  for (const pid of pids) send(pid, name);
}

function send(target: number, name: NodeJS.Signals): void {
  try {
    process.kill(target, name);
  } catch (error) {
    // Already gone is the goal. EPERM: macOS answers it for a group whose
    // processes have exited but aren't reaped yet; and a process Rufi may not
    // signal isn't one of Rufi's. Anything else is a real failure.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, but isn't Rufi's to signal
    throw error;
  }
}
