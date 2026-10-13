// What the screens and the diagram frame say to each other. The screens put
// the diagram and the theme's colours in the frame's address (after #); the
// frame answers with whether it drew it, and its height.

/** The theme's colours the diagram is drawn in, from src/themes.css. */
export const DIAGRAM_COLOURS = [
  "surface",
  "side",
  "ink",
  "muted",
  "line",
  "accent",
  "accent-soft",
] as const;

export interface DiagramAsk {
  source: string;
  colours: Record<(typeof DIAGRAM_COLOURS)[number], string>;
  font: string;
  /** The theme is dark: Mermaid works out its other colours for it. */
  dark: boolean;
}

export interface DiagramAnswer {
  type: "rufi-diagram";
  /** It drew the diagram; false: the source isn't one it can draw. */
  drawn: boolean;
  height: number;
}
