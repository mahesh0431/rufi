// A visit brief as an A4 PDF (docs/help/visit-brief.md), made from its saved
// data on each request and never stored: Rufi's dog, the title, where the
// brief came from, the record-changed line, the AI's Markdown laid out as
// the page lays it out (headings, paragraphs, lists, tables) and the
// Sources, with "Page N of M" at each page's foot.
import { createRequire } from "node:module";
import { svg } from "@rufi/brand/mark";
import type {
  List,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
} from "mdast";
import pdfmake, { type Content } from "pdfmake";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Kysely } from "kysely";
import type { Tables } from "../store/tables.ts";
import { madeOn, readBrief, type Brief } from "./briefs.ts";

const font = (name: string) =>
  createRequire(import.meta.url).resolve(`@rufi/brand/fonts/Inter-${name}.ttf`);
const FONTS = {
  Inter: {
    normal: font("Regular"),
    bold: font("SemiBold"),
    italics: font("Italic"),
    bolditalics: font("SemiBoldItalic"),
  },
};
const allowed = new Set(Object.values(FONTS.Inter));
pdfmake.setFonts(FONTS);
// Nothing is fetched, and only the font files are read.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => allowed.has(path));

/** Paper is light: the brand's light tokens (packages/brand/tokens.css). */
const INK = "#222222";
const MUTED = "#676767";
const LINE = "#e6e6e6";

const MM = 72 / 25.4;
/** An A4 sheet's width less its two 16 mm sides, in points. */
const WIDTH = 595.28 - 32 * MM;
/** The person's part of a file name, at most; the date and ".pdf" stay. */
const NAME_MAX = 60;

/** A brief's PDF and its file name; undefined when there is no such brief. */
export async function briefPdf(
  query: Kysely<Tables>,
  personId: string,
  briefId: string,
): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  const brief = await readBrief(query, personId, briefId);
  if (!brief) return undefined;
  const { display_name: name } = await query
    .selectFrom("people")
    .select("display_name")
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  const short =
    name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
  const title = `Visit brief – ${short} – ${madeOn(brief.createdAt)}`;
  return { name: `${title}.pdf`, bytes: await drawn(brief, title) };
}

type Definition = Parameters<typeof pdfmake.createPdf>[0];

