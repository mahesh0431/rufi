// What a test shows when a reply on the real Codex doesn't come. Rufi keeps
// Codex's stderr only to say why Codex ended, so the test runs Codex through
// bash, which copies it to a file too: Codex keeps its own pid.
import { readFile } from "node:fs/promises";
import type { QueueItem } from "@rufi/contracts";

/** `command` with Codex's stderr copied to `log` as well. */
export const keepingLog = (
  command: { file: string; args: readonly string[] },
  log: string,
) => ({
  file: "/bin/bash",
  args: [
    "-c",
    'log=$1; shift; exec "$@" 2> >(tee -a "$log" >&2)',
    "bash",
    log,
    command.file,
    ...command.args,
  ],
});

/**
 * Why no reply came, as far as the test can see: each message Rufi has
 * waiting, with why it holds it, and the end of Codex's log.
 */
export async function noReply(
  waiting: readonly QueueItem[],
  log: string,
): Promise<string> {
  const held = waiting.map(({ text, state, held, heldText }) => ({
    text,
    state,
    held,
    heldText,
  }));
  const end = (await readFile(log, "utf8").catch(() => "")).slice(-2_000);
  return `waiting: ${JSON.stringify(held)}; Codex's log ends: ${end || "(nothing)"}`;
}
