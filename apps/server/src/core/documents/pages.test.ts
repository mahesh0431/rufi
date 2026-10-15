// The page service and get_documents on a real database and real files: a
// PDF page drawn once with its own text and kept as a cache, photos as they
// are, a page that can't be drawn, whose documents can be read, lists in
// parts with a continuation, and the person's fix beside what the reader read.
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { PART } from "../tools/documents.ts";
import type { ToolContext } from "../tools/registry.ts";
import { forAgent } from "../tools/tools.ts";
import { documents, type NewFile } from "./documents.ts";
import { draftItems } from "./items.ts";
import { displayPath, originalPath, pagePath } from "./originals.ts";
import { pages, type PageView } from "./pages.ts";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");
const fixture = async (file: string): Promise<NewFile> => ({
  name: file,
  bytes: new Uint8Array(await readFile(join(FIXTURES, file))),
});

/** A fictional PDF that says it has two pages; page 2 isn't in the file. */
function brokenPdf(): NewFile {
  const content = "BT /F1 12 Tf 40 800 Td (Fictional page one) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return { name: "broken.pdf", bytes: new TextEncoder().encode(text) };
}

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-pages-"));
  store = openWritable(databasePath(home));
  store.db.exec(`INSERT INTO people (id, display_name) VALUES
    ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')`);
  return () => {
    store.close();
  };
});

const add = async (personId: string, ...files: NewFile[]) =>
  (await documents(store, home).add(personId, files, false)).added;

const ok = (view: PageView | undefined) => {
  if (!view?.ok) throw new Error(`not a page: ${JSON.stringify(view)}`);
  return view;
};

describe("the page service", () => {
  it("draws a PDF page with its own text, keeps it, and draws it again when the copy is gone", async () => {
    const [id = ""] = await add(
      "asha",
      await fixture("sunrise-labs-august.pdf"),
    );
    const service = pages(store, home);

    const page = ok(await service.page("asha", id, 2));
    expect(page).toMatchObject({
      position: 2,
      pages: 2,
      fileName: "sunrise-labs-august.pdf",
      image: { mediaType: "image/png" },
    });
    expect(page.text).toContain("Sunrise Labs · Test report · page 2");
    const image = await loadImage(Buffer.from(page.image.bytes));
    expect([image.width, image.height]).toEqual([1131, 1600]);

    const fileId = store.db
      .prepare("SELECT file_id FROM document_pages WHERE document_id = ?")
      .get(id)?.["file_id"] as string;
    const kept = await readFile(pagePath(home, fileId, 2));
    expect(Buffer.from(page.image.bytes).equals(kept)).toBe(true);

    await rm(join(home, "cache"), { recursive: true });
    const again = ok(await service.page("asha", id, 2));
    expect(Buffer.from(again.image.bytes).equals(kept)).toBe(true);
    expect(again.text).toBe(page.text);
  });

  it("gives a JPEG as it came and a HEIC as its display copy, with no text", async () => {
    const [jpeg = "", heic = ""] = await add(
      "asha",
      await fixture("thyroid-recheck.jpg"),
      await fixture("sideways.heic"),
    );
    const service = pages(store, home);
    const fileOf = (documentId: string) =>
      store.db
        .prepare("SELECT file_id FROM document_pages WHERE document_id = ?")
        .get(documentId)?.["file_id"] as string;

    const photo = ok(await service.page("asha", jpeg, 1));
    expect(photo.image.mediaType).toBe("image/jpeg");
    expect(photo.text).toBeUndefined();
    expect(
      Buffer.from(photo.image.bytes).equals(
        await readFile(originalPath(home, fileOf(jpeg))),
      ),
    ).toBe(true);

    await rm(join(home, "cache"), { recursive: true });
    const display = ok(await service.page("asha", heic, 1));
    expect(display.image.mediaType).toBe("image/jpeg");
    expect(
      Buffer.from(display.image.bytes).equals(
        await readFile(displayPath(home, fileOf(heic))),
      ),
    ).toBe(true);
  });

  it("says a page that can't be drawn couldn't be prepared, and the other pages still come", async () => {
    const [id = ""] = await add("asha", brokenPdf());
    const service = pages(store, home);
    expect(ok(await service.page("asha", id, 1)).text).toBe(
      "Fictional page one",
    );
    expect(await service.page("asha", id, 2)).toEqual({
      position: 2,
      pages: 2,
      fileName: "broken.pdf",
      ok: false,
      reason: "couldnt_prepare",
    });
  });

  it("has nothing for another person's document or a page past the end", async () => {
    const [id = ""] = await add("asha", await fixture("ravi-lipid-panel.pdf"));
    const service = pages(store, home);
    expect(await service.page("ravi", id, 1)).toBeUndefined();
    expect(await service.count("ravi", id)).toBe(0);
    expect(await service.page("asha", id, 2)).toBeUndefined();
    expect(await service.count("asha", id)).toBe(1);
  });
});

