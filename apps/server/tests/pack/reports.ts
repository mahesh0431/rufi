// The fictional test pack's reports, which are also its answer key: every
// row as printed, the patient's name and the collection date, laid out in
// four ways (a plain table, a table with earlier results, sections, and a
// dense small-print table). All names, labs and values are made up.
import type { Text } from "./pdf.ts";

type Comparator = "<" | "<=" | ">" | ">=";

interface Row {
  test: string;
  /** The value as printed: "<5", "4,6", "Negative". */
  value: string;
  /** The value as a number ("4,6" is 4.6, "<5" is 5), or null when it isn't one. */
  number: number | null;
  /** The comparator printed before the value, if any. */
  comparator?: Comparator;
  unit: string;
  range: string;
  flag?: string;
  /** An earlier result printed beside it (the "previous" layout). */
  previous?: string;
  section?: string;
}

type Layout = "table" | "previous" | "sections" | "dense";

export interface Report {
  lab: string;
  patient: string;
  /** The collection date as printed, and as YYYY-MM-DD when its order is certain. */
  collected: string;
  collectedIso: string | null;
  reported: string;
  number: string;
  layout: Layout;
  rows: Row[];
  rowsPerPage: number;
  /** "Amended", with a line that says what changed. */
  status?: { word: string; note: string };
  /** The header (lab, patient, dates) only on page 1. */
  headerOnFirstPage?: boolean;
  /** A line the lab prints after the results, on the last page. */
  remark?: string;
}

/** One item of the answer key: a row as it must be read, on its page. */
export interface Expected {
  page: number;
  test: string;
  value: string;
  /** Its value_number, or null when it must have none. */
  number: number | null;
  comparator?: Comparator;
  /**
   * The item's own date as it must be read: YYYY-MM-DD, or null when it
   * must have none. Left out when the pack doesn't score it.
   */
  date?: string | null;
}

