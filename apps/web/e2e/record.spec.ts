// The record's screens on the real core: Overview's tiles and a kind's page
// read again when a save lands, in every open window, whichever page it
// shows; Needs you when a reading ends, with no save. The strict CSP refuses nothing, and each screen passes axe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readOf, readThen } from "../../server/tests/readers.ts";
import { expect, FILE_WORK_MS, sendFiles, test } from "./rufi.ts";

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const sidebar = (page: Page) => page.getByRole("complementary");
const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const box = (page: Page) =>
  chat(page).getByRole("textbox", { name: "Message to Rufi" });

test("a visit saves a free-text kind and shows it as written on the list and its page; a follow-up's About opens a visit's page", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO visits (id, person_id, setting, doctor, as_written) VALUES ('v-eye', 'asha', 'Eye clinic', 'Dr Lens', 'Eyes checked.');",
    "INSERT INTO follow_ups (id, person_id, title, linked_kind, linked_id) VALUES ('f-eye', 'asha', 'Eye check again', 'visit', 'v-eye');",
  );
  await rufi.start({
    scenario: {
      calls: [
        {
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "visit",
                action: "add",
                fields: {
                  setting: "Dental check-up",
                  doctor: "Dr Fictional",
                  as_written: "Teeth cleaned. Continue flossing.",
                },
              },
            ],
          },
        },
      ],
    },
  });
  await page.goto(rufi.link());
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await box(page).fill(
    "Save my Dental check-up with Dr Fictional: teeth cleaned, continue flossing.",
  );
  await box(page).press("Enter");
  await expect(chat(page).locator(".receipt")).toContainText("Dental check-up");
  await page.keyboard.press("Escape");
  await sidebar(page)
    .getByRole("link", { name: /^Visits/ })
    .click();
  await expect(page.getByRole("main")).toContainText("Dental check-up");
  await page.getByRole("link", { name: "Dr Fictional", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("Dental check-up");

  await sidebar(page)
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  await page.getByRole("link", { name: "Dr Lens" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/visits\/v-eye$/);
  await expect(page.getByRole("main")).toContainText("Eyes checked.");
});

/** A save that removes the CRP result, or puts it back. */
const crpSave = (action: "remove" | "restore") => [
  {
    id: `call-${action}`,
    tool: "save_changes",
    arguments: {
      changes: [{ kind: "result", action, id: "res-a3" }],
    },
  },
];

test("a save in one window refreshes Overview's tiles there and a kind's page in another; a put-back record says so everywhere", async ({
  page,
  rufi,
  context,
}) => {
  // Allergies: no rows, but "None known" was said, with no date.
  await rufi.family(
    "INSERT INTO none_known (id, person_id, category, asserted) VALUES ('nk-a1', 'asha', 'allergies', NULL);",
  );
  await rufi.start({
    scenario: {
      callsByTurn: [crpSave("remove"), crpSave("restore")],
    },
  });
  // One window on the Lab results page, with no chat on it.
  const results = await context.newPage();
  await results.goto(rufi.link());
  await sidebar(results)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  const crp = results.getByRole("link", { name: "CRP", exact: true });
  await expect(crp).toBeVisible();
  const inflammation = results.getByRole("region", { name: "Inflammation" });
  await expect(inflammation).toBeVisible();
  await accessible(results);

  // The other on Overview: the save goes from its chat bar.
  await page.goto(rufi.link());
  const tile = page
    .getByRole("main")
    .getByRole("link", { name: /^Lab results 7/ });
  await expect(tile).toBeVisible();
  // A page with something in it has a tile; the empty ones are on one line.
  const record = page.getByRole("region", { name: "Health record" });
  await expect(
    record.getByRole("link", { name: /^Allergies\s*None known$/ }),
  ).toBeVisible();
  const nothingYet = record.getByText(/^Nothing yet:/);
  await expect(nothingYet.getByRole("link")).not.toHaveCount(0);
  await expect(nothingYet).not.toContainText("Allergies");
  await expect(nothingYet).not.toContainText("Lab results");
  await accessible(page);
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await box(page).fill("Remove the CRP result");
  await box(page).press("Enter");
  await expect(chat(page).locator(".receipt")).toContainText("CRP");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("main").getByRole("link", { name: /^Lab results 6/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Recent changes" }),
  ).toContainText("Removed result CRP");
  // The Lab results page in the other window read again by itself: CRP
  // has no value now, so neither it nor its section shows.
  await expect(crp).toHaveCount(0);
  await expect(inflammation).toHaveCount(0);

  // Put back: one word on the receipt, on Overview and in its history.
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await box(page).fill("Put the CRP result back");
  await box(page).press("Enter");
  await expect(chat(page).locator(".receipt").last()).toContainText(
    "Put back result CRP",
  );
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("region", { name: "Recent changes" })
      .locator("summary")
      .first(),
  ).toHaveText(/^Today \d\d:\d\dPut back result CRP <5 mg\/L$/);
  await crp.click();
  await results.getByRole("button", { name: "12 Aug 2026" }).click();
  await expect(
    results
      .getByRole("listitem")
      .filter({ hasText: /^at .* · (Removed|Put back)$/ }),
  ).toHaveText([/ · Removed$/, / · Put back$/]);
});

test("a row's history shows a correction before and after, a time with its time", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `INSERT INTO results (id, person_id, category, test_name, value_text, unit, measured_at, measured_words, entered_at, test_id)
       VALUES ('res-bp', 'asha', 'measurement', 'Blood pressure', '128/84', 'mmHg', '2026-05-20T08:30', '8:30 that morning', '2026-05-20T10:00:00Z', 'tst-bp');`,
  );
  await rufi.start({
    scenario: {
      calls: [
        {
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "result",
                action: "change",
                id: "res-bp",
                fields: {
                  measured: { date: "2026-05-20T09:45", words: "at 9:45" },
                },
              },
            ],
          },
        },
      ],
    },
  });
  await page.goto(rufi.link());
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await box(page).fill("It was taken at 9:45, not 8:30");
  await box(page).press("Enter");
  await expect(chat(page).locator(".receipt")).toContainText("Blood pressure");
  await page.keyboard.press("Escape");

  await sidebar(page)
    .getByRole("link", { name: /^Measurements/ })
    .click();
  // Its day on Measurements: 20 May 2026.
  const row = page
    .getByRole("region", { name: "20 May 2026 · 1 measurement" })
    .locator("#row-result-res-bp");
  // Its own time shows: its group says only the day.
  await expect(row).toContainText("09:45");
  await row.getByRole("button", { name: "Blood pressure" }).click();
  await expect(row).toContainText(
    "measured 20 May 2026 08:30 → 20 May 2026 09:45",
  );
});

