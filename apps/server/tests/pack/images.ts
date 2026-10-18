// Images of the pack's printed pages: plain (the page as drawn), like a
// phone photo (tilted on a desk, uneven light, some noise, JPEG), and like
// a scan (JPEG, no text). Made with the same drawing Rufi uses for PDFs.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { draw } from "../../src/core/documents/inspect.ts";

/** Page `page` of a PDF, drawn as a PNG. */
export async function drawn(
  pdf: Uint8Array,
  page: number,
): Promise<Uint8Array> {
  const made = await draw(pdf, page);
  if (!made.ok) throw new Error(`Page ${String(page)} couldn't be drawn.`);
  return made.png;
}

/** A seeded generator, so each photo is the same every time. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

/** The page like a phone photo of the printout: tilted, uneven light, noise. */
export async function photo(
  png: Uint8Array,
  seed: number,
): Promise<Uint8Array> {
  const random = seeded(seed);
  const page = await loadImage(Buffer.from(png));
  const width = Math.round(page.width * 1.18);
  const height = Math.round(page.height * 1.12);
  const canvas = createCanvas(width, height);
  const c = canvas.getContext("2d");
  // A desk.
  const desk = c.createLinearGradient(0, 0, width, height);
  desk.addColorStop(0, "#6f5d4c");
  desk.addColorStop(1, "#4d3f33");
  c.fillStyle = desk;
  c.fillRect(0, 0, width, height);
  // The page, tilted a little, with a shadow.
  c.save();
  c.translate(width / 2, height / 2);
  c.rotate(((random() * 2 - 1) * 2.5 * Math.PI) / 180);
  c.shadowColor = "rgba(0,0,0,0.45)";
  c.shadowBlur = 30;
  c.shadowOffsetX = 8;
  c.shadowOffsetY = 12;
  c.drawImage(page, -page.width / 2, -page.height / 2);
  c.restore();
  // Uneven light from one side.
  const light = c.createLinearGradient(0, 0, width, 0);
  light.addColorStop(0, "rgba(255,248,230,0.10)");
  light.addColorStop(1, "rgba(0,0,0,0.22)");
  c.fillStyle = light;
  c.fillRect(0, 0, width, height);
  // Sensor noise.
  const pixels = c.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const n = (random() - 0.5) * 18;
    pixels.data[i] = (pixels.data[i] ?? 0) + n;
    pixels.data[i + 1] = (pixels.data[i + 1] ?? 0) + n;
    pixels.data[i + 2] = (pixels.data[i + 2] ?? 0) + n;
  }
  c.putImageData(pixels, 0, 0);
  return new Uint8Array(await canvas.encode("jpeg", 72));
}

/** The page like a scan: a JPEG of the page, slightly grey, for a PDF with no text. */
export async function scan(
  png: Uint8Array,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const page = await loadImage(Buffer.from(png));
  const canvas = createCanvas(page.width, page.height);
  const c = canvas.getContext("2d");
  c.filter = "grayscale(1) contrast(1.1)";
  c.drawImage(page, 0, 0);
  return {
    bytes: new Uint8Array(await canvas.encode("jpeg", 80)),
    width: page.width,
    height: page.height,
  };
}

/** Something drawn on a printed page, in the page's points from its top-left corner. */
export type Ink =
  /** A pen line through printed text, from x1 to x2 at height y. */
  | { strike: [x1: number, x2: number, y: number] }
  /** Digits written by hand, their foot at (x, y), `size` points high. */
  | { hand: string; x: number; y: number; size: number }
  /** A smudge centred at (x, y), `r` points across. */
  | { smudge: [x: number, y: number, r: number] };

