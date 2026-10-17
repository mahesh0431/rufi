// The copy set: five fictional pages in two files, for the reader that
// copies (core/documents/copy-reader.ts), with a hand-checked Markdown copy
// of each page (copy-set/*.md), the rows each copy must hold, and what Rufi
// AI is expected to make of the files (their documents and drafts).
//
//   mixed.pdf, 4 pages:
//     1. Sunrise Labs report SL-2231, page 1 of 2: a "Previous" column
//        under a merged "Result" heading, section headings across the table.
//     2. Its page 2 of 2, scanned: no lab, number or date; the table runs
//        on without its header; a printed TSH crossed out and a value
//        written by hand beside it.
//     3. Northgate Clinical Lab report NG-58810, another date, its page
//        numbers starting again at 1, decimal commas.
//     4. A clinic's prescription with the visit's vitals.
//   report-photo.jpg: a phone photo of mixed.pdf's page 1, with one digit
//   smudged.
//
// Every name, lab and value is made up.
import { readFileSync } from "node:fs";
import type { NewFile } from "../../src/core/documents/documents.ts";
import { drawn, inked, photo, scan, type Ink } from "./images.ts";
import { mixedPdf, type Rule, type Text } from "./pdf.ts";

type Mark = Text | Rule;

/** A page being laid out, line by line. */
function sheet() {
  const marks: Mark[] = [];
  return {
    marks,
    text: (x: number, y: number, size: number, text: string, bold = false) => {
      marks.push({ x, y, size, text, bold });
    },
    rule: (x1: number, y: number, x2: number, width = 0.6) => {
      marks.push({ line: [x1, y, x2, y], width });
    },
  };
}

interface Row {
  test: string;
  value: string;
  flag?: string;
  previous?: string;
  unit: string;
  range: string;
}

const ASHA = "Asha Fictional";

/** Sunrise's columns: Test, Result (Current, Previous), Unit, Reference Range. */
const SUNRISE = {
  test: 40,
  current: 250,
  previous: 320,
  unit: 395,
  range: 470,
};

/** Where page 1 prints its fasting glucose: the photo smudges its middle digit. */
const GLUCOSE_Y = 203;
/** Where page 2 prints its TSH: crossed out and corrected by hand. */
const TSH_Y = 83;

/** Sunrise's rows from `y` on, a section heading as a string; returns where they end. */
function sunriseRows(
  s: ReturnType<typeof sheet>,
  y: number,
  rows: readonly (Row | string)[],
) {
  for (const row of rows) {
    if (typeof row === "string") {
      y += 3;
      s.text(40, y, 9, row, true);
      y += 15;
      continue;
    }
    s.text(SUNRISE.test, y, 10, row.test);
    s.text(
      SUNRISE.current,
      y,
      10,
      row.flag === undefined ? row.value : `${row.value} ${row.flag}`,
      row.flag !== undefined,
    );
    if (row.previous !== undefined)
      s.text(SUNRISE.previous, y, 10, row.previous);
    s.text(SUNRISE.unit, y, 10, row.unit);
    s.text(SUNRISE.range, y, 10, row.range);
    y += 15;
  }
  return y;
}