test("Lab results lists each test once, by section, with its latest value as printed; an older report added later isn't the latest", async ({
  page,
  rufi,
}) => {
  // Twelve Ferritin reports in 2025, and one from 2023 saved last.
  const report = (
    id: string,
    collected: string,
    value: string,
    entered: string,
  ) =>
    `INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES ('rep-${id}', 'asha', 'doc-asha-aug', 'Lakeside Clinic', '${collected}');
     INSERT INTO results (id, person_id, report_id, category, test_name, value_text, value_number, unit, measured_at, entered_at, test_id, test_number) VALUES ('res-${id}', 'asha', 'rep-${id}', 'lab', 'Ferritin', '${value}', ${value}, 'µg/L', '${collected}', '${entered}', 'tst-ferritin', ${value});`;
  await rufi.family(
    "INSERT INTO tests (id, person_id, name, section, unit) VALUES ('tst-ferritin', 'asha', 'Ferritin', 'Iron', 'µg/L');",
    ...Array.from({ length: 12 }, (_, n) =>
      report(
        String(n + 1),
        `2025-${String(n + 1).padStart(2, "0")}-05`,
        String(30 + n),
        "2026-10-01T10:00:00Z",
      ),
    ),
    report("2023", "2023-01-05", "99", "2026-10-02T10:00:00Z"),
  );
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  // Sections by name, the tests with none last.
  await expect(page.getByRole("main").locator("section > h2")).toHaveText([
    "Inflammation",
    "Iron",
    "Sugar",
    "Thyroid",
    "Vitamins",
    "Other tests",
  ]);
  const row = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(row("HbA1c")).toContainText("6.8 %");
  await expect(row("HbA1c")).toContainText("4.0 - 5.6High");
  await expect(row("Glucose, fasting")).toContainText("118 mg/dL");
  await expect(row("Glucose, fasting")).toContainText("High · Fasting");
  // One row, with its latest by when the sample was taken.
  await expect(row("Ferritin")).toHaveCount(1);
  await expect(row("Ferritin")).toContainText("13 values");
  await expect(row("Ferritin")).toContainText("41 µg/L");
  await expect(row("Ferritin")).toContainText("5 Dec 2025");
  // The amended TSH, with its own date; a month typed in the chat stays a
  // month; a value with no date and no number is in its row too.
  await expect(row("TSH")).toContainText("4.6 mIU/L amended");
  await expect(row("TSH")).toContainText("12 Aug 2026");
  await expect(row("Vitamin D")).toContainText("May 2026");
  await expect(page.getByRole("region", { name: "Other tests" })).toContainText(
    "B positive",
  );
  await accessible(page);
});