/** Each digit as pen strokes on a unit box, y down. */
const STROKES: Record<string, [number, number][]> = {
  "0": [
    [0.5, 0],
    [0.15, 0.2],
    [0.1, 0.6],
    [0.3, 0.98],
    [0.7, 0.95],
    [0.9, 0.5],
    [0.8, 0.1],
    [0.45, 0.02],
  ],
  "1": [
    [0.25, 0.2],
    [0.55, 0],
    [0.5, 1],
  ],
  "2": [
    [0.1, 0.25],
    [0.35, 0.02],
    [0.75, 0.05],
    [0.85, 0.3],
    [0.1, 1],
    [0.95, 0.98],
  ],
  "3": [
    [0.1, 0.1],
    [0.5, 0],
    [0.85, 0.18],
    [0.45, 0.48],
    [0.88, 0.65],
    [0.8, 0.92],
    [0.4, 1],
    [0.08, 0.88],
  ],
  "4": [
    [0.65, 1],
    [0.7, 0],
    [0.05, 0.68],
    [0.95, 0.7],
  ],
  "5": [
    [0.88, 0.02],
    [0.25, 0],
    [0.15, 0.45],
    [0.6, 0.38],
    [0.9, 0.62],
    [0.8, 0.92],
    [0.4, 1],
    [0.08, 0.88],
  ],
  "6": [
    [0.8, 0.05],
    [0.35, 0.15],
    [0.12, 0.55],
    [0.2, 0.92],
    [0.55, 1],
    [0.85, 0.8],
    [0.7, 0.52],
    [0.3, 0.55],
    [0.15, 0.7],
  ],
  "7": [
    [0.05, 0.02],
    [0.95, 0],
    [0.4, 1],
  ],
  "8": [
    [0.5, 0.48],
    [0.15, 0.28],
    [0.25, 0.04],
    [0.6, 0],
    [0.82, 0.22],
    [0.5, 0.48],
    [0.15, 0.72],
    [0.25, 0.97],
    [0.62, 1],
    [0.88, 0.75],
    [0.5, 0.48],
  ],
  "9": [
    [0.85, 0.35],
    [0.45, 0.5],
    [0.15, 0.3],
    [0.3, 0.02],
    [0.7, 0.02],
    [0.85, 0.3],
    [0.75, 1],
  ],
};

/**
 * A printed page with ink on it: a pen's strike-through and handwriting
 * (blue, a little uneven), or a smudge. `png` is the page as drawn; the
 * ink is placed in the page's points.
 */
export async function inked(
  png: Uint8Array,
  ink: readonly Ink[],
  seed: number,
): Promise<Uint8Array> {
  const random = seeded(seed);
  const page = await loadImage(Buffer.from(png));
  const canvas = createCanvas(page.width, page.height);
  const c = canvas.getContext("2d");
  c.drawImage(page, 0, 0);
  // The page is A4 in points, drawn at the canvas's width.
  const k = page.width / 595;
  const wobble = (n: number) => (random() - 0.5) * n * k;
  c.lineCap = "round";
  c.lineJoin = "round";
  for (const mark of ink) {
    if ("strike" in mark) {
      const [x1, x2, y] = mark.strike;
      c.strokeStyle = "rgba(20,40,140,0.9)";
      c.lineWidth = 1.4 * k;
      c.beginPath();
      c.moveTo(x1 * k, y * k + wobble(1));
      c.lineTo(x2 * k, y * k + wobble(1));
      c.stroke();
    } else if ("hand" in mark) {
      c.strokeStyle = "rgba(20,40,140,0.92)";
      c.fillStyle = "rgba(20,40,140,0.92)";
      c.lineWidth = Math.max(1.2, 0.11 * mark.size) * k;
      let x = mark.x;
      for (const ch of mark.hand) {
        const w = 0.62 * mark.size;
        if (ch === ".") {
          c.beginPath();
          c.arc(
            (x + 0.1 * w) * k,
            (mark.y - 0.05 * mark.size) * k,
            1.1 * k,
            0,
            2 * Math.PI,
          );
          c.fill();
          x += 0.4 * w;
          continue;
        }
        c.beginPath();
        for (const [i, [u, v]] of (STROKES[ch] ?? []).entries()) {
          // Slanted forward, as handwriting is.
          const px = (x + u * w + (1 - v) * 0.18 * mark.size) * k + wobble(0.5);
          const py = (mark.y - mark.size + v * mark.size) * k + wobble(0.5);
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.stroke();
        x += w * 1.15;
      }
    } else {
      const [x, y, r] = mark.smudge;
      const blob = c.createRadialGradient(x * k, y * k, 0, x * k, y * k, r * k);
      blob.addColorStop(0, "rgba(70,62,55,0.95)");
      blob.addColorStop(0.6, "rgba(95,86,78,0.8)");
      blob.addColorStop(1, "rgba(130,120,110,0)");
      c.fillStyle = blob;
      c.beginPath();
      c.ellipse(x * k, y * k, r * k, r * 0.9 * k, 0.3, 0, 2 * Math.PI);
      c.fill();
    }
  }
  return new Uint8Array(await canvas.encode("png"));
}