function sunrisePage1(): Mark[] {
  const s = sheet();
  s.text(40, 48, 16, "Sunrise Labs", true);
  s.text(40, 64, 8, "Fictional laboratory · 1 Example Road · For testing only");
  s.text(40, 88, 10, `Patient: ${ASHA}`, true);
  s.text(330, 88, 10, "Report No: SL-2231");
  s.text(40, 102, 10, "Age/Sex: 41 Y / F");
  s.text(330, 102, 10, "Collected: 12 Jun 2026 08:10");
  s.text(40, 116, 10, "Ref. by: Dr. Fictional");
  s.text(330, 116, 10, "Reported: 13 Jun 2026 17:45");
  s.rule(40, 132, 555);
  // Two header rows: "Result" spans Current and Previous.
  s.text(SUNRISE.test, 152, 10, "Test", true);
  s.text(290, 150, 10, "Result", true);
  s.rule(250, 155, 375);
  s.text(SUNRISE.unit, 152, 10, "Unit", true);
  s.text(SUNRISE.range, 152, 10, "Reference Range", true);
  s.text(SUNRISE.current, 167, 9, "Current", true);
  s.text(SUNRISE.previous, 167, 9, "Previous", true);
  s.rule(40, 172, 555);
  const end = sunriseRows(s, 185, [
    "BIOCHEMISTRY",
    {
      test: "Glucose, Fasting",
      value: "104",
      flag: "H",
      previous: "98",
      unit: "mg/dL",
      range: "70 – 100",
    },
    {
      test: "HbA1c",
      value: "6.8",
      flag: "H",
      previous: "7.1",
      unit: "%",
      range: "4.0 – 5.6",
    },
    {
      test: "Creatinine",
      value: "0.92",
      previous: "0.88",
      unit: "mg/dL",
      range: "0.60 – 1.10",
    },
    {
      test: "CRP",
      value: "<0.5",
      previous: "1.2",
      unit: "mg/L",
      range: "0.0 – 5.0",
    },
    "HAEMATOLOGY",
    {
      test: "Haemoglobin",
      value: "13.2",
      previous: "13.0",
      unit: "g/dL",
      range: "12.0 – 15.5",
    },
    "LIPID PROFILE",
    {
      test: "Total Cholesterol",
      value: "212",
      flag: "H",
      previous: "225",
      unit: "mg/dL",
      range: "<200",
    },
    {
      test: "Triglycerides",
      value: "148",
      previous: "162",
      unit: "mg/dL",
      range: "<150",
    },
    {
      test: "HDL Cholesterol",
      value: "48",
      previous: "45",
      unit: "mg/dL",
      range: ">40",
    },
  ]);
  s.rule(40, end - 6, 555);
  s.text(
    40,
    end + 10,
    8,
    "Previous: results of report SL-1874, collected 03 Mar 2026. H: above the reference range.",
  );
  s.text(40, end + 34, 8, "Page 1 of 2 · Fictional data for testing Rufi");
  return s.marks;
}

function sunrisePage2(): Mark[] {
  const s = sheet();
  const end = sunriseRows(s, 50, [
    {
      test: "LDL Cholesterol",
      value: "134",
      flag: "H",
      previous: "150",
      unit: "mg/dL",
      range: "<100",
    },
    "THYROID",
    {
      test: "TSH",
      value: "5.3",
      flag: "H",
      previous: "4.9",
      unit: "mIU/L",
      range: "0.4 – 4.0",
    },
    {
      test: "Free T4",
      value: "1.1",
      previous: "1.2",
      unit: "ng/dL",
      range: "0.8 – 1.8",
    },
    "VITAMINS",
    {
      test: "Vitamin D (25-OH)",
      value: "18",
      flag: "L",
      previous: "22",
      unit: "ng/mL",
      range: "30 – 100",
    },
    {
      test: "Vitamin B12",
      value: "412",
      previous: "380",
      unit: "pg/mL",
      range: "200 – 900",
    },
  ]);
  s.rule(40, end - 6, 555);
  s.text(
    40,
    end + 12,
    9,
    "Remarks: Fasting sample. Clinical correlation advised.",
  );
  s.text(40, end + 30, 9, "Checked by: Dr. Fictional, Pathologist");
  s.text(40, end + 54, 8, "Page 2 of 2 · Fictional data for testing Rufi");
  s.text(40, end + 66, 8, "*** End of report ***");
  return s.marks;
}

function northgate(): Mark[] {
  const s = sheet();
  s.text(40, 48, 16, "Northgate Clinical Lab", true);
  s.text(
    40,
    64,
    8,
    "Fictional laboratory · 9 Sample Street · For testing only",
  );
  s.text(40, 88, 10, `Name: ${ASHA}`, true);
  s.text(330, 88, 10, "Lab No.: NG-58810");
  s.text(40, 102, 10, "Sample collected: 14/08/2026 09:20");
  s.text(330, 102, 10, "Report date: 15/08/2026");
  s.text(40, 116, 10, "Referred by: Dr. Fictional");
  s.rule(40, 128, 555);
  const cols = { test: 40, value: 250, flag: 310, unit: 350, range: 430 };
  s.text(cols.test, 144, 10, "Investigation", true);
  s.text(cols.value, 144, 10, "Result", true);
  s.text(cols.flag, 144, 10, "Flag", true);
  s.text(cols.unit, 144, 10, "Units", true);
  s.text(cols.range, 144, 10, "Biological Ref. Interval", true);
  s.rule(40, 150, 555);
  let y = 165;
  const rows: Omit<Row, "previous">[] = [
    { test: "Haemoglobin", value: "12,9", unit: "g/dL", range: "12,0 – 15,5" },
    {
      test: "Serum Iron",
      value: "48",
      flag: "L",
      unit: "µg/dL",
      range: "50 – 170",
    },
    {
      test: "TIBC",
      value: "412",
      flag: "H",
      unit: "µg/dL",
      range: "250 – 400",
    },
    {
      test: "Transferrin Saturation",
      value: "11,6",
      flag: "L",
      unit: "%",
      range: "20,0 – 50,0",
    },
    {
      test: "Ferritin",
      value: "9,8",
      flag: "L",
      unit: "ng/mL",
      range: "13,0 – 150,0",
    },
    {
      test: "Creatinine",
      value: "1,25",
      flag: "H",
      unit: "mg/dL",
      range: "0,60 – 1,10",
    },
    { test: "CRP", value: "<0,5", unit: "mg/L", range: "<5,0" },
  ];
  for (const row of rows) {
    s.text(cols.test, y, 10, row.test);
    s.text(cols.value, y, 10, row.value, row.flag !== undefined);
    if (row.flag !== undefined) s.text(cols.flag, y, 10, row.flag, true);
    s.text(cols.unit, y, 10, row.unit);
    s.text(cols.range, y, 10, row.range);
    y += 15;
  }
  s.rule(40, y - 6, 555);
  s.text(40, y + 10, 9, "Method: Ferritin by CLIA.");
  s.text(40, y + 34, 8, "Page 1 of 1 · Fictional data for testing Rufi");
  return s.marks;
}