test("a test's page lists every value newest first as printed, with its number in the test's unit where it differs; a value opens to its sources and history", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `INSERT INTO tests (id, person_id, name, section, unit) VALUES ('tst-ferritin', 'asha', 'Ferritin', 'Iron', 'µg/L');
     INSERT INTO results (id, person_id, category, test_name, value_text, value_number, unit, reference_range, flag_text, measured_at, entered_at, test_id, test_number) VALUES
       ('fer-0', 'asha', 'lab', 'Ferritin (CLIA)', '0.022', 0.022, 'mg/L', NULL, NULL, '2024-05-01', '2026-10-01T10:00:00Z', 'tst-ferritin', 22),
       ('fer-1', 'asha', 'lab', 'Ferritin', '31', 31, 'µg/L', '30 - 400', NULL, '2025-10-12', '2026-10-01T10:00:00Z', 'tst-ferritin', 31),
       ('fer-2', 'asha', 'lab', 'Ferritin', '18', 18, 'µg/L', '30 - 400', 'Low', '2026-03-04', '2026-10-01T10:00:00Z', 'tst-ferritin', 18),
       ('fer-3', 'asha', 'lab', 'Ferritin', '26', 26, 'µg/L', '30 - 400', 'Low', '2026-09-01', '2026-10-01T10:00:00Z', 'tst-ferritin', 26);`,
  );
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  // Its row's small trend: its latest values as printed.
  const ferritin = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Ferritin" }) });
  await expect(
    ferritin.getByRole("img", {
      name: "Ferritin over time: 31 on 12 Oct 2025, 18 on 4 Mar 2026, 26 on 1 Sep 2026. Lab range 30 - 400",
    }),
  ).toBeVisible();

  await ferritin.getByRole("link", { name: "Ferritin" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/tests\/tst-ferritin$/);
  await expect(page.getByRole("heading", { level: 2 })).toContainText(
    "Ferritin",
  );
  const values = page.getByRole("region", { name: "4 values" });
  await expect(values.getByRole("button", { name: /\d{4}$/ })).toHaveText([
    "1 Sep 2026",
    "4 Mar 2026",
    "12 Oct 2025",
    "1 May 2024",
  ]);
  const value = (date: string) =>
    values
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: date }) });
  await expect(value("4 Mar 2026")).toContainText("18 µg/LFerritin");
  await expect(value("4 Mar 2026")).toContainText("30 - 400Low");
  // Another lab's unit: as printed, with its number in the test's unit.
  await expect(value("1 May 2024")).toContainText(
    "0.022 mg/L= 22 µg/LFerritin (CLIA)Typed in the chat",
  );

  await values.getByRole("button", { name: "4 Mar 2026" }).click();
  await expect(value("4 Mar 2026")).toContainText("Sources");
  await expect(value("4 Mar 2026")).toContainText("History");
  await expect(value("4 Mar 2026")).toContainText("Measured 4 Mar 2026");
  await accessible(page);
});

test("Measurements shows them by the day taken, at its precision; an older results address opens a measurement on Measurements and a lab result on its test's page", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due, linked_kind, linked_id) VALUES ('f-weight', 'asha', 'Weigh again', '2026-12', 'result', 'res-a10');",
  );
  await rufi.start({ now: () => new Date(2026, 9, 11, 9).toISOString() });
  await page.goto(rufi.link());
  await sidebar(page)
    .getByRole("link", { name: /^Measurements/ })
    .click();
  await expect(
    page.getByRole("region", { name: "20 Sep 2026 · 2 measurements" }),
  ).toContainText("128/84 mmHg");
  // Known only by its month: never a made-up day.
  await expect(
    page.getByRole("region", { name: "Aug 2026 · 1 measurement" }),
  ).toContainText("62 kg");
  await expect(page.getByRole("button", { name: "HbA1c" })).toHaveCount(0);
  await accessible(page);

  // The address results had before: a measurement opens on Measurements.
  await page.goto(
    new URL("/people/asha/record/result?open=res-a10", page.url()).href,
  );
  await expect(page).toHaveURL(/\/record\/measurement\?open=res-a10$/);
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "61.5 kg" })
      .getByRole("button", { name: "Weight" }),
  ).toHaveAttribute("aria-expanded", "true");
  // With no row, it opens Lab results.
  await page.goto(new URL("/people/asha/record/result", page.url()).href);
  await expect(page).toHaveURL(/\/record\/lab_result$/);
  await expect(page.getByRole("link", { name: "HbA1c" })).toBeVisible();
  // A lab result opens on its test's page, open.
  await page.goto(
    new URL("/people/asha/record/result?open=res-a1", page.url()).href,
  );
  await expect(page).toHaveURL(/\/tests\/tst-hba1c\?open=res-a1$/);
  await expect(
    page.getByRole("button", { name: "12 Aug 2026" }),
  ).toHaveAttribute("aria-expanded", "true");

  // A follow-up about a measurement opens it on Measurements.
  await sidebar(page)
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  await page
    .getByRole("link", { name: "Weight 61.5 kg · 20 Sep 2026" })
    .click();
  await expect(page).toHaveURL(/\/record\/measurement\?open=res-a10$/);
});

