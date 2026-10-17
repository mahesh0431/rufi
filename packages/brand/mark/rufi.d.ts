// The Rufi dog. Not under the Apache License: the Rufi name and everything in
// packages/brand/mark/ belong to mahesh0431. All rights reserved. See TRADEMARKS.md.

// Types for rufi.js, the dog's one source.

/** A palette: the ground, the paper, the folds, the face and the signs. */
export interface Palette {
  name?: string;
  bg: string;
  paper: string;
  accent: string;
  ink: string;
  sign?: string;
}

export type PaletteKey = "inkApricot" | "onApricot" | "onPeriwinkle";

export type ExpressionKey =
  | "calm"
  | "hello"
  | "listening"
  | "typing"
  | "thinking"
  | "reading"
  | "found"
  | "question"
  | "done"
  | "playful"
  | "tip"
  | "steady"
  | "sorry"
  | "sleepy"
  | "resting"
  | "alert";

export interface Expression {
  name: string;
  /** smile, small, grin, flat or frown */
  mouth: string;
  /** The CSS moves in motion.css. */
  motion: string;
  use: string;
  sign?: string;
}

export interface SvgOptions {
  palette?: PaletteKey | Partial<Palette>;
  expression?: ExpressionKey;
  /** Pixels; 32 and below draws the small, flat version. */
  size?: number;
  ground?: "none" | "tile" | "circle";
  /** false: still; class names such as "blink lift": that motion; left out: the expression's own. */
  motion?: false | string;
}

export const PALETTES: Record<PaletteKey, Palette>;
export const EXPRESSIONS: Record<ExpressionKey, Expression>;

/** A complete <svg> of the dog, named "Rufi" for screen readers. */
export function svg(options?: SvgOptions): string;

/** The face moves on an <svg> made by svg(): smooth changes between expressions, blinks, glances, the pointer. Still under reduced motion. */
export function live(
  svg: Element,
  options?: { expression?: ExpressionKey; pointer?: boolean; max?: number },
): { set(expression: ExpressionKey): void; readonly expression: ExpressionKey | undefined; stop(): void };

/** The eyes follow the pointer (live() with that expression); returns a function that stops it. Still under reduced motion. */
export function follow(
  svg: Element,
  options?: { max?: number; expression?: ExpressionKey },
): () => void;