async function drawn(brief: Brief, title: string): Promise<Uint8Array> {
  const markdown = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(brief.markdown);
  const dog = svg({
    palette: "onPeriwinkle",
    expression: "calm",
    size: 24,
    ground: "tile",
    motion: false,
  });
  const doc: Definition = {
    pageSize: "A4",
    pageMargins: [16 * MM, 16 * MM, 16 * MM, 18 * MM],
    info: { title, creator: "Rufi" },
    defaultStyle: { font: "Inter", fontSize: 10, lineHeight: 1.3, color: INK },
    styles: {
      title: { fontSize: 16, bold: true },
      h2: { fontSize: 12.5, bold: true, margin: [0, 6, 0, 4] },
      h3: { fontSize: 10.5, bold: true, margin: [0, 6, 0, 3] },
    },
    footer: (page, pages) => ({
      text: `Page ${String(page)} of ${String(pages)}`,
      alignment: "right",
      fontSize: 7,
      color: MUTED,
      margin: [0, 6 * MM, 16 * MM, 0],
    }),
    content: [
      {
        columns: [
          { svg: dog, width: 20, height: 20, margin: [0, 2, 0, 0] },
          {
            stack: [
              { text: "Visit brief", style: "title" },
              {
                text: brief.origin,
                color: MUTED,
                fontSize: 9,
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
        columnGap: 10,
        margin: [0, 0, 0, 12],
      },
      ...(brief.changedSince
        ? ([
            {
              text: "The record changed since this brief was made. The brief stays as it was; ask Rufi in the chat for a new one to include the changes.",
              fontSize: 9,
              margin: [0, 0, 0, 10],
            },
          ] satisfies Content[])
        : []),
      ...markdown.children.map(block),
      { text: "Sources", style: "h2", margin: [0, 14, 0, 2] },
      {
        text: "The records this brief rests on, as Rufi has them saved.",
        color: MUTED,
        fontSize: 9,
        margin: [0, 0, 0, 6],
      },
      sources(brief),
    ],
  };
  return new Uint8Array(await pdfmake.createPdf(doc).getBuffer());
}

/** The Sources as the page lists them: the kind, then what and where from. */
function sources(brief: Brief): Content {
  if (brief.sources.length === 0) return { text: "" };
  return {
    table: {
      widths: [80, "*"],
      body: brief.sources.map((source) => [
        { text: source.kind, color: MUTED },
        {
          stack: [
            {
              text: [
                source.what,
                ...(source.changedSince
                  ? [{ text: "  changed since", color: MUTED, fontSize: 8 }]
                  : []),
              ],
            },
            { text: source.from, color: MUTED, fontSize: 8 },
          ],
        },
      ]),
    },
    layout: {
      hLineWidth: (i, node) =>
        i === 0 || i === node.table.body.length ? 0 : 0.5,
      vLineWidth: () => 0,
      hLineColor: () => LINE,
      paddingLeft: () => 0,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
}

type Marks = { bold?: boolean; italics?: boolean; decoration?: "lineThrough" };

/** A run of Markdown text with its bold, italics and strike-through. */
function inline(
  nodes: readonly PhrasingContent[],
  marks: Marks = {},
): Content[] {
  return nodes.flatMap((node): Content[] => {
    switch (node.type) {
      case "text":
      case "inlineCode":
        return [{ text: node.value, ...marks }];
      case "strong":
        return inline(node.children, { ...marks, bold: true });
      case "emphasis":
        return inline(node.children, { ...marks, italics: true });
      case "delete":
        return inline(node.children, { ...marks, decoration: "lineThrough" });
      // The page shows a link's words without the link.
      case "link":
      case "linkReference":
        return inline(node.children, marks);
      case "break":
        return [{ text: "\n" }];
      // Not shown, as on the page: raw HTML, images and footnotes.
      case "html":
      case "image":
      case "imageReference":
      case "footnoteReference":
        return [];
    }
  });
}

function list(node: List): Content {
  const items = node.children.map((item) => {
    const parts = item.children.map(block);
    return parts.length === 1 ? (parts[0] ?? "") : { stack: parts };
  });
  return node.ordered
    ? { ol: items, margin: [0, 2, 0, 6] }
    : { ul: items, margin: [0, 2, 0, 6] };
}

function table(node: Table): Content {
  const cell = (bold: boolean) => (c: TableCell) => ({
    text: inline(c.children),
    bold,
  });
  const [head, ...rows] = node.children;
  return {
    table: {
      headerRows: 1,
      widths: (head?.children ?? []).map(() => "auto"),
      body: [
        (head?.children ?? []).map(cell(true)),
        ...rows.map((row) => row.children.map(cell(false))),
      ],
    },
    layout: {
      hLineWidth: (i) => (i === 0 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => LINE,
      paddingLeft: () => 4,
      paddingRight: () => 8,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    margin: [0, 2, 0, 8],
  };
}

function block(node: RootContent): Content {
  switch (node.type) {
    case "heading":
      return {
        text: inline(node.children),
        style: node.depth <= 2 ? "h2" : "h3",
      };
    case "paragraph":
      return { text: inline(node.children), margin: [0, 0, 0, 6] };
    case "list":
      return list(node);
    case "table":
      return table(node);
    case "blockquote":
      return {
        stack: node.children.map(block),
        margin: [10, 0, 0, 6],
        color: MUTED,
      };
    case "code":
      return { text: node.value, margin: [0, 0, 0, 6] };
    case "thematicBreak":
      return {
        canvas: [
          {
            type: "line",
            x1: 0,
            y1: 0,
            x2: WIDTH,
            y2: 0,
            lineWidth: 0.5,
            lineColor: LINE,
          },
        ],
        margin: [0, 4, 0, 8],
      };
    // Words outside a paragraph, which Markdown doesn't make.
    case "break":
    case "delete":
    case "emphasis":
    case "inlineCode":
    case "link":
    case "linkReference":
    case "strong":
    case "text":
      return { text: inline([node]) };
    // Not shown, as on the page: raw HTML, link definitions, footnotes,
    // images and front matter; the parts of lists and tables, which their
    // list or table draws.
    case "html":
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
    case "image":
    case "imageReference":
    case "yaml":
    case "listItem":
    case "tableCell":
    case "tableRow":
      return "";
  }
}
