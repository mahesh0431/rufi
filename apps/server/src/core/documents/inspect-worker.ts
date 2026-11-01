// Looks at one file in a worker thread, so a big or broken file never holds
// up the chat: what it is by its content, a PDF's pages (pdf.js), a photo
// decoded once to know it opens, and a HEIC's display copy as JPEG
// (heic-decode, which applies the photo's own orientation; Rufi adds no
// rotation). It also draws one PDF page for the AI, with the page's own text.
// Run by inspect.ts.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileTypeFromBuffer } from "file-type";
import decodeHeic from "heic-decode";
import { AnnotationMode, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Drawn, Inspected, Task } from "./inspect.ts";

/**
 * A drawn page's longer side, in pixels. Measured on fictional pages (10 Oct
 * 2026): a dense A4 lab table of 45 rows at 8.5 pt draws in about 100 ms as
 * a 1131 × 1600 PNG of about 250 KB, its smallest print about 16 px high;
 * 1200 px makes that print 12 px, and 2000 px adds time and bytes the AI
 * doesn't use (it scales a page down to about 768 × 1086 at high detail).
 */
const PAGE_PIXELS = 1600;

/**
 * A page at full size, when the AI asks for print too small to read at
 * 1600 px: twice as long a side, four times the pixels. Codex sends it whole
 * marked "original" (up to 6000 px and 10,000 patches); Claude Code scales
 * it to fit 2000 px a side.
 */
const FULL_PAGE_PIXELS = 3200;

/** pdf.js's fonts for PDFs that don't embed theirs, and its character maps. */
const PDFJS = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);

/** What file-type names, and what Rufi keeps it as. */
const ACCEPTED: Record<string, Extract<Inspected, { ok: true }>["mediaType"]> =
  {
    "application/pdf": "application/pdf",
    "image/jpeg": "image/jpeg",
    "image/png": "image/png",
    "image/heic": "image/heic",
    "image/heif": "image/heif",
  };

async function look(bytes: Uint8Array): Promise<Inspected> {
  // A hint only: the file must also open as what it says it is.
  const mediaType = ACCEPTED[(await fileTypeFromBuffer(bytes))?.mime ?? ""];
  if (mediaType === undefined) return { ok: false, reason: "not_accepted" };
  if (mediaType === "application/pdf") {
    // Only the page count: no scripts, no forms, nothing drawn.
    const task = getDocument({
      data: bytes.slice(),
      enableXfa: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    try {
      const pdf = await task.promise;
      return { ok: true, mediaType, pages: pdf.numPages };
    } catch (error) {
      return {
        ok: false,
        reason:
          (error as Error).name === "PasswordException" ? "locked" : "broken",
      };
    } finally {
      await task.destroy();
    }
  }
  if (mediaType === "image/jpeg" || mediaType === "image/png") {
    try {
      await loadImage(Buffer.from(bytes));
    } catch {
      // The photo doesn't open: that is the answer, not an error.
      return { ok: false, reason: "broken" };
    }
    return { ok: true, mediaType, pages: 1 };
  }
  let image: { width: number; height: number; data: Uint8ClampedArray };
  try {
    image = await decodeHeic({ buffer: bytes });
  } catch {
    return { ok: false, reason: "broken" };
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(image.width, image.height);
  pixels.data.set(image.data);
  context.putImageData(pixels, 0, 0);
  const display = new Uint8Array(await canvas.encode("jpeg", 90));
  return { ok: true, mediaType, pages: 1, display };
}

/**
 * Draws one PDF page at PAGE_PIXELS and takes its text: plain, in the order
 * the PDF gives it (its reading order), no positions. No scripts, no forms
 * and no annotations: links and a PDF's own actions are ignored.
 */
async function drawPage(
  bytes: Uint8Array,
  number: number,
  full: boolean,
): Promise<Drawn> {
  const task = getDocument({
    data: bytes.slice(),
    enableXfa: false,
    verbosity: 0,
    standardFontDataUrl: `${join(PDFJS, "standard_fonts")}/`,
    cMapUrl: `${join(PDFJS, "cmaps")}/`,
    cMapPacked: true,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(number);
    const whole = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale:
        (full ? FULL_PAGE_PIXELS : PAGE_PIXELS) /
        Math.max(whole.width, whole.height),
    });
    const canvas = createCanvas(
      Math.round(viewport.width),
      Math.round(viewport.height),
    );
    const context = canvas.getContext("2d");
    // A page is drawn on white, as printed.
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      annotationMode: AnnotationMode.DISABLE,
    }).promise;
    const content = await page.getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
      )
      .join("")
      .trim();
    return {
      ok: true,
      png: new Uint8Array(await canvas.encode("png")),
      text: text === "" ? undefined : text,
    };
  } catch {
    // The page doesn't draw: that is the answer, not an error.
    return { ok: false, reason: "broken" };
  } finally {
    await task.destroy();
  }
}

const asked = workerData as Task;
const answer: Inspected | Drawn =
  asked.task === "inspect"
    ? await look(asked.bytes)
    : await drawPage(asked.bytes, asked.page, asked.full);
const bytes =
  "display" in answer
    ? answer.display
    : "png" in answer
      ? answer.png
      : undefined;
parentPort?.postMessage(answer, bytes ? [bytes.buffer as ArrayBuffer] : []);