/** A small seeded generator, so the pack is the same every time. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

interface Kind {
  test: string;
  unit: string;
  low: number;
  high: number;
  decimals: number;
  section: string;
}

const CATALOGUE: Kind[] = [
  {
    test: "Haemoglobin",
    unit: "g/dL",
    low: 12,
    high: 15.5,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "Total Leucocyte Count",
    unit: "10^3/µL",
    low: 4,
    high: 11,
    decimals: 2,
    section: "Haematology",
  },
  {
    test: "Platelet Count",
    unit: "10^3/µL",
    low: 150,
    high: 410,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "RBC Count",
    unit: "10^6/µL",
    low: 3.8,
    high: 5.2,
    decimals: 2,
    section: "Haematology",
  },
  {
    test: "Haematocrit (PCV)",
    unit: "%",
    low: 36,
    high: 46,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "MCV",
    unit: "fL",
    low: 80,
    high: 100,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "MCH",
    unit: "pg",
    low: 27,
    high: 32,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "MCHC",
    unit: "g/dL",
    low: 32,
    high: 35,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "RDW-CV",
    unit: "%",
    low: 11.6,
    high: 14,
    decimals: 1,
    section: "Haematology",
  },
  {
    test: "Neutrophils",
    unit: "%",
    low: 40,
    high: 80,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "Lymphocytes",
    unit: "%",
    low: 20,
    high: 40,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "Monocytes",
    unit: "%",
    low: 2,
    high: 10,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "Eosinophils",
    unit: "%",
    low: 1,
    high: 6,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "ESR",
    unit: "mm/hr",
    low: 0,
    high: 20,
    decimals: 0,
    section: "Haematology",
  },
  {
    test: "Glucose, Fasting",
    unit: "mg/dL",
    low: 70,
    high: 100,
    decimals: 0,
    section: "Biochemistry",
  },
  {
    test: "HbA1c",
    unit: "%",
    low: 4,
    high: 5.6,
    decimals: 1,
    section: "Biochemistry",
  },
  {
    test: "Urea",
    unit: "mg/dL",
    low: 15,
    high: 40,
    decimals: 0,
    section: "Biochemistry",
  },
  {
    test: "Creatinine",
    unit: "mg/dL",
    low: 0.5,
    high: 1.1,
    decimals: 2,
    section: "Biochemistry",
  },
  {
    test: "Uric Acid",
    unit: "mg/dL",
    low: 2.6,
    high: 6,
    decimals: 1,
    section: "Biochemistry",
  },
  {
    test: "Sodium",
    unit: "mmol/L",
    low: 136,
    high: 145,
    decimals: 0,
    section: "Biochemistry",
  },
  {
    test: "Potassium",
    unit: "mmol/L",
    low: 3.5,
    high: 5.1,
    decimals: 1,
    section: "Biochemistry",
  },
  {
    test: "Chloride",
    unit: "mmol/L",
    low: 98,
    high: 107,
    decimals: 0,
    section: "Biochemistry",
  },
  {
    test: "Calcium",
    unit: "mg/dL",
    low: 8.6,
    high: 10.3,
    decimals: 1,
    section: "Biochemistry",
  },
  {
    test: "Total Cholesterol",
    unit: "mg/dL",
    low: 0,
    high: 200,
    decimals: 0,
    section: "Lipids",
  },
  {
    test: "Triglycerides",
    unit: "mg/dL",
    low: 0,
    high: 150,
    decimals: 0,
    section: "Lipids",
  },
  {
    test: "HDL Cholesterol",
    unit: "mg/dL",
    low: 40,
    high: 60,
    decimals: 0,
    section: "Lipids",
  },
  {
    test: "LDL Cholesterol",
    unit: "mg/dL",
    low: 0,
    high: 100,
    decimals: 0,
    section: "Lipids",
  },
  {
    test: "VLDL Cholesterol",
    unit: "mg/dL",
    low: 5,
    high: 40,
    decimals: 0,
    section: "Lipids",
  },
  {
    test: "Bilirubin, Total",
    unit: "mg/dL",
    low: 0.3,
    high: 1.2,
    decimals: 2,
    section: "Liver",
  },
  {
    test: "Bilirubin, Direct",
    unit: "mg/dL",
    low: 0,
    high: 0.3,
    decimals: 2,
    section: "Liver",
  },
  {
    test: "SGOT (AST)",
    unit: "U/L",
    low: 5,
    high: 40,
    decimals: 0,
    section: "Liver",
  },
  {
    test: "SGPT (ALT)",
    unit: "U/L",
    low: 7,
    high: 56,
    decimals: 0,
    section: "Liver",
  },
  {
    test: "Alkaline Phosphatase",
    unit: "U/L",
    low: 44,
    high: 147,
    decimals: 0,
    section: "Liver",
  },
  { test: "GGT", unit: "U/L", low: 9, high: 48, decimals: 0, section: "Liver" },
  {
    test: "Total Protein",
    unit: "g/dL",
    low: 6,
    high: 8.3,
    decimals: 1,
    section: "Liver",
  },
  {
    test: "Albumin",
    unit: "g/dL",
    low: 3.5,
    high: 5,
    decimals: 1,
    section: "Liver",
  },
  {
    test: "TSH",
    unit: "µIU/mL",
    low: 0.4,
    high: 4,
    decimals: 2,
    section: "Thyroid",
  },
  {
    test: "Free T4",
    unit: "ng/dL",
    low: 0.8,
    high: 1.8,
    decimals: 2,
    section: "Thyroid",
  },
  {
    test: "Free T3",
    unit: "pg/mL",
    low: 2.3,
    high: 4.2,
    decimals: 2,
    section: "Thyroid",
  },
  {
    test: "Vitamin D (25-OH)",
    unit: "ng/mL",
    low: 30,
    high: 100,
    decimals: 1,
    section: "Vitamins",
  },
  {
    test: "Vitamin B12",
    unit: "pg/mL",
    low: 200,
    high: 900,
    decimals: 0,
    section: "Vitamins",
  },
  {
    test: "Ferritin",
    unit: "ng/mL",
    low: 15,
    high: 150,
    decimals: 1,
    section: "Vitamins",
  },
  {
    test: "Iron",
    unit: "µg/dL",
    low: 60,
    high: 170,
    decimals: 0,
    section: "Vitamins",
  },
  {
    test: "CRP",
    unit: "mg/L",
    low: 0,
    high: 5,
    decimals: 1,
    section: "Biochemistry",
  },
];

const URINE: Row[] = [
  {
    test: "Colour",
    value: "Pale Yellow",
    number: null,
    unit: "",
    range: "Pale Yellow",
    section: "Physical",
  },
  {
    test: "Appearance",
    value: "Clear",
    number: null,
    unit: "",
    range: "Clear",
    section: "Physical",
  },
  {
    test: "Specific Gravity",
    value: "1.015",
    number: 1.015,
    unit: "",
    range: "1.005-1.030",
    section: "Physical",
  },
  {
    test: "pH",
    value: "6.0",
    number: 6,
    unit: "",
    range: "4.6-8.0",
    section: "Chemical",
  },
  {
    test: "Protein",
    value: "Trace",
    number: null,
    unit: "",
    range: "Negative",
    flag: "A",
    section: "Chemical",
  },
  {
    test: "Glucose",
    value: "Negative",
    number: null,
    unit: "",
    range: "Negative",
    section: "Chemical",
  },
  {
    test: "Ketones",
    value: "Negative",
    number: null,
    unit: "",
    range: "Negative",
    section: "Chemical",
  },
  {
    test: "Bilirubin",
    value: "Negative",
    number: null,
    unit: "",
    range: "Negative",
    section: "Chemical",
  },
  {
    test: "Urobilinogen",
    value: "Normal",
    number: null,
    unit: "",
    range: "Normal",
    section: "Chemical",
  },
  {
    test: "Nitrite",
    value: "Negative",
    number: null,
    unit: "",
    range: "Negative",
    section: "Chemical",
  },
  {
    test: "Pus Cells",
    value: "2-4",
    number: null,
    unit: "/hpf",
    range: "0-5",
    section: "Microscopy",
  },
  {
    test: "Epithelial Cells",
    value: "1-2",
    number: null,
    unit: "/hpf",
    range: "0-5",
    section: "Microscopy",
  },
  {
    test: "RBCs",
    value: "Nil",
    number: null,
    unit: "/hpf",
    range: "Nil",
    section: "Microscopy",
  },
  {
    test: "Casts",
    value: "Absent",
    number: null,
    unit: "",
    range: "Absent",
    section: "Microscopy",
  },
  {
    test: "Crystals",
    value: "Absent",
    number: null,
    unit: "",
    range: "Absent",
    section: "Microscopy",
  },
  {
    test: "Bacteria",
    value: "Absent",
    number: null,
    unit: "",
    range: "Absent",
    section: "Microscopy",
  },
];

/** `count` rows from the catalogue, from `start`, with values in and out of range. */
function rowsOf(
  count: number,
  seed: number,
  options: { comma?: boolean; previous?: boolean; start?: number } = {},
): Row[] {
  const random = seeded(seed);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const kind = CATALOGUE[((options.start ?? 0) + i) % CATALOGUE.length];
    if (!kind) continue;
    const span = kind.high - kind.low || kind.high;
    const roll = random();
    const n =
      roll < 0.15 && kind.low > 0
        ? kind.low - span * 0.2 * random()
        : roll > 0.85
          ? kind.high + span * 0.3 * random()
          : kind.low + span * random();
    const fix = (v: number) => Math.max(0, v).toFixed(kind.decimals);
    let value = fix(n);
    const below = kind.test === "CRP" && n < 5;
    if (below) value = "<5";
    if (options.comma) value = value.replace(".", ",");
    const flag = value.startsWith("<")
      ? undefined
      : n < kind.low
        ? "L"
        : n > kind.high
          ? "H"
          : undefined;
    const range =
      kind.low === 0
        ? `<${String(kind.high)}`
        : `${String(kind.low)}-${String(kind.high)}`;
    // A repeated test in a long report gets a sample number, so each row is its own.
    const round = Math.floor(((options.start ?? 0) + i) / CATALOGUE.length);
    rows.push({
      test:
        round === 0 ? kind.test : `${kind.test} (sample ${String(round + 1)})`,
      value,
      number: below ? 5 : Number(fix(n)),
      ...(below && { comparator: "<" as const }),
      unit: kind.unit,
      range: options.comma ? range.replace(/\./g, ",") : range,
      ...(flag !== undefined && { flag }),
      ...(options.previous && { previous: fix(kind.low + span * random()) }),
      section: kind.section,
    });
  }
  return rows;
}

