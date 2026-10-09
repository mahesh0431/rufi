// Looks at one file in a worker thread, so a big or broken file never holds
// up the chat: what it is by its content, a PDF's pages (pdf.js), a photo
// decoded once to know it opens, and a HEIC's display copy as JPEG
// (heic-decode, which applies the photo's own orientation; Rufi adds no
// rotation). Run by inspect.ts.
import { parentPort, workerData } from "node:worker_threads";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileTypeFromBuffer } from "file-type";
import decodeHeic from "heic-decode";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Inspected } from "./inspect.ts";

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

const answer = await look(workerData as Uint8Array);
parentPort?.postMessage(
  answer,
  answer.ok && answer.display ? [answer.display.buffer as ArrayBuffer] : [],
);