function prescription(): Mark[] {
  const s = sheet();
  s.text(40, 48, 16, "Lakeview Family Clinic", true);
  s.text(40, 64, 8, "Fictional clinic · 2 Example Lane · For testing only");
  s.text(40, 88, 10, `Patient: ${ASHA}`, true);
  s.text(330, 88, 10, "Date: 20 Aug 2026");
  s.text(40, 102, 10, "Age/Sex: 41 Y / F");
  s.text(330, 102, 10, "Dr. Fictional, MBBS");
  s.text(40, 128, 11, "Vitals", true);
  s.text(40, 144, 10, "BP: 128/82 mmHg");
  s.text(200, 144, 10, "Pulse: 76 /min");
  s.text(340, 144, 10, "Weight: 71.5 kg");
  s.text(40, 170, 11, "Diagnosis", true);
  s.text(40, 186, 10, "Iron deficiency anaemia. Hypothyroidism, on treatment.");
  s.text(40, 212, 11, "Rx", true);
  s.text(
    40,
    228,
    10,
    "1. Tab. Ferrous Ascorbate 100 mg · 1-0-0 · after breakfast · 60 days",
  );
  s.text(
    40,
    243,
    10,
    "2. Tab. Levothyroxine 25 mcg · 1-0-0 · empty stomach · continue",
  );
  s.text(40, 268, 10, "Advice: Repeat CBC and ferritin after 8 weeks.");
  s.text(40, 284, 10, "Next visit: 15 Oct 2026");
  s.text(40, 310, 8, "Page 1 of 1 · Fictional data for testing Rufi");
  return s.marks;
}

/** Helvetica's digit width, as a share of the font size. */
const DIGIT = 0.556;

/** Page 2's ink: the printed 5.3 crossed out, 5.8 written beside it. */
const CORRECTION: Ink[] = [
  {
    strike: [
      SUNRISE.current - 2,
      SUNRISE.current + 3 * DIGIT * 10 + 2,
      TSH_Y - 3.5,
    ],
  },
  { hand: "5.8", x: SUNRISE.current + 32, y: TSH_Y + 1, size: 12 },
];

/** The photo's smudge, over the middle digit of the glucose's 104. */
const SMUDGE: Ink[] = [
  { smudge: [SUNRISE.current + 1.5 * DIGIT * 10, GLUCOSE_Y - 3.6, 6.5] },
];

/** The set's two files, as a person adds them. */
export async function copySetFiles(): Promise<{
  mixed: NewFile;
  photo: NewFile;
}> {
  const page1 = sunrisePage1();
  const page1Png = await drawn(mixedPdf([page1]), 1);
  const page2Png = await inked(
    await drawn(mixedPdf([sunrisePage2()]), 1),
    CORRECTION,
    7,
  );
  return {
    mixed: {
      name: "mixed.pdf",
      bytes: mixedPdf([
        page1,
        await scan(page2Png),
        northgate(),
        prescription(),
      ]),
    },
    photo: {
      name: "report-photo.jpg",
      bytes: await photo(await inked(page1Png, SMUDGE, 3), 21),
    },
  };
}

/** A row a copy must hold: every cell, as printed, on one line or table row. */
interface CopyRow {
  /** Its first cell, which names it: "Glucose, Fasting", "Collected". */
  label: string;
  /** Its other cells, as printed: values, flags, units, ranges, dates. */
  cells: readonly string[];
}