const ASHA = "Asha Fictional";

/** The pack's reports by name. */
export const REPORTS: Record<string, Report> = {
  cbc: {
    lab: "Sunrise Diagnostics",
    patient: ASHA,
    collected: "12 Aug 2026 08:10",
    collectedIso: "2026-08-12",
    reported: "12 Aug 2026 17:40",
    number: "SD-260812-0441",
    layout: "table",
    rows: rowsOf(14, 1),
    rowsPerPage: 40,
  },
  lipids: {
    lab: "Lotus Path Labs",
    patient: ASHA,
    collected: "02 Jun 2026",
    collectedIso: "2026-06-02",
    reported: "03 Jun 2026",
    number: "LPL/2026/77812",
    layout: "table",
    rows: [...rowsOf(5, 2, { start: 23 }), ...rowsOf(1, 9, { start: 43 })],
    rowsPerPage: 40,
  },
  thyroid: {
    lab: "Northgate Clinical Lab",
    patient: ASHA,
    collected: "14/09/2026",
    collectedIso: "2026-09-14",
    reported: "15/09/2026",
    number: "NCL-55120",
    layout: "previous",
    rows: rowsOf(6, 3, { start: 36, previous: true }),
    rowsPerPage: 40,
  },
  urine: {
    lab: "Lotus Path Labs",
    patient: ASHA,
    collected: "20 Jul 2026",
    collectedIso: "2026-07-20",
    reported: "20 Jul 2026",
    number: "LPL/2026/70210",
    layout: "sections",
    rows: URINE,
    rowsPerPage: 9,
  },
  liver_dense: {
    lab: "Meridian Labs",
    patient: ASHA,
    collected: "05 Mar 2026",
    collectedIso: "2026-03-05",
    reported: "06 Mar 2026",
    number: "MER-3051-22",
    layout: "dense",
    rows: rowsOf(45, 5),
    rowsPerPage: 60,
  },
  comma: {
    lab: "Laboratoire Fictif",
    patient: ASHA,
    collected: "18 Feb 2026",
    collectedIso: "2026-02-18",
    reported: "19 Feb 2026",
    number: "LF-0218-09",
    layout: "table",
    rows: rowsOf(12, 6, { comma: true, start: 14 }),
    rowsPerPage: 40,
  },
  amended: {
    lab: "Sunrise Diagnostics",
    patient: ASHA,
    collected: "25 Aug 2026 07:55",
    collectedIso: "2026-08-25",
    reported: "27 Aug 2026 10:00",
    number: "SD-260825-0102-A",
    layout: "table",
    rows: rowsOf(8, 7, { start: 14 }),
    rowsPerPage: 40,
    status: {
      word: "AMENDED",
      note: "Amended report: Creatinine corrected after re-run. Replaces report SD-260825-0102.",
    },
  },
  hba1c_repeat: {
    lab: "Sunrise Diagnostics",
    patient: ASHA,
    collected: "08 Sep 2026 08:20",
    collectedIso: "2026-09-08",
    reported: "08 Sep 2026 16:05",
    number: "SD-260908-0217",
    layout: "table",
    rows: [
      {
        test: "HbA1c",
        value: "7.2",
        number: 7.2,
        unit: "%",
        range: "4.0 - 5.6",
        flag: "H",
      },
      {
        test: "Glucose, Fasting",
        value: "126",
        number: 126,
        unit: "mg/dL",
        range: "70 - 99",
        flag: "H",
      },
    ],
    rowsPerPage: 40,
    remark: "Remark: Repeat HbA1c in 3 months.",
  },
  ambiguous_date: {
    lab: "Northgate Clinical Lab",
    patient: ASHA,
    collected: "03/04/2026",
    collectedIso: null,
    reported: "04/04/2026",
    number: "NCL-50212",
    layout: "table",
    rows: rowsOf(6, 8, { start: 36 }),
    rowsPerPage: 40,
  },
  other_name: {
    lab: "Lotus Path Labs",
    patient: "Meera Fictional",
    collected: "11 Sep 2026",
    collectedIso: "2026-09-11",
    reported: "11 Sep 2026",
    number: "LPL/2026/80033",
    layout: "table",
    rows: rowsOf(8, 10, { start: 23 }),
    rowsPerPage: 40,
  },
  // Asha's own report, her name printed another way.
  name_variant: {
    lab: "Lotus Path Labs",
    patient: "ASHA F",
    collected: "18 Sep 2026",
    collectedIso: "2026-09-18",
    reported: "18 Sep 2026",
    number: "LPL/2026/81207",
    layout: "table",
    rows: rowsOf(8, 14, { start: 23 }),
    rowsPerPage: 40,
  },
  five_pages: {
    lab: "Sunrise Diagnostics",
    patient: ASHA,
    collected: "10 Jan 2026 08:30",
    collectedIso: "2026-01-10",
    reported: "11 Jan 2026 12:00",
    number: "SD-260110-0007",
    layout: "table",
    rows: rowsOf(90, 11),
    rowsPerPage: 18,
  },
  eight_pages: {
    lab: "Meridian Labs",
    patient: ASHA,
    collected: "28 Apr 2026",
    collectedIso: "2026-04-28",
    reported: "29 Apr 2026",
    number: "MER-4280-11",
    layout: "table",
    rows: rowsOf(200, 12),
    rowsPerPage: 25,
    headerOnFirstPage: true,
  },
  big_300: {
    lab: "Meridian Labs",
    patient: ASHA,
    collected: "15 May 2026",
    collectedIso: "2026-05-15",
    reported: "16 May 2026",
    number: "MER-5150-03",
    layout: "dense",
    rows: rowsOf(300, 13),
    rowsPerPage: 30,
  },
};

