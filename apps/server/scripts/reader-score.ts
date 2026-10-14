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
