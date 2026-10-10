// A small PDF writer for the fictional test pack: pages of text in
// Helvetica (WinAnsi), or pages that are one JPEG each (a scan, with no
// text). Enough to make lab reports that look printed; nothing more.

/** One piece of text on a page, from the top-left corner, in points. */
export interface Text {
  x: number;
  y: number;
  size: number;
  text: string;
  bold?: boolean;
}

const WIDTH = 595;
const HEIGHT = 842;

/** WinAnsi bytes for the few characters beyond ASCII the pack uses. */
const WIN_ANSI: Record<string, number> = {
  "–": 0x96,
  "·": 0xb7,
  µ: 0xb5,
  "°": 0xb0,
};

function bytesOf(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`No WinAnsi byte for ${ch}`);
    // Escaped in a PDF string: ( ) \
    if (ch === "(" || ch === ")" || ch === "\\") out.push(0x5c);
    out.push(code);
  }
  return out;
}

const ascii = (text: string) => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
  return out;
};

/** Writes objects into a PDF file with its cross-reference table. */
function assemble(objects: number[][]): Uint8Array {
  const out: number[] = [...ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(out.length);
    out.push(
      ...ascii(`${String(index + 1)} 0 obj\n`),
      ...object,
      ...ascii("\nendobj\n"),
    );
  }
  const xref = out.length;
  out.push(
    ...ascii(
      `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets
        .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(out);
}

const stream = (dict: string, body: number[]) => [
  ...ascii(`<< ${dict} /Length ${String(body.length)} >>\nstream\n`),
  ...body,
  ...ascii("\nendstream"),
];

/** A PDF of text pages. */
export function textPdf(pages: readonly (readonly Text[])[]): Uint8Array {
  // 1 catalog, 2 pages, 3 font, 4 bold font, then per page: page, content.
  const kids = pages.map((_, i) => `${String(5 + i * 2)} 0 R`).join(" ");
  const objects: number[][] = [
    ascii("<< /Type /Catalog /Pages 2 0 R >>"),
    ascii(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`),
    ascii(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ),
    ascii(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ),
  ];
  for (const [i, page] of pages.entries()) {
    const content: number[] = [];
    for (const t of page) {
      content.push(
        ...ascii(
          `BT /${t.bold ? "F2" : "F1"} ${String(t.size)} Tf ${t.x.toFixed(1)} ${(HEIGHT - t.y).toFixed(1)} Td (`,
        ),
        ...bytesOf(t.text),
        ...ascii(") Tj ET\n"),
      );
    }
    objects.push(
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(WIDTH)} ${String(HEIGHT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(6 + i * 2)} 0 R >>`,
      ),
      stream("", content),
    );
  }
  return assemble(objects);
}

/** A PDF whose pages are JPEG images only: a scan, with no text. */
export function scanPdf(
  jpegs: readonly { bytes: Uint8Array; width: number; height: number }[],
): Uint8Array {
  const kids = jpegs.map((_, i) => `${String(3 + i * 3)} 0 R`).join(" ");
  const objects: number[][] = [
    ascii("<< /Type /Catalog /Pages 2 0 R >>"),
    ascii(`<< /Type /Pages /Kids [${kids}] /Count ${String(jpegs.length)} >>`),
  ];
  for (const [i, jpeg] of jpegs.entries()) {
    const page = 3 + i * 3;
    objects.push(
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(WIDTH)} ${String(HEIGHT)}] /Resources << /XObject << /Im0 ${String(page + 2)} 0 R >> >> /Contents ${String(page + 1)} 0 R >>`,
      ),
      stream(
        "",
        ascii(`q ${String(WIDTH)} 0 0 ${String(HEIGHT)} 0 0 cm /Im0 Do Q`),
      ),
      stream(
        `/Type /XObject /Subtype /Image /Width ${String(jpeg.width)} /Height ${String(jpeg.height)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        [...jpeg.bytes],
      ),
    );
  }
  return assemble(objects);
}