/** A part of the page that is hard to read, and what a copy should do with it. */
interface Doubt {
  /** The row it is in (its label). */
  row: string;
  /** What is printed or written there: every value a faithful copy holds. */
  truth: readonly string[];
  /** A word a note about it would use, outside its row. */
  mention: string;
  /** A printed value crossed out by hand. */
  crossed?: string;
  what: string;
}

/** A page of the set: its hand-checked copy, the rows a copy must hold, its doubts. */
export interface KeyPage {
  file: "mixed" | "photo";
  page: number;
  /** The page's copy, checked by hand against the page. */
  hand: string;
  rows: readonly CopyRow[];
  doubts: readonly Doubt[];
}

const hand = (name: string) =>
  readFileSync(new URL(`copy-set/${name}.md`, import.meta.url), "utf8");

const row = (label: string, ...cells: string[]): CopyRow => ({ label, cells });

/** Page 1's rows: the printed page, also in the photo. */
const SUNRISE_1: CopyRow[] = [
  row("Sunrise Labs"),
  row("Patient", ASHA),
  row("Report No", "SL-2231"),
  row("Collected", "12 Jun 2026 08:10"),
  row("Reported", "13 Jun 2026 17:45"),
  row("Glucose, Fasting", "104", "H", "98", "mg/dL", "70 – 100"),
  row("HbA1c", "6.8", "H", "7.1", "%", "4.0 – 5.6"),
  row("Creatinine", "0.92", "0.88", "mg/dL", "0.60 – 1.10"),
  row("CRP", "<0.5", "1.2", "mg/L", "0.0 – 5.0"),
  row("Haemoglobin", "13.2", "13.0", "g/dL", "12.0 – 15.5"),
  row("Total Cholesterol", "212", "H", "225", "mg/dL", "<200"),
  row("Triglycerides", "148", "162", "mg/dL", "<150"),
  row("HDL Cholesterol", "48", "45", "mg/dL", ">40"),
  row("Previous", "SL-1874", "03 Mar 2026"),
  row("Page 1 of 2"),
];

export const KEY: readonly KeyPage[] = [
  {
    file: "mixed",
    page: 1,
    hand: hand("mixed-1"),
    rows: SUNRISE_1,
    doubts: [],
  },
  {
    file: "mixed",
    page: 2,
    hand: hand("mixed-2"),
    rows: [
      row("LDL Cholesterol", "134", "H", "150", "mg/dL", "<100"),
      row("TSH", "5.3", "5.8", "H", "4.9", "mIU/L", "0.4 – 4.0"),
      row("Free T4", "1.1", "1.2", "ng/dL", "0.8 – 1.8"),
      row("Vitamin D (25-OH)", "18", "L", "22", "ng/mL", "30 – 100"),
      row("Vitamin B12", "412", "380", "pg/mL", "200 – 900"),
      row("Remarks", "Fasting sample"),
      row("Page 2 of 2"),
    ],
    doubts: [
      {
        row: "TSH",
        truth: ["5.3", "5.8"],
        mention: "TSH",
        crossed: "5.3",
        what: "a printed 5.3 crossed out, 5.8 written by hand",
      },
    ],
  },
  {
    file: "mixed",
    page: 3,
    hand: hand("mixed-3"),
    rows: [
      row("Northgate Clinical Lab"),
      row("Name", ASHA),
      row("Lab No.", "NG-58810"),
      row("Sample collected", "14/08/2026 09:20"),
      row("Report date", "15/08/2026"),
      row("Haemoglobin", "12,9", "g/dL", "12,0 – 15,5"),
      row("Serum Iron", "48", "L", "µg/dL", "50 – 170"),
      row("TIBC", "412", "H", "µg/dL", "250 – 400"),
      row("Transferrin Saturation", "11,6", "L", "%", "20,0 – 50,0"),
      row("Ferritin", "9,8", "L", "ng/mL", "13,0 – 150,0"),
      row("Creatinine", "1,25", "H", "mg/dL", "0,60 – 1,10"),
      row("CRP", "<0,5", "mg/L", "<5,0"),
      row("Page 1 of 1"),
    ],
    doubts: [],
  },
  {
    file: "mixed",
    page: 4,
    hand: hand("mixed-4"),
    rows: [
      row("Lakeview Family Clinic"),
      row("Patient", ASHA),
      row("Date", "20 Aug 2026"),
      row("BP", "128/82 mmHg"),
      row("Pulse", "76 /min"),
      row("Weight", "71.5 kg"),
      row("Tab. Ferrous Ascorbate", "100 mg", "1-0-0", "60 days"),
      row("Tab. Levothyroxine", "25 mcg", "1-0-0"),
      row("Advice", "Repeat CBC and ferritin after 8 weeks"),
      row("Next visit", "15 Oct 2026"),
      row("Page 1 of 1"),
    ],
    doubts: [],
  },
  {
    file: "photo",
    page: 1,
    hand: hand("photo-1"),
    rows: SUNRISE_1,
    doubts: [
      {
        row: "Glucose, Fasting",
        truth: ["104"],
        mention: "glucose",
        what: "the middle digit of 104 smudged",
      },
    ],
  },
];

