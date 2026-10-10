// The app's channel to the Rufi it runs, at the transport: a claim the
// child never answers ends at its deadline, and the next claim is answered.
// The child is a scripted stand-in for `rufi start` on the same IPC channel.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { core } from "./core.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** A Rufi that says it's owned, never answers its first claim, then answers. */
const CHILD = `#!${process.execPath}
process.send({ type: "owned", url: "http://127.0.0.1:9/#launch=test" });
let claims = 0;
process.on("message", (message) => {
  if (message.type === "claim-notices" && ++claims > 1) {
    process.send({ type: "notices", people: [{ personId: "asha", due: 1, overdue: 0 }] });
  }
});
process.on("disconnect", () => process.exit(0));
`;

it("a claim the Rufi never answers ends at its deadline, and the next claim is answered", async () => {
  const child = join(await mkdtemp(join(tmpdir(), "rufi-app-")), "rufi");
  await writeFile(child, CHILD);
  await chmod(child, 0o700);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rufi = core(child, {
    onOwned: () => undefined,
    onLost: () => undefined,
  });
  await rufi.link();

  const unanswered = rufi.notices();
  const ended = expect(unanswered).rejects.toThrow("didn't answer in time");
  await vi.advanceTimersByTimeAsync(10_000);
  await ended;

  await expect(rufi.notices()).resolves.toEqual([
    { personId: "asha", due: 1, overdue: 0 },
  ]);
  await rufi.stop();
});
