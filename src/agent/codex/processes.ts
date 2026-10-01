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
 * Ends `rootPid`, its descendants and every process group they lead or share:
 * TERM, then KILL for whatever is still running after `graceMs`. A program that
 * deliberately detaches (double fork, nohup) can still escape; see §4.
 */
export async function killTree(
  rootPid: number,
  graceMs = 2_000,
): Promise<void> {
  const table = await processTable();
  const tree = descendants(table, rootPid);
  const own = table.find((row) => row.pid === process.pid)?.pgid;
  const groups = new Set(
    tree.map((row) => row.pgid).filter((pgid) => pgid > 1 && pgid !== own),
  );
  const pids = tree.map((row) => row.pid);
  signal(groups, pids, "SIGTERM");
  await waitUntilGone(pids, graceMs);
  signal(groups, pids, "SIGKILL");
  // KILL can't be refused, but the process still takes a moment to go.
  await waitUntilGone(pids, 1_000);
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
    // Already gone is the goal; anything else is a real failure.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
