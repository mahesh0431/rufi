// The reader pack's scoring and its choice of documents, apart from the
// live run, so they can be checked on known answers.
import type { Expected } from "../tests/pack/reports.ts";

/** A draft item the reader made, as the pack scores it. */
export interface Draft {
  page: number;
  fields: {
    test_name: string;
    value_text: string;
    value_number?: number;
    comparator?: string;
    column?: string;
    date?: { iso?: string };
  };
  unsure: boolean;
}

/** Text compared as the pack compares it: case, spacing and marks aside. */
export const norm = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}<>.,%-]/gu, "");

/**
 * The drafts against the answer key: values correct, missed, wrong (marked
 * unsure or not), extra, and items whose own date the key scores and the
 * reader got wrong (a measurement's: the visit's, or none). A value is
 * correct when its printed text, its number and its comparator all are.
 */
export function scoreItems(key: readonly Expected[], drafts: readonly Draft[]) {
  const score = {
    correct: 0,
    missed: 0,
    wrongFlagged: 0,
    wrongSilent: 0,
    extra: 0,
    wrongItemDates: 0,
    wrong: [] as string[],
  };
  const used = new Set<Draft>();
  for (const want of key) {
    const found = drafts.find(
      (d) =>
        !used.has(d) &&
        d.page === want.page &&
        d.fields.column !== "earlier" &&
        norm(d.fields.test_name) === norm(want.test),
    );
    if (!found) {
      score.missed++;
      continue;
    }
    used.add(found);
    const date = found.fields.date?.iso ?? null;
    if (want.date !== undefined && date !== want.date) {
      score.wrongItemDates++;
      score.wrong.push(
        `p${String(want.page)} ${want.test}: date ${date ?? "none"} for ${want.date ?? "none"}`,
      );
    }
    const { value_text, value_number, comparator } = found.fields;
    const problems = [
      ...(norm(value_text) === norm(want.value)
        ? []
        : [`"${value_text}" for "${want.value}"`]),
      ...((value_number ?? null) === want.number
        ? []
        : [
            `number ${String(value_number ?? "none")} for ${String(want.number ?? "none")}`,
          ]),
      ...(comparator === want.comparator
        ? []
        : [
            `comparator ${comparator ?? "none"} for ${want.comparator ?? "none"}`,
          ]),
    ];
    if (problems.length === 0) score.correct++;
    else {
      if (found.unsure) score.wrongFlagged++;
      else score.wrongSilent++;
      score.wrong.push(
        `p${String(want.page)} ${want.test}: ${problems.join(", ")}${found.unsure ? " (unsure)" : ""}`,
      );
    }
  }
  score.extra = drafts.filter(
    (d) => !used.has(d) && d.fields.column !== "earlier",
  ).length;
  return score;
}

/**
 * The documents to read: with `only`, those named from either set, each
 * once; with `all`, the whole pack; otherwise the dense set.
 */
export function chooseItems<T extends { name: string }>(
  dense: readonly T[],
  pack: readonly T[],
  { only, all }: { only?: readonly string[]; all: boolean },
): readonly T[] {
  if (only === undefined) return all ? pack : dense;
  const byName = new Map([...dense, ...pack].map((item) => [item.name, item]));
  return [...byName.values()].filter((item) => only.includes(item.name));
}

// --- Page copies: scored row by row against the rows each page must hold,
// so a copy may lay the page out in its own way (a Markdown or an HTML
// table, bold or not, a line or a row) and still score in full.

/** A row a copy must hold: its label and every other cell, as printed. */
interface KeyRow {
  label: string;
  cells: readonly string[];
}

/** A hard-to-read part of a page, and what is truly there. */
interface KeyDoubt {
  row: string;
  truth: readonly string[];
  /** A printed value crossed out by hand, which a copy should show as crossed out. */
  crossed?: string;
}

/** What a copy did with a hard-to-read part. */
type DoubtOutcome =
  /** Marked as unclear (its best reading or none). */
  | "marked"
  /** Marked, but a crossed-out value is copied as if it stood. */
  | "marked, crossing-out not shown"
  /** Copied right, and not marked. */
  | "right, not marked"
  /** Guessed wrong, and not marked: a silent error. */
  | "wrong, not marked"
  /** Its row isn't in the copy. */
  | "missing";

/** The ways a copy marks what it isn't sure of, as the reader is told to. */
const MARK =
  /\?|~~|\[[^\]]*\]|unclear|illegible|unreadable|smudg|obscur|uncertain|handwrit|crossed|struck/i;

/**
 * A marked part of a line that isn't a table row: struck text, a token
 * with a [note] or a "?" in it, or a note in brackets that says why.
 */
