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
