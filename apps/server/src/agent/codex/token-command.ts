// The command Codex runs for a ChatGPT token, its provider's auth command
// (token-door.ts), with Rufi's own node: it reads the door's address and key
// from the file it is given, asks the running Rufi, and prints the token.
// With none, it prints Rufi's reason for Codex's error and fails. It imports
// nothing of Rufi's, so it starts at once.
import { readFileSync } from "node:fs";

/** Under Codex's own wait for the command (COMMAND_MS). */
const DEADLINE_MS = 30_000;

const { url, key } = JSON.parse(
  readFileSync(process.argv[2] ?? "", "utf8"),
) as {
  url: string;
  key: string;
};
const response = await fetch(url, {
  method: "POST",
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(DEADLINE_MS),
});
const text = await response.text();
if (response.ok) {
  process.stdout.write(text);
} else {
  process.stderr.write(text);
  process.exitCode = 1;
}