/** A report's rows, page by page. */
function paged(report: Report): Row[][] {
  const pages: Row[][] = [];
  for (let i = 0; i < report.rows.length; i += report.rowsPerPage) {
    pages.push(report.rows.slice(i, i + report.rowsPerPage));
  }
  return pages;
}

/** A report laid out as printed pages of text. */
export function layout(report: Report): Text[][] {
  const all = paged(report);
  return all.map((rows, index) => {
    const page: Text[] = [];
    let y = 48;
    const line = (x: number, size: number, text: string, bold = false) => {
      page.push({ x, y, size, text, bold });
    };
    const header = !report.headerOnFirstPage || index === 0;
    if (header) {
      line(40, 16, report.lab, true);
      y += 16;
      line(40, 8, "Fictional laboratory · 1 Example Road · For testing only");
      y += 22;
      line(40, 10, `Patient: ${report.patient}`, true);
      line(330, 10, `Report No: ${report.number}`);
      y += 14;
      line(40, 10, "Age/Sex: 41 Y / F");
      line(330, 10, `Collected: ${report.collected}`);
      y += 14;
      line(40, 10, "Ref. by: Dr. Fictional");
      line(330, 10, `Reported: ${report.reported}`);
      y += 14;
      if (report.status) {
        line(40, 10, `Report status: ${report.status.word}`, true);
        y += 14;
        line(40, 9, report.status.note);
        y += 14;
      }
      y += 10;
    } else {
      line(40, 9, `${report.lab} · continued`);
      y += 18;
    }
    const size = report.layout === "dense" ? 7.5 : 10;
    const step = report.layout === "dense" ? 10.5 : 15;
    const previous = report.layout === "previous";
    const cols = previous
      ? { test: 40, value: 230, prev: 310, flag: 0, unit: 390, range: 470 }
      : { test: 40, value: 250, prev: 0, flag: 320, unit: 350, range: 450 };
    const head = () => {
      line(cols.test, size, "Test", true);
      line(
        cols.value,
        size,
        report.layout === "previous" ? "Current" : "Result",
        true,
      );
      if (previous) line(cols.prev, size, "Previous", true);
      line(cols.unit, size, "Unit", true);
      line(cols.range, size, "Reference Range", true);
      y += step + 2;
    };
    if (report.layout !== "sections") head();
    let section: string | undefined;
    for (const row of rows) {
      if (report.layout === "sections" && row.section !== section) {
        section = row.section;
        y += 4;
        line(40, 11, section ?? "", true);
        y += step;
        head();
      }
      line(cols.test, size, row.test);
      const flagged =
        report.layout === "previous" && row.flag
          ? `${row.value} ${row.flag}`
          : row.value;
      line(cols.value, size, flagged, row.flag !== undefined);
      if (!previous && row.flag) line(cols.flag, size, row.flag, true);
      if (previous && row.previous) line(cols.prev, size, row.previous);
      line(cols.unit, size, row.unit);
      line(cols.range, size, row.range);
      y += step;
    }
    if (report.remark !== undefined && index === all.length - 1) {
      y += 8;
      line(40, 10, report.remark);
      y += step;
    }
    y += 16;
    line(
      40,
      8,
      `Page ${String(index + 1)} of ${String(all.length)} · Fictional data for testing Rufi`,
    );
    if (index === all.length - 1) {
      y += 12;
      line(40, 8, "*** End of report ***");
    }
    return page;
  });
}

