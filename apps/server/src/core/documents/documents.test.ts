// Adding documents on a real database and real files: what is kept, how
// photos group, the same content twice, files Rufi refuses, HEIC display
// copies, and whose files can be shown.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { documents, NotADocument, type NewFile } from "./documents.ts";
import { displayPath, filesPath } from "./originals.ts";
import { addSent } from "../../../tests/sent.ts";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/documents");
const fixture = async (file: string, name = file): Promise<NewFile> => ({
  name,
  bytes: new Uint8Array(await readFile(join(FIXTURES, file))),
});
/** A fictional photo of `width` × `height`, as PNG or JPEG. */
const photo = async (
  name: string,
  shade: string,
  format: "png" | "jpeg" = "png",
): Promise<NewFile> => {
  const canvas = createCanvas(30, 40);
  const context = canvas.getContext("2d");
  context.fillStyle = shade;
  context.fillRect(0, 0, 30, 40);
  return { name, bytes: new Uint8Array(await canvas.encode(format as "png")) };
};

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-documents-"));
  store = openWritable(databasePath(home));
  store.db.exec(`INSERT INTO people (id, display_name) VALUES
    ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')`);
  return () => {
    store.close();
  };
});

const pages = () =>
  store.db
    .prepare(
      "SELECT document_id, position, page_in_file, file_name FROM document_pages ORDER BY document_id, position",
    )
    .all()
    .map((row) => ({ ...row }));

describe("adding documents", () => {
  it("keeps a PDF exactly as it came, as one document with a page per PDF page", async () => {
    const pdf = await fixture("sunrise-labs-august.pdf", "Sunrise August.pdf");
    const docs = documents(store, home, () => "2026-10-10T09:00:00.000Z");

    const { added, already } = await addSent(docs, store, "asha", [pdf]);

    expect(already).toEqual([]);
    expect(await docs.list("asha")).toEqual([
      {
        id: added[0],
        addedAt: "2026-10-10T09:00:00.000Z",
        kind: null,
        date: null,
        lab: null,
        place: null,
        status: "not_read",
        reader: null,
        reading: null,
        notSorted: false,
        files: [
          {
            id: "7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54",
            name: "Sunrise August.pdf",
            mediaType: "application/pdf",
            pages: 2,
          },
        ],
      },
    ]);
    expect(
      await readFile(
        join(
          filesPath(home),
          "7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54",
        ),
      ),
    ).toEqual(Buffer.from(pdf.bytes));
  });

  it("makes photos added together one document, in the order they came, and a PDF its own", async () => {
    const docs = documents(store, home);
    const files = [
      await photo("page-1.png", "#111111"),
      await fixture("ravi-lipid-panel.pdf", "lipid.pdf"),
      await photo("page-2.jpg", "#222222", "jpeg"),
      await photo("page-3.png", "#333333"),
    ];

    const { added } = await docs.add("asha", files, true);

    expect(added).toHaveLength(2);
    const [photos, pdf] = added;
    expect(pages()).toEqual(
      expect.arrayContaining([
        {
          document_id: photos,
          position: 1,
          page_in_file: 1,
          file_name: "page-1.png",
        },
        {
          document_id: photos,
          position: 2,
          page_in_file: 1,
          file_name: "page-2.jpg",
        },
        {
          document_id: photos,
          position: 3,
          page_in_file: 1,
          file_name: "page-3.png",
        },
        {
          document_id: pdf,
          position: 1,
          page_in_file: 1,
          file_name: "lipid.pdf",
        },
      ]),
    );
    expect(pages()).toHaveLength(4);
  });

  it("makes each photo its own document when they aren't together", async () => {
    const docs = documents(store, home);

    const { added } = await addSent(
      docs,
      store,
      "asha",
      [await photo("a.png", "#111111"), await photo("b.png", "#222222")],
      false,
    );

    expect(added).toHaveLength(2);
    expect((await docs.list("asha")).map((d) => d.files.length)).toEqual([
      1, 1,
    ]);
  });

  it("never adds the same content twice for a person, also under another name", async () => {
    const docs = documents(store, home);
    const first = await addSent(
      docs,
      store,
      "asha",
      [await fixture("thyroid-recheck.jpg")],
      true,
    );

    const again = await addSent(
      docs,
      store,
      "asha",
      [
        await fixture("thyroid-recheck.jpg", "renamed.jpg"),
        await fixture("ravi-lipid-panel.pdf", "lipid.pdf"),
        await fixture("ravi-lipid-panel.pdf", "lipid copy.pdf"),
      ],
      true,
    );

    expect(again.added).toHaveLength(1);
    expect(again.already).toEqual([
      { name: "renamed.jpg", documentId: first.added[0] },
      { name: "lipid copy.pdf", documentId: again.added[0] },
    ]);
    expect(await docs.list("asha")).toHaveLength(2);
  });

  it("adds the same content for another person, and two files with one name as two documents", async () => {
    const docs = documents(store, home);
    await addSent(docs, store, "asha", [await photo("scan.png", "#111111")]);

    await addSent(docs, store, "ravi", [await photo("scan.png", "#111111")]);
    await addSent(docs, store, "asha", [await photo("scan.png", "#999999")]);

    expect(await docs.list("ravi")).toHaveLength(1);
    expect(await docs.list("asha")).toHaveLength(2);
  });

  it.each([
    [
      "a text file",
      { name: "notes.pdf", bytes: new TextEncoder().encode("Fictional notes") },
      "not_accepted",
    ],
    ["a PDF with a password", "locked.pdf", "locked"],
    [
      "a broken PDF",
      {
        name: "cut.pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<"),
      },
      "broken",
    ],
    [
      "a broken photo",
      {
        name: "cut.jpg",
        bytes: new Uint8Array([
          0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0,
        ]),
      },
      "broken",
    ],
  ] as const)(
    "refuses %s, and keeps nothing of that add",
    async (_what, refused, reason) => {
      const docs = documents(store, home);
      const file =
        typeof refused === "string" ? await fixture(refused) : refused;

      const adding = docs.add(
        "asha",
        // A HEIC first: neither its original nor its display copy is kept.
        [await fixture("sideways.heic"), file],
        true,
      );

      await expect(adding).rejects.toThrow(NotADocument);
      await expect(adding).rejects.toMatchObject({ file: file.name, reason });
      expect(await docs.list("asha")).toEqual([]);
      // No original and no display copy: only the database and its journal.
      expect(
        (await readdir(home)).filter((name) => !name.startsWith("rufi.sqlite")),
      ).toEqual([]);
    },
  );
});