const MARKED_PART =
  /~~[^~]*~~|\S*\[[^\]]*\]\S*|\S*\?\S*|\([^)]*(?:unclear|illegible|unreadable|smudg|obscur|uncertain|handwrit|crossed|struck)[^)]*\)/gi;

/** How a copy shows text crossed out: struck through, or said in words. */
const CROSSED = /~~|cross|struck|strike/i;

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A copy as lines of plain text: an HTML table row on one line, struck
 * text as ~~, other tags and Markdown emphasis left out, entities and
 * escapes read, dashes and spaces made alike. Cell borders become " | ".
 */
export function copyLines(copy: string): string[] {
  return copy
    .replace(/<\/?(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (row) =>
      row.replace(/\s*\n\s*/g, " "),
    )
    .split("\n")
    .map((line) =>
      plain(
        line
          .replace(/<\/t[dh]>/gi, " | ")
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, ""),
      ),
    )
    .filter((line) => line.replace(/[|\s-]/g, "") !== "");
}

/** Text as copies are compared: entities read, emphasis out, dashes and spaces alike. */
function plain(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1]?.toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/(\d)\s*-\s*(\d)/g, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where `text` holds `cell` whole, from `from` on: "6.8" isn't in "16.8",
 * "6.85", "-6.8" or "<6.8", and "<0.5" isn't in "0.5".
 */
function find(text: string, cell: string, from = 0) {
  const escaped = plain(cell).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = new RegExp(
    `(?<![\\p{L}\\p{N}<>≤≥+\\-]|\\p{N}[.,])${escaped}(?![\\p{L}\\p{N}]|[.,\\-]\\p{N})`,
    "giu",
  );
  whole.lastIndex = from;
  const match = whole.exec(text);
  return match
    ? { at: match.index, end: match.index + match[0].length }
    : undefined;
}

/** The numbers in a text: "12", "0.92", "12,9". */
const numbers = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * A line's marked parts: in a table row each cell with a mark, elsewhere
 * each marked token. A mark excuses only its own part.
 */
function markedParts(line: string) {
  const parts: { at: number; end: number }[] = [];
  if (line.includes("|")) {
    let at = 0;
    for (const cell of line.split("|")) {
      if (MARK.test(cell)) parts.push({ at, end: at + cell.length });
      at += cell.length + 1;
    }
  } else {
    for (const m of line.matchAll(MARKED_PART))
      parts.push({ at: m.index, end: m.index + m[0].length });
  }
  return parts;
}

/** The line with its marked parts blanked out, each character's place kept. */
const unmarked = (
  line: string,
  parts: readonly { at: number; end: number }[],
) =>
  parts.reduce(
    (text, p) =>
      text.slice(0, p.at) + " ".repeat(p.end - p.at) + text.slice(p.end),
    line,
  );

/** What a line holding a row's label did with each of its cells. */
interface RowCopy {
  line: string;
  /** Cells copied as printed, in their order after the label. */
  found: string[];
  /** Cells in a marked part, or where a marked part stands for them. */
  marked: string[];
  /** Cells missing or changed, with no mark of their own. */
  wrong: string[];
}

/**
 * A line against a row of the key. Its cells are looked for in their
 * order after the label, outside the marked parts: a value in another
 * column, or with another sign or comparator, isn't the cell. A cell in a
 * marked part is marked; a cell missing where a marked part stands
 * between the cells around it is marked too (the reader's own reading of a
 * smudge, "1[0?]4", holds no "104"). Any other cell is wrong.
 */
function rowCopy(row: KeyRow, line: string, label: { end: number }): RowCopy {
  const parts = markedParts(line).filter((p) => p.end > label.end);
  const clean = unmarked(line, parts);
  type Place = { at: number; end: number; how: "found" | "marked" } | undefined;
  const places: Place[] = [];
  let cursor = label.end;
  for (const cell of row.cells) {
    const found = find(clean, cell, cursor);
    if (found) {
      places.push({ ...found, how: "found" });
      cursor = found.end;
      continue;
    }
    const inPart = parts
      .map((p) => find(line.slice(0, p.end), cell, p.at))
      .find((f) => f !== undefined);
    if (inPart) {
      places.push({ ...inPart, how: "marked" });
      cursor = Math.max(cursor, inPart.end);
      continue;
    }
    places.push(undefined);
  }
  const copy: RowCopy = { line, found: [], marked: [], wrong: [] };
  row.cells.forEach((cell, i) => {
    const place = places[i];
    if (place) {
      copy[place.how].push(cell);
      return;
    }
    const before = places
      .slice(0, i)
      .reduce((end, p) => Math.max(end, p?.end ?? 0), label.end);
    const after = places
      .slice(i + 1)
      .reduce((at, p) => Math.min(at, p?.at ?? line.length), line.length);
    const standsIn = parts.some((p) => p.at >= before && p.at < after);
    copy[standsIn ? "marked" : "wrong"].push(cell);
  });
  return copy;
}

