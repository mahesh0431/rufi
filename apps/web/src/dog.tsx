import { svg } from "@rufi/brand/mark";

// Rufi's dog at the top of the sidebar, drawn by the brand package's one
// source (never redrawn here): on its periwinkle tile in the light theme,
// its ink tile in the dark one. Both are in the page and the theme on
// <html data-theme> shows one (styles.css), so the right one is there from
// the first paint and follows a change at once. Still: no motion.
const LIGHT = svg({
  palette: "onPeriwinkle",
  size: 24,
  ground: "tile",
  motion: false,
});
const DARK = svg({
  palette: "inkApricot",
  size: 24,
  ground: "tile",
  motion: false,
});

/** The dog, named "Rufi" for screen readers. */
export function Dog() {
  return (
    <span className="flex shrink-0">
      <span data-dog="light" dangerouslySetInnerHTML={{ __html: LIGHT }} />
      <span data-dog="dark" dangerouslySetInnerHTML={{ __html: DARK }} />
    </span>
  );
}