/**
 * A clinic's prescription, one page: the visit's measurements (dated by the
 * visit, 5 Oct), a height the patient told with no date, and a TSH whose
 * sample was collected on another day (1 Oct). The reader copies all four
 * as items; only the visit's measurements take its date.
 */
export const PRESCRIPTION = {
  pages: [
    [
      { x: 40, y: 48, size: 16, text: "Lakeview Family Clinic", bold: true },
      {
        x: 40,
        y: 64,
        size: 8,
        text: "Fictional clinic · 2 Example Lane · For testing only",
      },
      { x: 40, y: 88, size: 10, text: `Patient: ${ASHA}`, bold: true },
      { x: 330, y: 88, size: 10, text: "Visit date: 05 Oct 2026" },
      { x: 40, y: 102, size: 10, text: "Age/Sex: 41 Y / F" },
      { x: 330, y: 102, size: 10, text: "Dr. Fictional, MBBS" },
      { x: 40, y: 130, size: 11, text: "Vitals at this visit", bold: true },
      { x: 40, y: 146, size: 10, text: "Blood pressure" },
      { x: 200, y: 146, size: 10, text: "130/85 mmHg" },
      { x: 40, y: 161, size: 10, text: "Weight" },
      { x: 200, y: 161, size: 10, text: "72 kg" },
      { x: 40, y: 186, size: 11, text: "History", bold: true },
      {
        x: 40,
        y: 202,
        size: 10,
        text: "Height 160 cm (as told by the patient). Hypothyroid since 2024.",
      },
      { x: 40, y: 228, size: 11, text: "Investigations", bold: true },
      {
        x: 40,
        y: 244,
        size: 10,
        text: "Northgate Clinical Lab · sample collected 01 Oct 2026",
      },
      { x: 40, y: 260, size: 10, text: "TSH" },
      { x: 200, y: 260, size: 10, text: "4.8", bold: true },
      { x: 240, y: 260, size: 10, text: "H", bold: true },
      { x: 270, y: 260, size: 10, text: "mIU/L" },
      { x: 340, y: 260, size: 10, text: "0.4 - 4.0" },
      { x: 40, y: 290, size: 11, text: "Rx", bold: true },
      {
        x: 40,
        y: 306,
        size: 10,
        text: "1. Tab. Levothyroxine 25 mcg · once daily before breakfast · 30 days",
      },
      {
        x: 40,
        y: 330,
        size: 10,
        text: "Advice: Repeat TSH after 6 weeks.",
      },
      {
        x: 40,
        y: 360,
        size: 8,
        text: "Page 1 of 1 · Fictional data for testing Rufi",
      },
    ],
  ] satisfies Text[][],
  key: {
    items: [
      {
        page: 1,
        test: "Blood pressure",
        value: "130/85",
        number: null,
        date: "2026-10-05",
      },
      { page: 1, test: "Weight", value: "72", number: 72, date: "2026-10-05" },
      { page: 1, test: "Height", value: "160", number: 160, date: null },
      { page: 1, test: "TSH", value: "4.8", number: 4.8 },
    ] satisfies Expected[],
    pages: [{ patient: ASHA, collectedIso: "2026-10-01" }],
  },
};
