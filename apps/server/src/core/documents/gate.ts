// One gate for the bytes of documents (docs/adr/0015): what writes, reads
// or removes originals and their caches takes it, one at a time. Backups
// and the export read the database and the originals it names inside it;
// an add writes its originals and commits its rows inside it; a drawn page
// or a display copy is kept inside it only while its file is still live;
// a delete removes bytes inside it only once no live page uses them. The
// core is one process under rufi.lock, so a gate in memory is enough. Slow
// work (drawing, reading a file) stays outside it.

export function fileGate() {
  let last: Promise<unknown> = Promise.resolve();
  return {
    /** Runs `work` once everything before it has ended. Never nest it. */
    run: <T>(work: () => Promise<T>): Promise<T> => {
      const turn = last.then(work, work);
      last = turn.catch(() => undefined);
      return turn;
    },
  };
}

export type FileGate = ReturnType<typeof fileGate>;
