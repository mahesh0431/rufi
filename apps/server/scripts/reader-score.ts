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
  /** A word a note about it would use, outside its row. */
  mention: string;
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

/** Whether `line` holds `cell` as a whole: "6.8" isn't in "16.8" or "6.85". */
function holds(line: string, cell: string): boolean {
  const escaped = plain(cell).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}]|\\p{N}[.,])${escaped}(?![\\p{L}\\p{N}]|[.,]\\p{N})`,
    "iu",
  ).test(line);
}

/** The numbers in a text: "12", "0.92", "12,9". */
const numbers = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * A page's copy against its key: rows found whole; rows missed (no line
 * holds the label with any of its cells); rows whose label is there with a
 * cell missing or changed (marked unclear or not); rows copied twice;
 * numbers on lines with no mark that the hand-checked copy doesn't hold
 * (invented or changed); and each doubt's outcome.
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
    changed: [] as { row: string; missing: string[]; marked: boolean }[],
    duplicated: [] as string[],
    invented: [] as string[],
    doubts: [] as { row: string; outcome: DoubtOutcome; line?: string }[],
  };
  for (const row of key.rows) {
    const candidates = lines.filter((line) => holds(line, row.label));
    const missingIn = (line: string) =>
      row.cells.filter((cell) => !holds(line, cell));
    const best = candidates.reduce<string | undefined>(
      (a, b) =>
        a === undefined || missingIn(b).length < missingIn(a).length ? b : a,
      undefined,
    );
    const missing = best === undefined ? row.cells : missingIn(best);
    // Its name elsewhere (a note that names the test) isn't the row.
    if (
      best === undefined ||
      (missing.length > 0 && missing.length === row.cells.length)
    ) {
      score.missed.push(row.label);
      continue;
    }
    if (missing.length === 0) score.found++;
    else
      score.changed.push({
        row: row.label,
        missing: [...missing],
        marked: MARK.test(best),
      });
    const whole = candidates.filter((line) => missingIn(line).length === 0);
    if (row.cells.length > 0 && whole.length > 1)
      score.duplicated.push(row.label);
  }
  const known = new Set(numbers(plain(key.hand)));
  score.invented = lines
    .filter((line) => !MARK.test(line))
    .flatMap(numbers)
    .filter((n) => !known.has(n));
  for (const doubt of key.doubts) {
    const line = lines.find((l) => holds(l, doubt.row));
    if (line === undefined) {
      score.doubts.push({ row: doubt.row, outcome: "missing" });
      continue;
    }
    // Its row, and any note that names it.
    const about = lines.filter(
      (l) =>
        l === line || l.toLowerCase().includes(doubt.mention.toLowerCase()),
    );
    const outcome: DoubtOutcome = about.some((l) => MARK.test(l))
      ? doubt.crossed !== undefined && !about.some((l) => CROSSED.test(l))
        ? "marked, crossing-out not shown"
        : "marked"
      : doubt.truth.every((t) => holds(line, t))
        ? "right, not marked"
        : "wrong, not marked";
    score.doubts.push({ row: doubt.row, outcome, line });
  }
  return score;
}

/** A copy's silent errors: changed without a mark, invented numbers, wrong guesses. */
export const silent = (score: ReturnType<typeof scoreCopy>) =>
  score.changed.filter((c) => !c.marked).length +
  score.invented.length +
  score.doubts.filter((d) => d.outcome === "wrong, not marked").length;