test("a reading that ends, with nothing saved, shows in Needs you on an open Overview: results to save, or pages that couldn't be read", async ({
  page,
  rufi,
  context,
}) => {
  // Rufi AI has each file read, and sorts the report and the letter when
  // their readings wake it; the blurred photo has nothing to sort.
  const sort = (kind: string, drafts: unknown[]) => [
    {
      id: `sort-${kind}`,
      tool: "sort_documents",
      arguments: {
        document: "$document",
        documents: [{ id: "$document", pages: [1], kind }],
        drafts,
      },
    },
  ];
  await rufi.family();
  await rufi.start({
    scenario: {
      callsByText: {
        ...readThen(
          "Sort the lab report",
          [readOf(1)],
          sort("lab_report", [
            {
              page: 1,
              reading: "$reading",
              test_name: "Haemoglobin",
              value_text: "13.2",
              unit: "g/dL",
              quote: "Haemoglobin | 13.2 | g/dL",
            },
          ]),
        ),
        // A blurred photo: the reading completes, with its page unreadable.
        ...readThen(
          "Sort the letter",
          [
            {
              page: 1,
              outcome: "unreadable",
              why: "The print is blurred.",
              copy: "",
            },
          ],
          [],
          "Photo",
        ),
        // Read again: a letter, cleanly read, with nothing to save.
        ...readThen(
          "Read it again",
          [
            {
              page: 1,
              outcome: "read",
              copy: "Dear Asha,\n\nYour results were normal.",
            },
          ],
          sort("letter", []),
          "Letter",
        ),
      },
    },
  });
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou).toHaveCount(0);

  // Another window adds the documents; this one stays on Overview.
  const other = await context.newPage();
  await other.goto(rufi.link());
  await sidebar(other).getByRole("link", { name: "Documents" }).click();
  const replies = chat(other)
    .getByRole("log", { name: "Messages" })
    .locator(".reply");
  /** Sends a file with `words`; Rufi AI's two replies on it end. */
  const add = async (
    name: string,
    mimeType: string,
    file: string,
    words: string,
  ) => {
    const before = await replies.count();
    await sendFiles(
      other,
      {
        name,
        mimeType,
        buffer: await readFile(
          join(
            import.meta.dirname,
            "../../server/tests/fixtures/documents",
            file,
          ),
        ),
      },
      words,
    );
    await expect(replies).toHaveCount(before + 2, { timeout: FILE_WORK_MS });
  };
  await add(
    "lotus-labs.pdf",
    "application/pdf",
    "ravi-lipid-panel.pdf",
    "Sort the lab report",
  );
  await expect(needsYou).toContainText(
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  );
  await add(
    "clinic-letter.heic",
    "image/heic",
    "sideways.heic",
    "Sort the letter",
  );
  await expect(needsYou.getByRole("listitem")).toHaveText([
    /clinic-letter\.heic · couldn't be read · try a clearer scan/,
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  ]);
  await accessible(page);

  // Read again cleanly with nothing to save, it waits for nothing. The
  // chat steps back to its bar, off the row.
  await other
    .getByRole("region", { name: "Chat" })
    .getByRole("button", { name: "Minimise" })
    .click();
  await other
    .getByRole("row", { name: /clinic-letter\.heic/ })
    .getByRole("button", { name: "Retry" })
    .click();
  await box(other).fill("Read it again");
  await other
    .getByRole("region", { name: "Chat" })
    .getByRole("button", { name: "Send" })
    .click();
  await expect(needsYou.getByRole("listitem")).toHaveText([
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  ]);
});