describe("get_documents", () => {
  const call = async (context: Partial<ToolContext>, input: unknown) => {
    const answer = await forAgent(
      () => ({ store, pages: pages(store, home), ...context }) as ToolContext,
      () => undefined,
    ).forTurn()("get_documents", input);
    return {
      ...answer,
      body: JSON.parse(answer.text) as Record<string, unknown>,
    };
  };

  it("lists the person's documents newest first, in parts with a continuation", async () => {
    const total = PART.documents + 2;
    for (let n = 1; n <= total; n++) {
      const at = `2026-08-${String(Math.ceil(n / 4)).padStart(2, "0")}T09:00:00.000Z`;
      store.db.exec(`
        INSERT INTO files (id, size, media_type, created_at) VALUES ('${String(n).padStart(64, "0")}', 1, 'application/pdf', '${at}');
        INSERT INTO documents (id, person_id, added_at, added_from) VALUES ('d${String(n).padStart(3, "0")}', 'asha', '${at}', 'documents_page');
        INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name)
          VALUES ('asha', 'd${String(n).padStart(3, "0")}', 1, '${String(n).padStart(64, "0")}', 1, 'report ${String(n)}.pdf');`);
    }
    await add("ravi", await fixture("ravi-lipid-panel.pdf"));

    const first = await call({ personId: "asha" }, {});
    const listed = first.body["result"] as {
      documents: { id: string }[];
      next?: string;
    };
    expect(listed.documents).toHaveLength(PART.documents);
    expect(listed.documents[0]).toEqual({
      id: "d052",
      added_at: "2026-08-13T09:00:00.000Z",
      kind: null,
      date: null,
      status: "not_read",
      files: [{ name: "report 52.pdf", pages: 1 }],
    });
    const rest = await call({ personId: "asha" }, { after: listed.next });
    const more = rest.body["result"] as {
      documents: { id: string }[];
      next?: string;
    };
    expect(more.documents.map((d) => d.id)).toEqual(["d002", "d001"]);
    expect(more.next).toBeUndefined();
    // Every document once, newest first, none of Ravi's.
    const ids = [...listed.documents, ...more.documents].map((d) => d.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(ids).size).toBe(total);
  });

  it("continues a document's 101 pages once each, and shows a page image with its text", async () => {
    const [id = ""] = await add(
      "asha",
      await fixture("sunrise-labs-august.pdf"),
    );
    // Page rows alone exercise continuation; no large fixture PDF is needed.
    const file = store.db
      .prepare(
        "SELECT file_id FROM document_pages WHERE document_id = ? AND position = 1",
      )
      .get(id)?.["file_id"] as string;
    const insert = store.db.prepare(`INSERT INTO document_pages
      (person_id, document_id, position, file_id, page_in_file, file_name)
      VALUES ('asha', ?, ?, ?, ?, 'sunrise-labs-august.pdf')`);
    for (let position = 3; position <= 101; position++)
      insert.run(id, position, file, position);

    const document = await call({ personId: "asha" }, { document: id });
    const first = document.body["result"] as {
      pages: { page: number }[];
      next?: string;
    };
    expect(first).toMatchObject({
      document: { id, status: "not_read" },
      next: "pages:100",
    });
    expect(first.pages).toHaveLength(100);
    expect(first.pages.slice(0, 2)).toEqual([
      { page: 1, file: "sunrise-labs-august.pdf", page_in_file: 1 },
      { page: 2, file: "sunrise-labs-august.pdf", page_in_file: 2 },
    ]);
    const rest = await call(
      { personId: "asha" },
      { document: id, after: first.next },
    );
    const last = rest.body["result"] as {
      pages: { page: number }[];
      next?: string;
    };
    expect(last.pages).toEqual([
      { page: 101, file: "sunrise-labs-august.pdf", page_in_file: 101 },
    ]);
    expect(last.next).toBeUndefined();
    expect([...first.pages, ...last.pages].map((p) => p.page)).toEqual(
      Array.from({ length: 101 }, (_, i) => i + 1),
    );

    const page = await call({ personId: "asha" }, { document: id, page: 1 });
    expect(page.body).toEqual({
      ok: true,
      result: {
        document: id,
        page: 1,
        of: 101,
        file: "sunrise-labs-august.pdf",
        text: expect.stringContaining("page 1") as unknown,
      },
    });
    expect(page.images).toEqual([
      {
        mimeType: "image/png",
        data: expect.stringMatching(/^iVBORw0KGgo/) as unknown,
      },
    ]);
  });

  it("gives a fixed item what the reader read beside the person's fix, and an unfixed item as it is", async () => {
    const [id = ""] = await add(
      "asha",
      await fixture("sunrise-labs-august.pdf"),
    );
    const at = "2026-10-10T09:00:00.000Z";
    store.db
      .exec(`INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
      VALUES ('j1', 'asha', 'document_read', '${id}', 'done', 1, '[1,2]', '${at}')`);
    const haemoglobin = JSON.stringify({
      test_name: "Haemoglobin",
      value_text: "13.2",
      value_number: 13.2,
    });
    const insert = store.db.prepare(
      `INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at)
       VALUES (?, 'asha', ?, ?, 1, 'j1', 'lab_result', ?, ?, '${at}')`,
    );
    insert.run("i1", id, 1, haemoglobin, haemoglobin);
    insert.run("i2", id, 2, haemoglobin, haemoglobin);
    await draftItems(store, () => undefined).fix("asha", id, "i1", {
      version: 1,
      fields: { value_text: "12.8", unit: "g/dL" },
    });

    const { body } = await call({ personId: "asha" }, { document: id });
    const { items } = body["result"] as { items: Record<string, unknown>[] };
    expect(items).toEqual([
      {
        id: "i1",
        version: 2,
        page: 1,
        status: "not saved",
        test_name: "Haemoglobin",
        value_text: "12.8",
        value_number: 12.8,
        unit: "g/dL",
        fixed_by_user: true,
        reader_read: { value_text: "13.2", unit: null },
      },
      {
        id: "i2",
        version: 1,
        page: 2,
        status: "not saved",
        test_name: "Haemoglobin",
        value_text: "13.2",
        value_number: 13.2,
      },
    ]);
  });

  it("reads only the active person's documents, and refuses a page past the end", async () => {
    const [id = ""] = await add("asha", await fixture("ravi-lipid-panel.pdf"));
    for (const input of [{ document: id }, { document: id, page: 1 }]) {
      const theirs = await call({ personId: "ravi" }, input);
      expect(theirs.ok).toBe(false);
      expect(theirs.body["error"]).toBe(
        "There is no such document for this person: read the list for its id.",
      );
      expect(theirs.images).toBeUndefined();
    }
    const past = await call({ personId: "asha" }, { document: id, page: 2 });
    expect(past.body["error"]).toBe(
      "This document has no page 2; its pages are 1–1.",
    );
  });
});
