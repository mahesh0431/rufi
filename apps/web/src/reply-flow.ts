// How a reply shows while it is written, as Settings › Chat chose (the
// reply flow). Paragraph by paragraph: each top-level Markdown block once
// the next one has started, as the same parser as the reply's reads them;
// the one being written waits. Word by word: the words as they come, at a
// pace that follows how much waits, so uneven parts from the AI flow evenly.
// Whole reply: nothing until it is done. The reply itself is the same.
import { useEffect, useRef, useState } from "react";
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

/**
 * Where the last whole word up to `upTo` ends: just before a space that
 * follows it. 0 when none has. A word at the end waits for what follows
 * it, so a word, a bold mark or a fence's opening line shows only whole.
 */
export function wordsEnd(text: string, upTo: number): number {
  for (let at = Math.floor(Math.min(upTo, text.length - 1)); at > 0; at--) {
    if (SPACE.test(text[at] ?? "") && !SPACE.test(text[at - 1] ?? "")) {
      return at;
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

/**
 * The reply's text, word by word, while `flowing`; all of it otherwise. It
 * starts from what the reply already holds, so a reload shows that at once.
 */
export function useWordByWord(text: string, flowing: boolean): string {
  const [shown, setShown] = useState(() => wordsEnd(text, text.length));
  // How far the pace has come, between whole words.
  const pace = useRef(text.length);
  useEffect(() => {
    if (!flowing) return;
    let then = performance.now();
    const step = (now: number) => {
      // A frame's time can be just before the effect ran.
      pace.current = paced(pace.current, text.length, Math.max(0, now - then));
      then = now;
      setShown(wordsEnd(text, pace.current));
      if (pace.current < text.length) frame = requestAnimationFrame(step);
    };
    let frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [text, flowing]);
  return flowing ? text.slice(0, shown) : text;
}
