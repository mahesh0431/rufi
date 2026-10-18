// Rufi's dog on the screens, drawn by the brand package's one source (never
// redrawn here): on its periwinkle tile in the light theme, its ink tile in
// the dark one. Both are in the page and the theme on <html data-theme>
// shows one (styles.css), so the right one is there from the first paint and
// follows a change at once. A small dog moves by CSS only (motion.css); a
// large one people look at moves its face with `live()`. Under reduced
// motion neither moves.
import { type ExpressionKey, live, svg } from "@rufi/brand/mark";
import { useEffect, useRef } from "react";

const PALETTES = { light: "onPeriwinkle", dark: "inkApricot" } as const;

/** Each drawing is made once and kept: a new face swaps a kept string. */
const drawings = new Map<string, string>();
function drawing(
  theme: keyof typeof PALETTES,
  expression: ExpressionKey,
  size: number,
): string {
  const key = `${theme}|${expression}|${String(size)}`;
  let made = drawings.get(key);
  if (made === undefined) {
    made = svg({ palette: PALETTES[theme], expression, size, ground: "tile" });
    drawings.set(key, made);
  }
  return made;
}

/** The dog with a face, named "Rufi" for screen readers. */
export function Dog({
  mood = "calm",
  size,
}: {
  mood?: ExpressionKey;
  /** Pixels; 32 and below draws the small, flat dog without its signs. */
  size: number;
}) {
  return (
    <span className="flex shrink-0">
      <span
        data-dog="light"
        dangerouslySetInnerHTML={{ __html: drawing("light", mood, size) }}
      />
      <span
        data-dog="dark"
        dangerouslySetInnerHTML={{ __html: drawing("dark", mood, size) }}
      />
    </span>
  );
}

/**
 * A large dog people look at (an empty page, the first run): its face moves
 * smoothly and its eyes follow the pointer, on the drawing the theme shows.
 * Stopped when it goes, and never started under reduced motion.
 */
export function LiveDog({
  mood = "hello",
  size,
}: {
  mood?: ExpressionKey;
  size: number;
}) {
  const dog = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = dog.current;
    if (!root) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let face: ReturnType<typeof live> | undefined;
    const start = () => {
      face?.stop();
      face = undefined;
      if (reduce.matches) return;
      const shown = [...root.querySelectorAll("svg")].find(
        (one) => one.getClientRects().length > 0,
      );
      if (shown) face = live(shown, { expression: mood });
    };
    start();
    reduce.addEventListener("change", start);
    const theme = new MutationObserver(start);
    theme.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
    });
    return () => {
      reduce.removeEventListener("change", start);
      theme.disconnect();
      face?.stop();
    };
  }, [mood]);
  return (
    <span ref={dog} className="flex shrink-0">
      <Dog mood={mood} size={size} />
    </span>
  );
}