/** A document Rufi AI is expected to make of a file: its kind, date and pages. */
interface ExpectedDocument {
  file: "mixed" | "photo";
  kind: "lab_report" | "prescription" | "letter" | "other";
  /** Its date: a lab report's collection date, a prescription's visit. */
  date: string;
  /** Its pages, by their page in the file. */
  pages: readonly number[];
  /** Its report as printed, for a lab report. */
  report?: { lab: string; number: string };
}

/** A draft Rufi AI is expected to make: a current value, on its page. */
interface ExpectedDraft {
  file: "mixed" | "photo";
  page: number;
  test: string;
  /** The value as printed. */
  value: string;
  /** Its date: its report's collection date, or the visit's. */
  date: string;
  /** Why it is worth a look, when it is. */
  look?: string;
  /** Other values a draft may take, flagged (a crossed-out print). */
  or?: readonly string[];
}

/**
 * What Rufi AI should make of the two files: mixed.pdf is two reports and
 * a prescription; the photo is the same report as mixed.pdf's first, added
 * again, so it is its own document. Only current values are drafts.
 */
export const EXPECTED: {
  documents: readonly ExpectedDocument[];
  drafts: readonly ExpectedDraft[];
} = {
  documents: [
    {
      file: "mixed",
      kind: "lab_report",
      date: "2026-06-12",
      pages: [1, 2],
      report: { lab: "Sunrise Labs", number: "SL-2231" },
    },
    {
      file: "mixed",
      kind: "lab_report",
      date: "2026-08-14",
      pages: [3],
      report: { lab: "Northgate Clinical Lab", number: "NG-58810" },
    },
    { file: "mixed", kind: "prescription", date: "2026-08-20", pages: [4] },
    {
      file: "photo",
      kind: "lab_report",
      date: "2026-06-12",
      pages: [1],
      report: { lab: "Sunrise Labs", number: "SL-2231" },
    },
  ],
  drafts: [
    ...(["mixed", "photo"] as const).flatMap((file) => {
      const june = (test: string, value: string, look?: string) => ({
        file,
        page: 1,
        test,
        value,
        date: "2026-06-12",
        ...(look !== undefined && { look }),
      });
      return [
        file === "photo"
          ? june("Glucose, Fasting", "104", "the middle digit is smudged")
          : june("Glucose, Fasting", "104"),
        june("HbA1c", "6.8"),
        june("Creatinine", "0.92"),
        june("CRP", "<0.5"),
        june("Haemoglobin", "13.2"),
        june("Total Cholesterol", "212"),
        june("Triglycerides", "148"),
        june("HDL Cholesterol", "48"),
      ];
    }),
    ...[
      ["LDL Cholesterol", "134"],
      ["TSH", "5.8"],
      ["Free T4", "1.1"],
      ["Vitamin D (25-OH)", "18"],
      ["Vitamin B12", "412"],
    ].map(([test = "", value = ""]) => ({
      file: "mixed" as const,
      page: 2,
      test,
      value,
      date: "2026-06-12",
      ...(test === "TSH" && {
        look: "the printed 5.3 is crossed out and 5.8 written by hand",
        or: ["5.3"],
      }),
    })),
    ...[
      ["Haemoglobin", "12,9"],
      ["Serum Iron", "48"],
      ["TIBC", "412"],
      ["Transferrin Saturation", "11,6"],
      ["Ferritin", "9,8"],
      ["Creatinine", "1,25"],
      ["CRP", "<0,5"],
    ].map(([test = "", value = ""]) => ({
      file: "mixed" as const,
      page: 3,
      test,
      value,
      date: "2026-08-14",
    })),
    ...[
      ["BP", "128/82"],
      ["Pulse", "76"],
      ["Weight", "71.5"],
    ].map(([test = "", value = ""]) => ({
      file: "mixed" as const,
      page: 4,
      test,
      value,
      date: "2026-08-20",
    })),
  ],
};
