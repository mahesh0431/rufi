// How a reply shows while it is written, as Settings › Chat chose (the
// reply flow). Paragraph by paragraph: each top-level Markdown block once
// the next one has started, as the same parser as the reply's reads them;
// the one being written waits. Word by word: the words as they come, at a
// pace that follows how much waits, so uneven parts from the AI flow evenly.
// Whole reply: nothing until it is done. The reply itself is the same.
import { useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const blocks = unified().use(remarkParse).use(remarkGfm);

/**
 * The reply's blocks that are whole: every top-level block but the last,
 * which may still grow (a paragraph, a list's next item, a visual's next
 * line). "" while the first is being written.
 */
export function finishedBlocks(text: string): string {
  const last = blocks.parse(text).children.at(-1);
  const at = last?.position?.start.offset ?? 0;
  return text.slice(0, at).trimEnd();
}

const SPACE = /\s/;
/** A line so far only a block's marks: a bullet, a number, a heading, a quote. */
const MARK = String.raw`(?:[-*+>]|#{1,6}|\d{1,9}[.)])`;
const ONLY_MARKS = new RegExp(String.raw`^[ \t]*(?:${MARK}[ \t]+)*${MARK}$`);

/**
 * Where the last whole word up to `upTo` ends: just before a space that
 * follows it. 0 when none has. A word at the end waits for what follows
 * it, so a word, a bold mark or a fence's opening line shows only whole.
 * A line's marks wait for its first word: a bullet alone would show on the
 * item above.
 */
export function wordsEnd(text: string, upTo: number): number {
  for (let at = Math.floor(Math.min(upTo, text.length - 1)); at > 0; at--) {
    if (SPACE.test(text[at] ?? "") && !SPACE.test(text[at - 1] ?? "")) {
      const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
      if (!ONLY_MARKS.test(line)) return at;
    }
  }
  return 0;
}

/** At least one character every 5 ms; what waits shows within 250 ms. */
const MS_PER_CHARACTER = 5;
const CATCH_UP_MS = 250;

/**
 * How far the flow has come after `ms` more, from `shown` towards
 * `length`: quicker the more waits, so it keeps up without a jump.
 */
export function paced(shown: number, length: number, ms: number): number {
  const waiting = length - shown;
  if (waiting <= 0) return length;
  const perMs = Math.max(waiting / CATCH_UP_MS, 1 / MS_PER_CHARACTER);
  return Math.min(length, shown + ms * perMs);
}

/** The most one step counts, so text after a pause flows too. */
const LONGEST_STEP_MS = 100;

/**
 * Word by word's pace for one reply. It keeps its clock from step to step,
 * new text or not, so the time between steps always counts: text that
 * comes faster than a frame still flows.
 */
export class WordPace {
  #at: number | undefined;
  #last: number | undefined;

  /**
   * The whole words of `text` shown at `now` (ms): all it holds the first
   * time (a reply opened while it is written), then as far as the pace came.
   */
  step(text: string, now: number): number {
    const since =
      this.#last === undefined
        ? 0
        : Math.min(LONGEST_STEP_MS, Math.max(0, now - this.#last));
    this.#at =
      this.#at === undefined
        ? text.length
        : paced(this.#at, text.length, since);
    this.#last = now;
    return wordsEnd(text, this.#at);
  }

  /** The pace has reached the end of `text`. */
  caughtUp(text: string): boolean {
    return (this.#at ?? 0) >= text.length;
  }
}

/**
 * The reply's text, word by word, while `flowing`; all of it otherwise. It
 * starts from what the reply already holds, so a reload shows that at once.
 * New text steps the pace at once, then each frame does until it caught up.
 */
export function useWordByWord(text: string, flowing: boolean): string {
  const [pace] = useState(() => new WordPace());
  const [shown, setShown] = useState(() => wordsEnd(text, text.length));
  useEffect(() => {
    if (!flowing) return;
    let frame = 0;
    const step = (now: number) => {
      setShown(pace.step(text, now));
      if (!pace.caughtUp(text)) frame = requestAnimationFrame(step);
    };
    step(performance.now());
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [pace, text, flowing]);
  return flowing ? text.slice(0, shown) : text;
}