describe("showing a file", () => {
  it("shows a sideways HEIC upright through its JPEG copy, made again when it's missing", async () => {
    const docs = documents(store, home);
    const { added } = await addSent(
      docs,
      store,
      "asha",
      [await fixture("sideways.heic")],
      true,
    );
    const [document] = await docs.list("asha");
    const id = document?.files[0]?.id ?? "";
    await rm(displayPath(home, id));

    const shown = await docs.file("asha", added[0] ?? "", id, true);

    expect(shown).toEqual({
      path: displayPath(home, id),
      mediaType: "image/jpeg",
    });
    // Stored 200 × 100, black on the left, turned a quarter right by the
    // photo's own orientation: upright it is 100 × 200, black on top.
    const image = await loadImage(await readFile(displayPath(home, id)));
    expect([image.width, image.height]).toEqual([100, 200]);
    const canvas = createCanvas(100, 200);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    expect(context.getImageData(50, 20, 1, 1).data[0]).toBeLessThan(40);
    expect(context.getImageData(50, 180, 1, 1).data[0]).toBeGreaterThan(215);
  });

  it("shows a file only for the person and document that hold it", async () => {
    const docs = documents(store, home);
    const { added } = await addSent(
      docs,
      store,
      "asha",
      [await fixture("thyroid-recheck.jpg")],
      true,
    );
    const other = await addSent(
      docs,
      store,
      "asha",
      [await photo("other.png", "#111111")],
      true,
    );
    const [, document] = await docs.list("asha");
    const id = document?.files[0]?.id ?? "";

    expect(await docs.file("asha", added[0] ?? "", id, false)).toEqual({
      path: join(filesPath(home), id),
      mediaType: "image/jpeg",
    });
    expect(await docs.file("ravi", added[0] ?? "", id, false)).toBeUndefined();
    expect(
      await docs.file("asha", other.added[0] ?? "", id, false),
    ).toBeUndefined();
    expect(
      await docs.file("asha", added[0] ?? "", "../rufi.sqlite", false),
    ).toBeUndefined();
  });
});
