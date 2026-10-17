// The record's screens on the real core: Overview's tiles and a kind's page
// read again when a save lands, in every open window, whichever page it
// shows; Needs you when a reading ends, with no save. The strict CSP refuses nothing, and each screen passes axe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { expect, test } from "./rufi.ts";

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const sidebar = (page: Page) => page.getByRole("complementary");
const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const box = (page: Page) =>
  chat(page).getByRole("textbox", { name: "Message to Rufi" });

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
  await rufi.family();
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
  const crp = results.getByRole("button", { name: "CRP", exact: true });
  await expect(crp).toBeVisible();
  await expect(
    results.getByRole("region", {
      name: "Sunrise Labs · 12 Aug 2026 · 3 results",
    }),
  ).toBeVisible();
  await accessible(results);

  // The other on Overview: the save goes from its chat bar.
  await page.goto(rufi.link());
  const tile = page
    .getByRole("main")
    .getByRole("link", { name: /^Lab results 7/ });
  await expect(tile).toBeVisible();
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
  // The Lab results page in the other window read again by itself.
  await expect(crp).toHaveCount(0);
  await expect(
    results.getByRole("region", {
      name: "Sunrise Labs · 12 Aug 2026 · 2 results",
    }),
  ).toBeVisible();

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
  await expect(
    results.getByRole("listitem").filter({ hasText: / · (Removed|Put back)$/ }),
  ).toHaveText([/ · Removed$/, / · Put back$/]);
});

test("a row's history shows a correction before and after, a time with its time", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `INSERT INTO results (id, person_id, category, test_name, value_text, unit, measured_at, measured_words, entered_at)
       VALUES ('res-bp', 'asha', 'measurement', 'Blood pressure', '128/84', 'mmHg', '2026-05-20T08:30', '8:30 that morning', '2026-05-20T10:00:00Z');`,
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

test("the Lab results page shows lab results as the lab printed them, by report, and more as you scroll", async ({
  page,
  rufi,
}) => {
  // Twelve more reports, so the page has more than one read.
  const reports = Array.from({ length: 12 }, (_, n) => {
    const month = String(n + 1).padStart(2, "0");
    return `INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES ('rep-${month}', 'asha', 'doc-asha-aug', 'Lakeside Clinic', '2025-${month}-05');
      INSERT INTO results (id, person_id, report_id, category, test_name, value_text, measured_at, entered_at) VALUES ('res-${month}', 'asha', 'rep-${month}', 'lab', 'Ferritin', '${String(30 + n)}', '2025-${month}-05', '2026-10-01T10:00:00Z');`;
  });
  await rufi.family(...reports);
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  const row = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name }) });
  await expect(row("HbA1c")).toContainText("6.8 %4.0 - 5.6High");
  await expect(row("Glucose")).toContainText("118 mg/dL70 - 99High · Fasting");
  // The amended TSH is in the report that amended it, with its own date.
  await expect(
    page
      .getByRole("region", { name: "Sunrise Labs · 1 Sep 2026 · 2 results" })
      .getByRole("listitem")
      .filter({ hasText: "TSH" }),
  ).toContainText("TSH amended4.6 mIU/L0.4 - 4.0High12 Aug 2026");
  // A month typed in the chat stays a month; no date stays empty.
  await expect(
    page.getByRole("region", {
      name: "Typed in the chat · May 2026 · 1 result",
    }),
  ).toContainText("Vitamin D22 ng/mL");
  // The oldest reports come when the end of the page shows.
  const oldest = page.getByRole("region", {
    name: "Lakeside Clinic · 5 Jan 2025 · 1 result",
  });
  await expect(oldest).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show more" })
    .scrollIntoViewIfNeeded();
  await expect(oldest).toBeVisible();
  await expect(
    page.getByRole("region", { name: "No date · 1 result" }),
  ).toContainText("Blood groupB positive");
  await accessible(page);
});

test("Measurements shows them by the day taken, at its precision; an older results address and a follow-up's About open the page of the result's category", async ({
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
  await expect(page.getByRole("button", { name: "HbA1c" })).toBeVisible();

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
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage());
      return undefined;
    },
    // A blurred photo: the reading completes, with its page unreadable.
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "unreadable",
        why: "The print is blurred.",
        copy: "",
      });
      return undefined;
    },
    // Read again: a letter, cleanly read, with nothing to save.
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "read",
        copy: "Dear Asha,\n\nYour results were normal.",
      });
      return undefined;
    },
  ]);
  // Rufi AI sorts each reading that copied a page: the report, then the
  // letter.
  const sort = (kind: string, drafts: unknown[]) => [
    {
      id: `sort-${kind}`,
      tool: "sort_documents",
      arguments: {
        document: "$document",
        documents: [{ pages: [1], kind }],
        drafts,
      },
    },
  ];
  await rufi.family();
  await rufi.start({
    reader: reader.run,
    scenario: {
      callsByTurn: [
        sort("lab_report", [
          {
            page: 1,
            test_name: "Haemoglobin",
            value_text: "13.2",
            unit: "g/dL",
            quote: "Haemoglobin | 13.2 | g/dL",
          },
        ]),
        sort("letter", []),
      ],
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
  const add = async (name: string, mimeType: string, file: string) => {
    await other.getByLabel("Choose documents", { exact: true }).setInputFiles({
      name,
      mimeType,
      buffer: await readFile(
        join(
          import.meta.dirname,
          "../../server/tests/fixtures/documents",
          file,
        ),
      ),
    });
  };
  await add("lotus-labs.pdf", "application/pdf", "ravi-lipid-panel.pdf");
  await expect(needsYou).toContainText(
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  );
  await add("clinic-letter.heic", "image/heic", "sideways.heic");
  await expect(needsYou.getByRole("listitem")).toHaveText([
    /clinic-letter\.heic · couldn't be read · try a clearer scan/,
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  ]);
  await accessible(page);

  // Read again cleanly with nothing to save, it waits for nothing.
  await other
    .getByRole("row", { name: /clinic-letter\.heic/ })
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(needsYou.getByRole("listitem")).toHaveText([
    /lotus-labs\.pdf · \d+ results? read, not saved/,
  ]);
});
