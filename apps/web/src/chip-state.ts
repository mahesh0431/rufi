// What Rufi is doing with a document whose chip is in the chat box: worked
// out from the person's documents and their reading jobs each time it shows,
// never stored with the chip. "Read" says only that the reading ended, never
// that anything was saved; without the data, a chip shows no state.
import type { DocumentSummary, ReadingNow } from "@rufi/contracts/documents";

export interface ChipState {
  text: string;
  /** Rufi is reading it now. */
  busy: boolean;
}

export function chipState(
  document: DocumentSummary | undefined,
  reading: ReadingNow | undefined,
): ChipState | undefined {
  if (reading?.state === "running") {
    return {
      text:
        reading.of > 0
          ? `Reading… ${String(reading.saved)} of ${String(reading.of)} pages`
          : "Reading…",
      busy: true,
    };
  }
  if (reading?.state === "waiting") {
    return { text: "Waiting to read", busy: false };
  }
  // A document that reads has its job; without one known yet, no state.
  if (document?.status === "done") {
    return {
      text:
        document.reading?.canRetry === true
          ? "Read · some pages unclear"
          : "Read",
      busy: false,
    };
  }
  if (document?.status === "failed") {
    return { text: "Couldn't read", busy: false };
  }
  return undefined;
}