/**
 * A page's copy against its key: rows found whole; rows missed (no line
 * holds the label with any of its cells); every line of a row with a cell
 * missing or changed (marked unclear or not); rows copied more than once,
 * the same or not; numbers outside the marked parts that the hand-checked
 * copy doesn't hold (invented or changed); and each doubt's outcome.
 */
export function scoreCopy(
  key: { rows: readonly KeyRow[]; doubts: readonly KeyDoubt[]; hand: string },
  copy: string,
) {
  const lines = copyLines(copy);
  const score = {
    rows: key.rows.length,
    found: 0,
    missed: [] as string[],
    changed: [] as { row: string; wrong: string[]; marked: string[] }[],
    duplicated: [] as string[],
    invented: [] as string[],
    doubts: [] as { row: string; outcome: DoubtOutcome; line?: string }[],
  };
  const copied = new Map<string, RowCopy[]>();
  for (const row of key.rows) {
    // Its name elsewhere (a note that names the test) isn't the row.
    const candidates = lines.flatMap((line) => {
      const label = find(line, row.label);
      if (!label) return [];
      const copy = rowCopy(row, line, label);
      return row.cells.length === 0 || copy.wrong.length < row.cells.length
        ? [copy]
        : [];
    });
    copied.set(row.label, candidates);
    if (candidates.length === 0) {
      score.missed.push(row.label);
      continue;
    }
    if (row.cells.length > 0 && candidates.length > 1)
      score.duplicated.push(row.label);
    const changed = candidates.filter(
      (c) => c.wrong.length > 0 || c.marked.length > 0,
    );
    if (changed.length === 0) score.found++;
    for (const c of changed)
      score.changed.push({ row: row.label, wrong: c.wrong, marked: c.marked });
  }
  const known = new Set(numbers(plain(key.hand)));
  score.invented = lines
    .flatMap((line) => numbers(unmarked(line, markedParts(line))))
    .filter((n) => !known.has(n));
  for (const doubt of key.doubts) {
    const best = (copied.get(doubt.row) ?? []).reduce<RowCopy | undefined>(
      (a, b) => (a === undefined || b.wrong.length < a.wrong.length ? b : a),
      undefined,
    );
    if (best === undefined) {
      score.doubts.push({ row: doubt.row, outcome: "missing" });
      continue;
    }
    const outcome: DoubtOutcome = doubt.truth.some((t) =>
      best.marked.includes(t),
    )
      ? doubt.crossed !== undefined && !CROSSED.test(best.line)
        ? "marked, crossing-out not shown"
        : "marked"
      : doubt.truth.every((t) => best.found.includes(t))
        ? "right, not marked"
        : "wrong, not marked";
    score.doubts.push({ row: doubt.row, outcome, line: best.line });
  }
  return score;
}

/** A copy's silent errors: changed without a mark, invented numbers, wrong guesses. */
export const silent = (score: ReturnType<typeof scoreCopy>) =>
  score.changed.filter((c) => c.wrong.length > 0).length +
  score.invented.length +
  score.doubts.filter((d) => d.outcome === "wrong, not marked").length;

/** A set's copies added up; a page with no copy counts all its rows missed. */
export function tally(
  pages: readonly {
    key: Parameters<typeof scoreCopy>[0];
    copy: string | undefined;
  }[],
) {
  const totals = {
    pages: pages.length,
    copied: 0,
    rows: 0,
    found: 0,
    missed: 0,
    changedSilent: 0,
    changedMarked: 0,
    duplicated: 0,
    invented: 0,
    silent: 0,
  };
  for (const { key, copy } of pages) {
    totals.rows += key.rows.length;
    if (copy === undefined) {
      totals.missed += key.rows.length;
      continue;
    }
    const score = scoreCopy(key, copy);
    totals.copied++;
    totals.found += score.found;
    totals.missed += score.missed.length;
    totals.changedSilent += score.changed.filter(
      (c) => c.wrong.length > 0,
    ).length;
    totals.changedMarked += score.changed.filter(
      (c) => c.wrong.length === 0,
    ).length;
    totals.duplicated += score.duplicated.length;
    totals.invented += score.invented.length;
    totals.silent += silent(score);
  }
  return totals;
}
