// One gate for the bytes of documents (docs/adr/0015). What writes or reads
// originals and their caches takes it shared: a backup and the export, from
// their copy of the database through reading every original it names; an
// add, from writing its originals through its commit; keeping a drawn page
// or a display copy, only while its file is still live. These never get in
// each other's way: a backup's copy of the database just doesn't have a
// document added meanwhile. Removing bytes takes it exclusive, and only once
// no live page uses them. Turns are taken in order, so a removal waits only
// for what came before it. The core is one process under rufi.lock, so a
// gate in memory is enough. Slow work (drawing, reading a file to send it)
// stays outside it.

type Mode = "shared" | "exclusive";

export function fileGate() {
  let sharing = 0;
  let excluded = false;
  const waiting: { mode: Mode; go: () => void }[] = [];

  /** Lets in, in order, everyone who may go in now. */
  const admit = () => {
    for (let next = waiting[0]; next; next = waiting[0]) {
      if (excluded || (next.mode === "exclusive" && sharing > 0)) return;
      waiting.shift();
      if (next.mode === "shared") sharing++;
      else excluded = true;
      next.go();
    }
  };

  const inside =
    (mode: Mode) =>
    async <T>(work: () => Promise<T>): Promise<T> => {
      await new Promise<void>((go) => {
        waiting.push({ mode, go });
        admit();
      });
      try {
        return await work();
      } finally {
        if (mode === "shared") sharing--;
        else excluded = false;
        admit();
      }
    };

  return {
    /** Runs `work` beside other shared work, never beside a removal. Never nest it. */
    shared: inside("shared"),
    /** Runs `work` alone, once everything before it has ended. Never nest it. */
    exclusive: inside("exclusive"),
  };
}

export type FileGate = ReturnType<typeof fileGate>;
